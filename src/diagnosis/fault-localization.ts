/**
 * Counterfactual fault localization by trace ablation (item 7).
 *
 * `causal-construction.ts` (item 59) builds a causal graph from already-known
 * edges; `counterfactual.ts` (item 55) validates that a *proposed repair* is
 * causally responsible for turning a known failure into a pass. Neither
 * answers the question this item asks: given one failing run's recorded
 * event/tool-call trace and nothing else, *which recorded event actually
 * caused the failure* — found by replaying the trace with each event in turn
 * removed or replaced, and ranking events by how much doing so changes the
 * outcome.
 *
 * This is delta-debugging (Zeller, "Simplifying and Isolating Failure-
 * Inducing Input") applied to an agent trace instead of a text input: an
 * ablation is "interesting" only when it demonstrably flips the run from
 * `failed` to `passed`. The classical algorithm's hard-won lesson, and the one
 * a naive implementation gets wrong, is that **ablating an input can also make
 * the test *unresolvable*** — here, replaying with an event removed or
 * replaced can make the harness itself error out (a malformed replacement, a
 * removed authentication call the harness can't recover from, a tool call
 * whose result downstream code dereferences unconditionally) rather than
 * cleanly reach a `passed` or `failed` verdict. An `error` outcome is evidence
 * about the *harness's* tolerance for that ablation, not evidence that the
 * event was the cause of the original failure — exactly the distinction
 * `counterfactual.ts`'s `stability: "errored"` already draws for its own
 * control matrix. Conflating `error` with `passed` (e.g. scoring causal effect
 * as `outcome !== "failed"`) ranks a harness crash as the top suspect purely
 * because it crashed, which is almost always a different event than the one
 * actually responsible for the failure.
 *
 * Pure: execution happens behind the injected {@link ReplayRunner} seam, so
 * this module contains no process spawning, and the tests contain no
 * subprocesses.
 */

export type ReplayOutcome = "failed" | "passed" | "error";

export type AblationMode = "removed" | "replaced";

/** One recorded event/tool-call/tool-result in the failing trace. */
export type TraceEvent = {
	id: string;
	/** e.g. "tool_call" | "tool_result" | "agent_message" | "observation". */
	kind: string;
	payload?: unknown;
};

/**
 * One ablation of the trace: drop event `eventId` outright, or replace its
 * payload with a neutral stand-in.
 */
export type Ablation = {
	eventId: string;
	mode: AblationMode;
	/** Required for `mode: "replaced"`; ignored for `"removed"`. */
	replacement?: unknown;
};

/**
 * Executes one replay of a (possibly ablated) trace and reports whether it
 * reproduced the original failure, passed cleanly, or could not be run to a
 * conclusive verdict at all. Injected so this module stays pure.
 */
export type ReplayRunner = (events: TraceEvent[]) => Promise<ReplayOutcome> | ReplayOutcome;

export type AblationResult = {
	eventId: string;
	mode: AblationMode;
	outcome: ReplayOutcome;
	/**
	 * True only when the ablation produced a *conclusive* non-failure
	 * (`outcome === "passed"`). An `error` outcome is never `flipped`: the
	 * harness failing to run is not evidence the ablated event caused the
	 * original failure, it is evidence the harness could not tolerate the
	 * ablation.
	 */
	flipped: boolean;
	/** True when the outcome was `error` — inconclusive, excluded from ranking. */
	inconclusive: boolean;
};

export type RankedEvent = {
	eventId: string;
	mode: AblationMode;
	/** 1 when the ablation flipped the outcome, 0 otherwise. (Binary today; see residual risk notes for repeats.) */
	effect: number;
};

export type FaultLocalizationReport = {
	/** The outcome of replaying the full, unablated trace. Must be `failed` for a localization run to mean anything. */
	baselineOutcome: ReplayOutcome;
	/** Every ablation attempted, including inconclusive ones. */
	results: AblationResult[];
	/**
	 * Ablations that flipped the outcome, ranked highest-effect first;
	 * inconclusive (`error`) ablations are never ranked. Ties break on the
	 * trace's original event order, so the ranking is deterministic.
	 */
	ranking: RankedEvent[];
	/** Ablations whose outcome was `error` — the harness could not reach a verdict with this ablation applied. */
	inconclusive: AblationResult[];
};

/** Apply one ablation to a trace, returning a new event list (never mutates the input). */
export function applyAblation(events: TraceEvent[], ablation: Ablation): TraceEvent[] {
	if (ablation.mode === "removed") {
		return events.filter((e) => e.id !== ablation.eventId);
	}
	return events.map((e) =>
		e.id === ablation.eventId ? { ...e, payload: ablation.replacement } : e,
	);
}

/** Every "remove this event" ablation for a trace, in the trace's own order. */
export function removalAblations(events: TraceEvent[]): Ablation[] {
	return events.map((e) => ({ eventId: e.id, mode: "removed" as const }));
}

/**
 * Run the full counterfactual fault-localization sweep: replay the baseline
 * trace, then replay once per ablation, classify each result, and rank the
 * events whose ablation conclusively flipped the outcome.
 *
 * Ablations are run in the order given (default: one removal per event, in
 * trace order) so the ranking's tie-break on original order is reproducible
 * regardless of ablation count.
 */
export async function localizeFault(
	events: TraceEvent[],
	ablations: Ablation[],
	runner: ReplayRunner,
): Promise<FaultLocalizationReport> {
	const baselineOutcome = await runner(events);

	const results: AblationResult[] = [];
	for (const ablation of ablations) {
		const ablated = applyAblation(events, ablation);
		const outcome = await runner(ablated);
		results.push(classifyAblation(ablation, outcome));
	}

	const inconclusive = results.filter((r) => r.inconclusive);
	const order = new Map(events.map((e, i) => [e.id, i]));
	const ranking: RankedEvent[] = results
		.filter((r) => r.flipped)
		.map((r) => ({ eventId: r.eventId, mode: r.mode, effect: 1 }))
		.sort((a, b) => (order.get(a.eventId) ?? 0) - (order.get(b.eventId) ?? 0));

	return { baselineOutcome, results, ranking, inconclusive };
}

/**
 * Classify one ablation's replay outcome.
 *
 * `error` is deliberately never `flipped`, however tempting `outcome !==
 * "failed"` looks: a replay that could not reach a verdict says nothing about
 * whether the ablated event caused the original failure.
 */
function classifyAblation(ablation: Ablation, outcome: ReplayOutcome): AblationResult {
	return {
		eventId: ablation.eventId,
		mode: ablation.mode,
		outcome,
		flipped: outcome === "passed",
		inconclusive: outcome === "error",
	};
}

/**
 * Render a compact, agent-readable summary. Reports the inconclusive ablations
 * explicitly, because "we could not tell" is the fact a reader is most likely
 * to need and the easiest to omit.
 */
export function renderFaultLocalizationReport(report: FaultLocalizationReport): string {
	const lines = [`baseline: ${report.baselineOutcome}`];
	if (report.ranking.length === 0) {
		lines.push("ranking: no ablation flipped the outcome");
	} else {
		lines.push("ranking (highest effect first):");
		for (const r of report.ranking) {
			lines.push(`  ${r.eventId} (${r.mode}): effect ${r.effect}`);
		}
	}
	if (report.inconclusive.length > 0) {
		lines.push(
			`inconclusive (${report.inconclusive.length}): ${report.inconclusive
				.map((r) => `${r.eventId} (${r.mode})`)
				.join(", ")} — the harness could not reach a verdict with these ablations applied`,
		);
	}
	return lines.join("\n");
}
