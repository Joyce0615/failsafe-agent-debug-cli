/**
 * Orchestration-plan fault localization (item 27).
 *
 * Item 7's `fault-localization.ts` already ablates a single trace's events
 * and ranks which one, removed or replaced, conclusively flips a failing
 * replay to passing — the deterministic simulated-counterfactual half of
 * OrchBench's premise (arxiv.org/abs/2607.25656, cited in this project's own
 * "Third-cycle research incorporated" section). Item 69's
 * `trajectory-diff.ts` already aligns a failing run against several healthy
 * baselines and finds the earliest DISCRIMINATING difference — the recorded-
 * execution-comparison half. Neither names which of planner, worker, tool,
 * transport, or environment produced the event it flags, and nothing
 * combines the two lines of evidence. `grep -rn "orchestrat" src/
 * --include="*.ts"` before this module returned nothing.
 *
 * This module adds exactly the missing piece — a layer tag plus a combiner —
 * and reuses both evidence sources unmodified:
 *
 * - `OrchestrationEvent` is `fault-localization.ts`'s `TraceEvent` plus one
 *   new required field, `layer`, naming which of the five OrchBench-style
 *   layers produced the event. `localizeOrchestrationFault` strips `layer`
 *   before handing events to `localizeFault` (item 7, unmodified) — the
 *   ablation search itself knows nothing about layers, it only sees events —
 *   and reads the layer back off the top-ranked event afterward.
 * - The same events, reprojected as `TrajectoryStep`s (via `action`/`outcome`/
 *   `error_class`, the fields the two shapes already share), are handed to
 *   `diffAgainstBaselines` (item 69, unmodified) against caller-supplied
 *   healthy trajectories, when any are supplied.
 * - A fault is classified `planner_defect` only when the counterfactual
 *   search's own top-ranked event is layer `planner`; every other
 *   conclusively-ranked layer is a `downstream_failure` (worker, tool,
 *   transport, or environment) — separating "the plan itself was wrong" from
 *   "the plan was fine but something executing it broke", which is the
 *   literal distinction this item asks for.
 * - When BOTH lines of evidence produce a layer and they AGREE, `agreement:
 *   true` is reported and the verdict stands as the shared layer's
 *   classification — two independent methods naming the same layer is why
 *   `agreement` is surfaced as its own field rather than silently raising a
 *   confidence number nothing else in this report has. When they DISAGREE,
 *   the verdict is forced to `indeterminate` rather than one of the two
 *   being asserted over the other, with a caveat naming the exact
 *   disagreement.
 * - When no ablation conclusively flips the outcome, the verdict is
 *   `indeterminate` with a caveat — never guessed from the single available
 *   signal.
 *
 * Pure: `ReplayRunner` is the same injected seam `fault-localization.ts`
 * already defines, so this module spawns no process either.
 */
import {
	type Ablation,
	type FaultLocalizationReport,
	type ReplayRunner,
	type TraceEvent,
	localizeFault,
	removalAblations,
} from "./fault-localization.js";
import {
	type Trajectory,
	type TrajectoryDiffReport,
	type TrajectoryStep,
	diffAgainstBaselines,
} from "./trajectory-diff.js";

/** The five layers OrchBench separates planner defects from. */
export const ORCHESTRATION_LAYERS = [
	"planner",
	"worker",
	"tool",
	"transport",
	"environment",
] as const;
export type OrchestrationLayer = (typeof ORCHESTRATION_LAYERS)[number];

/** One event in the failing run's trace, tagged with the layer that produced it. */
export type OrchestrationEvent = TraceEvent & {
	layer: OrchestrationLayer;
	/** Tool/operation name, reprojected into a `TrajectoryStep.action` for the diff half. */
	action: string;
	outcome: "ok" | "error";
	error_class?: string;
};

export type OrchestrationVerdict = "planner_defect" | "downstream_failure" | "indeterminate";

export type OrchestrationFaultReport = {
	/** The item-7 ablation sweep, unmodified. */
	fault_localization: FaultLocalizationReport;
	/** Layer of the counterfactual search's top-ranked (highest-effect, then earliest) event. `null` when nothing conclusively flipped. */
	counterfactual_layer: OrchestrationLayer | null;
	/** The item-69 baseline diff, when healthy trajectories were supplied; otherwise `null`. */
	trajectory_diff: TrajectoryDiffReport | null;
	/** Layer of the trajectory diff's earliest discriminating difference, when one exists. */
	trajectory_diff_layer: OrchestrationLayer | null;
	/** True iff both evidence sources produced a layer and they are the same layer. */
	agreement: boolean;
	verdict: OrchestrationVerdict;
	caveats: string[];
};

