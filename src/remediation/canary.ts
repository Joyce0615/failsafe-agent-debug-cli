/**
 * Remediation canary and rollback verification (item 29).
 *
 * `counterfactual.ts` (item 55) proves a fix causal by a four-arm control
 * matrix against a MINIMAL REPRO. That answers "did the patch change this one
 * failure" — not "is it safe to run this fix for real traffic/replay volume",
 * which needs a baseline/canary A/B comparison over BOTH failure rate and
 * side-effect metrics (latency, resource usage, anything else a caller tracks
 * per run), and a promote/hold/rollback verdict that does not quietly start
 * influencing what runs next. `grep -rn "canary" src/ --include="*.ts"`
 * before this module returned nothing; `modes.ts` (item 76) only
 * RECOMMENDS a mitigation mode and never executes or measures one; the item
 * 97 ranking-policy module activates through item 77's approval gate but has
 * nothing to do with trialing a fix.
 *
 * Three disciplines, each already established precedent elsewhere in this
 * codebase and reused rather than reinvented here:
 *
 * 1. **Repeats are mandatory, same as `counterfactual.ts`'s `MIN_REPEATS`.**
 *    A canary trial below `MIN_CANARY_REPEATS` runs per arm cannot
 *    distinguish "the fix is worse" from "this run happened to be worse", so
 *    it returns `hold`, never a guessed verdict.
 * 2. **A harness error anywhere holds, never guesses.** Mirrors
 *    `counterfactual.ts`'s `stability: "errored"` treatment: an arm that
 *    failed to execute at all (not failed TO DO WHAT IT SHOULD — failed to
 *    run) cannot be compared, so its presence forces `hold` regardless of
 *    what the other runs show.
 * 3. **Promotion is a consequential remediation action, not a side effect of
 *    a report.** `requestCanaryPromotion` builds an ordinary
 *    `RemediationAction` and runs it through `checkApproval` (item 77,
 *    unmodified) exactly like item 97's `activatePolicy` does for a ranking
 *    policy — a `promote` verdict earns the RIGHT to request approval, it
 *    does not substitute for one. A `hold` or `rollback` verdict is refused
 *    before the approval gate is even consulted: there is nothing to approve.
 *
 * Side-effect metrics are compared per-metric against a caller-declared
 * `MetricTolerance` (direction + max fractional regression) rather than one
 * composite score, the same "no overall goodness number" discipline
 * `modes.ts` already states explicitly for ranking remediation modes — a
 * caller who cares about latency and memory separately should not have one
 * regression hidden by the other's improvement.
 *
 * Pure apart from `requestCanaryPromotion`'s call into `checkApproval`, which
 * (transitively) reads the signing key from the environment — the same
 * purity boundary item 77/97 already draw.
 */
import type { ApprovalGrant, GateDecision, RemediationAction } from "./approval.js";
import { checkApproval } from "./approval.js";

export const CANARY_ARMS = ["baseline", "canary"] as const;
export type CanaryArm = (typeof CANARY_ARMS)[number];

export type CanaryOutcome = "pass" | "fail" | "error";

export type CanaryRun = {
	outcome: CanaryOutcome;
	/** Arbitrary named side-effect metrics for this run, e.g. latency_ms. */
	metrics?: Record<string, number>;
};

/** Executes one repetition of one arm. Injected so this module stays pure. */
export type CanaryRunner = (arm: CanaryArm, attempt: number) => Promise<CanaryRun> | CanaryRun;

/** Below this, a difference in pass rate cannot be told apart from noise. */
export const MIN_CANARY_REPEATS = 3;

export type MetricDirection = "lower_is_better" | "higher_is_better";

export type MetricTolerance = {
	name: string;
	direction: MetricDirection;
	/** Maximum allowed fractional regression vs. baseline's mean, e.g. 0.1 = 10%. */
	max_regression: number;
};

export type MetricComparison = {
	name: string;
	baseline_mean: number;
	canary_mean: number;
	/** Fractional change in the unfavorable direction; negative is an improvement. */
	regression: number;
	within_tolerance: boolean;
};

export type CanaryVerdict = "promote" | "hold" | "rollback";

export type CanaryReport = {
	baseline_runs: CanaryRun[];
	canary_runs: CanaryRun[];
	baseline_pass_rate: number;
	canary_pass_rate: number;
	metric_comparisons: MetricComparison[];
	verdict: CanaryVerdict;
	reasons: string[];
};

