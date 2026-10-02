/**
 * Latency, memory, query-cost, and diagnosis-quality regression gates
 * (item 93).
 *
 * Performance gates get disabled, and they get disabled for one reason: they
 * fire on noise. A gate comparing one run's latency to one baseline run's
 * latency will fail a few times a week on an unchanged codebase, somebody will
 * add `continue-on-error: true`, and after that it is decoration. Every design
 * decision here follows from wanting a gate that survives contact with a real
 * CI system.
 *
 * 1. **A single run is not a measurement.** Both sides need several samples,
 *    and the threshold is expressed in units of the *baseline's own
 *    variability* rather than in absolute percent. A 5% regression on a metric
 *    that varies by 20% run to run is not detectable, and a gate configured to
 *    catch it is configured to fire at random.
 *
 * 2. **The gate says why it did not fire.** `within_noise` is a distinct result
 *    from `no_change`: the first means the change may be real and this sample
 *    size cannot tell, and it comes with the sample count that would.
 *
 * 3. **Missing a baseline is not passing.** "No baseline, therefore no
 *    regression" is how a broken comparison pipeline stays green indefinitely.
 *    `no_baseline` is neither pass nor fail and must be handled by the caller.
 *
 * 4. **Quality is not latency.** Regressing diagnosis accuracy by two points is
 *    a different kind of event from regressing latency by two percent, and the
 *    gates carry their own direction and severity rather than sharing a
 *    threshold.
 *
 * Pure: statistics over supplied samples.
 */

export const GATE_METRICS = [
	"latency_ms",
	"peak_memory_bytes",
	"query_cost",
	"diagnosis_accuracy",
	"diagnosis_calibration_error",
] as const;
export type GateMetric = (typeof GATE_METRICS)[number];

/** Which direction counts as worse for each metric. */
export const WORSE_DIRECTION: Record<GateMetric, "higher" | "lower"> = {
	latency_ms: "higher",
	peak_memory_bytes: "higher",
	query_cost: "higher",
	// Accuracy going down is the regression; every other metric is the reverse,
	// and a gate that shares one direction across all of them is wrong for this
	// one in a way that silently never fires.
	diagnosis_accuracy: "lower",
	diagnosis_calibration_error: "higher",
};

export type GateSeverity = "blocking" | "warning";

export type GateConfig = {
	metric: GateMetric;
	/** Change must exceed this many baseline standard deviations to count. */
	sigma_threshold: number;
	/** And must also exceed this relative change, so trivial-but-stable moves do not fire. */
	min_relative_change: number;
	/** Samples required on each side before the gate will judge anything. */
	min_samples: number;
	severity: GateSeverity;
};

/**
 * Defaults chosen so a gate is worth leaving switched on.
 *
 * Quality gates are stricter on both axes and blocking; performance gates need
 * a larger effect before they fire, because a 3% latency move is not worth
 * failing a build over and a 3-point accuracy drop is.
 */
export const DEFAULT_GATES: Record<GateMetric, GateConfig> = {
	latency_ms: {
		metric: "latency_ms",
		sigma_threshold: 3,
		min_relative_change: 0.1,
		min_samples: 5,
		severity: "warning",
	},
	peak_memory_bytes: {
		metric: "peak_memory_bytes",
		sigma_threshold: 3,
		min_relative_change: 0.15,
		min_samples: 5,
		severity: "warning",
	},
	query_cost: {
		metric: "query_cost",
		sigma_threshold: 2,
		min_relative_change: 0.1,
		min_samples: 5,
		severity: "warning",
	},
	diagnosis_accuracy: {
		metric: "diagnosis_accuracy",
		sigma_threshold: 2,
		min_relative_change: 0.02,
		min_samples: 20,
		severity: "blocking",
	},
	diagnosis_calibration_error: {
		metric: "diagnosis_calibration_error",
		sigma_threshold: 2,
		min_relative_change: 0.05,
		min_samples: 20,
		severity: "blocking",
	},
};

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export const GATE_RESULTS = [
	"pass",
	"regression",
	"improvement",
	"within_noise",
	"insufficient_samples",
	"no_baseline",
] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