/** Layer lookup by event id, for reading a layer back off a ranked/diffed id. */
function layerById(events: OrchestrationEvent[]): Map<string, OrchestrationLayer> {
	return new Map(events.map((e) => [e.id, e.layer]));
}

function classify(layer: OrchestrationLayer | null): OrchestrationVerdict {
	if (layer === null) return "indeterminate";
	return layer === "planner" ? "planner_defect" : "downstream_failure";
}

/**
 * Localize an orchestration-run fault to planner/worker/tool/transport/
 * environment, combining a deterministic simulated-counterfactual ablation
 * sweep (item 7) with an optional recorded-execution comparison against
 * healthy baselines (item 69).
 *
 * `healthy` may be empty: the counterfactual sweep alone is a complete,
 * meaningful localization (OrchBench's premise), and `trajectory_diff`/
 * `trajectory_diff_layer` are simply `null` with no caveat invented for an
 * input the caller legitimately did not supply.
 */
export async function localizeOrchestrationFault(
	events: OrchestrationEvent[],
	runner: ReplayRunner,
	healthy: Trajectory[],
	ablations?: Ablation[],
): Promise<OrchestrationFaultReport> {
	const layers = layerById(events);
	const traceEvents: TraceEvent[] = events.map(
		({ layer: _layer, action: _action, outcome: _outcome, error_class: _errorClass, ...e }) => e,
	);

	const faultLocalization = await localizeFault(
		traceEvents,
		ablations ?? removalAblations(traceEvents),
		runner,
	);

	// Top-ranked: highest effect, then (per item 7) earliest trace order —
	// localizeFault's own ranking already encodes both, so the first entry is
	// the one to read a layer off.
	const counterfactualLayer = faultLocalization.ranking[0]
		? (layers.get(faultLocalization.ranking[0].eventId) ?? null)
		: null;

	let trajectoryDiff: TrajectoryDiffReport | null = null;
	let trajectoryDiffLayer: OrchestrationLayer | null = null;
	const caveats: string[] = [];

	if (healthy.length > 0) {
		const failingSteps: TrajectoryStep[] = events.map((e) => ({
			id: e.id,
			action: e.action,
			outcome: e.outcome,
			...(e.error_class ? { error_class: e.error_class } : {}),
		}));
		trajectoryDiff = diffAgainstBaselines({ id: "failing", steps: failingSteps }, healthy);
		caveats.push(...trajectoryDiff.caveats);
		const divergence = trajectoryDiff.divergence_point;
		const anchorId =
			divergence?.failing_step?.id ??
			(divergence?.at_failing_index !== null && divergence?.at_failing_index !== undefined
				? events[divergence.at_failing_index]?.id
				: undefined);
		trajectoryDiffLayer = anchorId ? (layers.get(anchorId) ?? null) : null;
	}

	let agreement = false;
	let verdict: OrchestrationVerdict;

	if (counterfactualLayer !== null && trajectoryDiffLayer !== null) {
		agreement = counterfactualLayer === trajectoryDiffLayer;
		if (agreement) {
			verdict = classify(counterfactualLayer);
		} else {
			verdict = "indeterminate";
			caveats.push(
				`the counterfactual ablation sweep and the trajectory-baseline diff disagree on the responsible layer ('${counterfactualLayer}' vs '${trajectoryDiffLayer}'); neither is asserted over the other`,
			);
		}
	} else if (counterfactualLayer !== null) {
		verdict = classify(counterfactualLayer);
	} else if (trajectoryDiffLayer !== null) {
		verdict = classify(trajectoryDiffLayer);
	} else {
		verdict = "indeterminate";
		caveats.push(
			"no ablation conclusively flipped the outcome and no discriminating trajectory difference was found: the responsible layer cannot be localized from the available evidence",
		);
	}

	return {
		fault_localization: faultLocalization,
		counterfactual_layer: counterfactualLayer,
		trajectory_diff: trajectoryDiff,
		trajectory_diff_layer: trajectoryDiffLayer,
		agreement,
		verdict,
		caveats,
	};
}

/** Render a compact, agent-readable summary. */
export function renderOrchestrationFaultReport(report: OrchestrationFaultReport): string {
	const lines = [`verdict: ${report.verdict}`];
	lines.push(`counterfactual layer: ${report.counterfactual_layer ?? "none"}`);
	if (report.trajectory_diff) {
		lines.push(`trajectory-diff layer: ${report.trajectory_diff_layer ?? "none"}`);
		lines.push(`agreement: ${report.agreement}`);
	}
	for (const caveat of report.caveats) lines.push(`note: ${caveat}`);
	return lines.join("\n");
}