function mean(values: number[]): number {
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function passRate(runs: CanaryRun[]): number {
	const nonErrored = runs.filter((r) => r.outcome !== "error");
	if (nonErrored.length === 0) return 0;
	return nonErrored.filter((r) => r.outcome === "pass").length / nonErrored.length;
}

/** Compare one metric's baseline vs. canary mean against its declared tolerance. */
function compareMetric(
	tolerance: MetricTolerance,
	baselineRuns: CanaryRun[],
	canaryRuns: CanaryRun[],
): MetricComparison | null {
	const baselineValues = baselineRuns
		.map((r) => r.metrics?.[tolerance.name])
		.filter((v): v is number => v !== undefined);
	const canaryValues = canaryRuns
		.map((r) => r.metrics?.[tolerance.name])
		.filter((v): v is number => v !== undefined);
	if (baselineValues.length === 0 || canaryValues.length === 0) return null;

	const baselineMean = mean(baselineValues);
	const canaryMean = mean(canaryValues);
	// Positive regression always means "worse", regardless of direction.
	const rawDelta =
		tolerance.direction === "lower_is_better"
			? canaryMean - baselineMean
			: baselineMean - canaryMean;
	const regression =
		baselineMean === 0
			? rawDelta === 0
				? 0
				: Number.POSITIVE_INFINITY
			: rawDelta / Math.abs(baselineMean);

	return {
		name: tolerance.name,
		baseline_mean: baselineMean,
		canary_mean: canaryMean,
		regression,
		within_tolerance: regression <= tolerance.max_regression,
	};
}

/**
 * Trial a fix: run `repeats` repetitions of both `baseline` (current
 * behavior) and `canary` (with the fix) arms, compare failure rate and every
 * declared side-effect metric, and emit a promote/hold/rollback verdict.
 */
export async function runCanaryTrial(
	runner: CanaryRunner,
	tolerances: MetricTolerance[],
	repeats: number = MIN_CANARY_REPEATS,
): Promise<CanaryReport> {
	const reasons: string[] = [];

	if (repeats < MIN_CANARY_REPEATS) {
		reasons.push(
			`only ${repeats} repeat(s) requested; at least ${MIN_CANARY_REPEATS} are needed to tell a real regression apart from run-to-run noise`,
		);
		return {
			baseline_runs: [],
			canary_runs: [],
			baseline_pass_rate: 0,
			canary_pass_rate: 0,
			metric_comparisons: [],
			verdict: "hold",
			reasons,
		};
	}

	const baselineRuns: CanaryRun[] = [];
	const canaryRuns: CanaryRun[] = [];
	for (let attempt = 1; attempt <= repeats; attempt++) {
		baselineRuns.push(await runner("baseline", attempt));
		canaryRuns.push(await runner("canary", attempt));
	}

	const baselineErrors = baselineRuns.filter((r) => r.outcome === "error").length;
	const canaryErrors = canaryRuns.filter((r) => r.outcome === "error").length;
	if (baselineErrors > 0 || canaryErrors > 0) {
		reasons.push(
			`${baselineErrors + canaryErrors} run(s) errored (harness failure, not a fix verdict); a canary cannot be compared against an arm that never ran`,
		);
		return {
			baseline_runs: baselineRuns,
			canary_runs: canaryRuns,
			baseline_pass_rate: passRate(baselineRuns),
			canary_pass_rate: passRate(canaryRuns),
			metric_comparisons: [],
			verdict: "hold",
			reasons,
		};
	}

	const baselinePassRate = passRate(baselineRuns);
	const canaryPassRate = passRate(canaryRuns);
	const metricComparisons = tolerances
		.map((t) => compareMetric(t, baselineRuns, canaryRuns))
		.filter((c): c is MetricComparison => c !== null);

	let verdict: CanaryVerdict = "promote";
	if (canaryPassRate < baselinePassRate) {
		verdict = "rollback";
		reasons.push(
			`canary pass rate ${canaryPassRate.toFixed(2)} is worse than baseline pass rate ${baselinePassRate.toFixed(2)}`,
		);
	}
	for (const comparison of metricComparisons) {
		if (!comparison.within_tolerance) {
			verdict = "rollback";
			reasons.push(
				`metric '${comparison.name}' regressed ${(comparison.regression * 100).toFixed(1)}%, exceeding its declared tolerance`,
			);
		}
	}
	if (verdict === "promote") {
		reasons.push(
			`canary pass rate ${canaryPassRate.toFixed(2)} matched or beat baseline ${baselinePassRate.toFixed(2)}, and every declared metric stayed within tolerance`,
		);
	}

	return {
		baseline_runs: baselineRuns,
		canary_runs: canaryRuns,
		baseline_pass_rate: baselinePassRate,
		canary_pass_rate: canaryPassRate,
		metric_comparisons: metricComparisons,
		verdict,
		reasons,
	};
}

export type CanaryPromotionResult =
	| { ok: true; decision: GateDecision }
	| { ok: false; reason: string; decision?: GateDecision };

/**
 * Request promotion of a trialed fix. Refused outright, without even
 * consulting the approval gate, unless `report.verdict === "promote"` — a
 * `hold`/`rollback` verdict names a problem the approval gate was never
 * meant to adjudicate. A `promote` verdict still has to clear item 77's
 * approval gate (unmodified) before the caller may treat it as authorized.
 */
export function requestCanaryPromotion(
	report: CanaryReport,
	action: RemediationAction,
	grant: ApprovalGrant | undefined,
	opts: { now_ms?: number; key?: string } = {},
): CanaryPromotionResult {
	if (report.verdict !== "promote") {
		return {
			ok: false,
			reason: `canary verdict is '${report.verdict}', not 'promote'; promotion was never attempted`,
		};
	}
	const decision = checkApproval(action, grant, opts);
	if (!decision.allowed) {
		return { ok: false, reason: decision.reason, decision };
	}
	return { ok: true, decision };
}