export type GateEvaluation = {
	metric: GateMetric;
	result: GateResult;
	severity: GateSeverity;
	baseline_median: number;
	candidate_median: number;
	baseline_stddev: number;
	/** Signed change in the metric's own units. */
	absolute_change: number;
	relative_change: number;
	/** Change in baseline standard deviations. `null` when the baseline is flat. */
	sigma_change: number | null;
	baseline_samples: number;
	candidate_samples: number;
	/** Samples that would be needed to resolve a `within_noise` verdict. */
	samples_needed?: number;
	detail: string;
	/** Whether this evaluation should fail a build. */
	blocking: boolean;
};

/**
 * Evaluate one metric.
 *
 * Requires *both* a change beyond the noise floor and a relative change beyond
 * the configured minimum. Either alone produces a bad gate: sigma alone fires
 * on a metric so stable that a 1% move is significant and irrelevant, and
 * relative alone fires on a metric so noisy that 10% is normal.
 */
export function evaluateGate(
	metric: GateMetric,
	baseline: number[],
	candidate: number[],
	config: GateConfig = DEFAULT_GATES[metric],
): GateEvaluation {
	const worseWhenHigher = WORSE_DIRECTION[metric] === "higher";
	const baseMedian = median(baseline);
	const candMedian = median(candidate);
	const sd = stddev(baseline);
	const absolute = candMedian - baseMedian;
	const relative = baseMedian !== 0 ? absolute / Math.abs(baseMedian) : absolute === 0 ? 0 : 1;
	const sigma = sd > 0 ? absolute / sd : null;

	const base = {
		metric,
		severity: config.severity,
		baseline_median: baseMedian,
		candidate_median: candMedian,
		baseline_stddev: sd,
		absolute_change: absolute,
		relative_change: relative,
		sigma_change: sigma,
		baseline_samples: baseline.length,
		candidate_samples: candidate.length,
	};

	if (baseline.length === 0) {
		return {
			...base,
			result: "no_baseline",
			blocking: false,
			detail:
				"no baseline samples: this is neither a pass nor a failure, and treating it as a pass is how a broken comparison pipeline stays green indefinitely",
		};
	}
	if (baseline.length < config.min_samples || candidate.length < config.min_samples) {
		return {
			...base,
			result: "insufficient_samples",
			blocking: false,
			samples_needed: config.min_samples,
			detail: `${baseline.length} baseline and ${candidate.length} candidate sample(s); ${config.min_samples} of each are required before a single run can be distinguished from variation`,
		};
	}

	const worsened = worseWhenHigher ? absolute > 0 : absolute < 0;
	const relativeClears = Math.abs(relative) >= config.min_relative_change;
	const sigmaClears = sigma === null ? relativeClears : Math.abs(sigma) >= config.sigma_threshold;

	if (!relativeClears && !sigmaClears) {
		return {
			...base,
			result: "pass",
			blocking: false,
			detail: `median moved by ${(relative * 100).toFixed(1)}%, within both the ${(config.min_relative_change * 100).toFixed(0)}% and ${config.sigma_threshold}σ thresholds`,
		};
	}
	if (!sigmaClears) {
		// The relative move is large enough to matter and the baseline is too
		// noisy to confirm it. Saying "pass" here would hide a real regression.
		const needed =
			sigma === null
				? config.min_samples * 2
				: Math.ceil(
						config.min_samples * (config.sigma_threshold / Math.max(Math.abs(sigma), 1e-9)) ** 2,
					);
		return {
			...base,
			result: "within_noise",
			blocking: false,
			samples_needed: Math.min(needed, 10_000),
			detail: `median moved by ${(relative * 100).toFixed(1)}% but only ${sigma?.toFixed(2) ?? "0"}σ against a baseline that varies by ${sd.toFixed(2)}; this sample size cannot tell a real change from noise, and roughly ${Math.min(needed, 10_000)} samples per side would`,
		};
	}
	if (!relativeClears) {
		return {
			...base,
			result: "pass",
			blocking: false,
			detail: `median moved ${sigma?.toFixed(2)}σ but only ${(relative * 100).toFixed(1)}%, below the ${(config.min_relative_change * 100).toFixed(0)}% that would matter`,
		};
	}

	if (!worsened) {
		return {
			...base,
			result: "improvement",
			blocking: false,
			detail: `${(Math.abs(relative) * 100).toFixed(1)}% better (${Math.abs(sigma ?? 0).toFixed(2)}σ)`,
		};
	}

	return {
		...base,
		result: "regression",
		blocking: config.severity === "blocking",
		detail: `${(Math.abs(relative) * 100).toFixed(1)}% worse at ${Math.abs(sigma ?? 0).toFixed(2)}σ, clearing both the ${(config.min_relative_change * 100).toFixed(0)}% and ${config.sigma_threshold}σ thresholds`,
	};
}

export type RunSamples = Partial<Record<GateMetric, number[]>>;

export type GateReport = {
	evaluations: GateEvaluation[];
	/** Regressions that should fail the build. */
	blocking_regressions: GateMetric[];
	/** Regressions that should not. */
	warning_regressions: GateMetric[];
	improvements: GateMetric[];
	/** Metrics the gate could not judge, which is not the same as passing. */
	unjudged: Array<{ metric: GateMetric; result: GateResult; reason: string }>;
	/** True only when every judged metric passed and nothing was unjudged. */
	clean: boolean;
	caveats: string[];
};

/**
 * Run every configured gate.
 *
 * `clean` requires that nothing was left unjudged. A run where three gates
 * passed and two had no baseline is not a clean run, and reporting it as one is
 * exactly the failure this module is trying to avoid.
 */
export function runGates(
	baseline: RunSamples,
	candidate: RunSamples,
	configs: Partial<Record<GateMetric, GateConfig>> = {},
): GateReport {
	const metrics = GATE_METRICS.filter(
		(metric) => baseline[metric] !== undefined || candidate[metric] !== undefined,
	);

	const evaluations = metrics.map((metric) =>
		evaluateGate(
			metric,
			baseline[metric] ?? [],
			candidate[metric] ?? [],
			configs[metric] ?? DEFAULT_GATES[metric],
		),
	);

	const unjudged = evaluations
		.filter(
			(e) =>
				e.result === "no_baseline" ||
				e.result === "insufficient_samples" ||
				e.result === "within_noise",
		)
		.map((e) => ({ metric: e.metric, result: e.result, reason: e.detail }));

	const blocking = evaluations
		.filter((e) => e.result === "regression" && e.blocking)
		.map((e) => e.metric);
	const warnings = evaluations
		.filter((e) => e.result === "regression" && !e.blocking)
		.map((e) => e.metric);

	const caveats: string[] = [];
	const missing = GATE_METRICS.filter((m) => !metrics.includes(m));
	if (missing.length > 0) {
		caveats.push(
			`no samples at all for ${missing.join(", ")}; those metrics were not gated and a regression in them would not have been noticed`,
		);
	}
	if (unjudged.length > 0) {
		caveats.push(
			`${unjudged.length} metric(s) could not be judged; a run with unjudged metrics is not a clean run, whatever the passing ones say`,
		);
	}
	if (evaluations.some((e) => e.result === "within_noise")) {
		caveats.push(
			"at least one metric moved materially but not beyond its baseline's variability; the change may well be real and this sample size cannot establish it",
		);
	}

	return {
		evaluations,
		blocking_regressions: blocking,
		warning_regressions: warnings,
		improvements: evaluations.filter((e) => e.result === "improvement").map((e) => e.metric),
		unjudged,
		clean: blocking.length === 0 && warnings.length === 0 && unjudged.length === 0,
		caveats,
	};
}

/**
 * Exit code for a CI step.
 *
 * `2` for unjudged-only runs, distinct from both success and failure: a
 * pipeline that cannot tell whether it regressed should not report the same
 * status as one that verified it did not.
 */
export function exitCodeFor(report: GateReport): 0 | 1 | 2 {
	if (report.blocking_regressions.length > 0) return 1;
	if (report.unjudged.length > 0) return 2;
	return 0;
}
