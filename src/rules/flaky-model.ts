/**
 * Flaky-failure probability model and sequential rerun policy (item 79).
 *
 * "Run it three times and see" is the universal policy and it has an error rate
 * nobody has ever computed. Three passes of a test that fails 20% of the time
 * happen 51% of the time, so the standard procedure declares half of all
 * moderately flaky tests fixed. The point of this module is not a cleverer
 * heuristic; it is to make the error rate a number that appears in the output.
 *
 * Three commitments:
 *
 * 1. **A pass is evidence, not proof.** Every verdict carries a posterior
 *    credible interval on the failure probability, and `undetermined` is a
 *    first-class outcome rather than a fallback to "fixed". A run of passes
 *    narrows the interval towards zero and never reaches it, which is the
 *    honest shape of the inference.
 *
 * 2. **The stopping rule states its error rates.** `sprtDecision` is a
 *    sequential probability ratio test with α and β chosen by the caller and
 *    reported in the result, so "we reran until it looked fine" becomes "we
 *    reran until the probability of wrongly calling this deterministic fell
 *    below 5%".
 *
 * 3. **Running out of budget is not a pass.** A capped policy that stops early
 *    returns `inconclusive` with the interval it reached and an estimate of how
 *    many more runs would settle it. Reporting that as `resolved` is the
 *    failure this module exists to prevent.
 *
 * Pure and dependency-free: the Beta posterior is integrated on a grid rather
 * than via an incomplete-beta routine, which is exact enough for a decision
 * between three regimes and avoids a numerical dependency for no benefit.
 */

export type RunObservation = { failed: boolean };

export type BetaPosterior = {
	/** Beta shape parameters after the observations. */
	alpha: number;
	beta: number;
	failures: number;
	successes: number;
	/** Posterior mean failure probability. */
	mean: number;
	/** Central credible interval at `credible_mass`. */
	lower: number;
	upper: number;
	credible_mass: number;
};

/**
 * Jeffreys prior, Beta(0.5, 0.5).
 *
 * Chosen over a uniform prior because it is the one that does not pull the
 * estimate away from the boundaries: with a uniform prior, ten consecutive
 * failures still put the posterior mean at 11/12 rather than near 1, which
 * understates a deterministic failure exactly when it matters.
 */
export const PRIOR_ALPHA = 0.5;
export const PRIOR_BETA = 0.5;

/** Grid resolution for posterior integration. */
const GRID = 2000;

function logBetaPdf(p: number, alpha: number, beta: number): number {
	if (p <= 0 || p >= 1) return Number.NEGATIVE_INFINITY;
	return (alpha - 1) * Math.log(p) + (beta - 1) * Math.log(1 - p);
}

/**
 * Posterior over the failure probability.
 *
 * The credible interval is the point of this function. A mean alone invites the
 * reading that the failure probability *is* 0.2, when after five runs it could
 * comfortably be 0.02 or 0.6, and every decision downstream depends on which.
 */
export function posterior(observations: RunObservation[], credibleMass = 0.9): BetaPosterior {
	const failures = observations.filter((o) => o.failed).length;
	const successes = observations.length - failures;
	const alpha = PRIOR_ALPHA + failures;
	const beta = PRIOR_BETA + successes;

	// Integrate the unnormalized density on a grid.
	const densities = new Array<number>(GRID);
	let max = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < GRID; i++) {
		const p = (i + 0.5) / GRID;
		densities[i] = logBetaPdf(p, alpha, beta);
		if (densities[i] > max) max = densities[i];
	}
	let total = 0;
	for (let i = 0; i < GRID; i++) {
		densities[i] = Math.exp(densities[i] - max);
		total += densities[i];
	}

	const tail = (1 - credibleMass) / 2;
	let cumulative = 0;
	let lower = 0;
	let upper = 1;
	let lowerSet = false;
	for (let i = 0; i < GRID; i++) {
		cumulative += densities[i] / total;
		const p = (i + 0.5) / GRID;
		if (!lowerSet && cumulative >= tail) {
			lower = p;
			lowerSet = true;
		}
		if (cumulative >= 1 - tail) {
			upper = p;
			break;
		}
	}

	return {
		alpha,
		beta,
		failures,
		successes,
		mean: alpha / (alpha + beta),
		lower,
		upper,
		credible_mass: credibleMass,
	};
}

export const FLAKY_VERDICTS = ["resolved", "deterministic", "flaky", "undetermined"] as const;
export type FlakyVerdict = (typeof FLAKY_VERDICTS)[number];

export type ClassificationThresholds = {
	/** Failure probability at or below which the failure is considered gone. */
	resolved_below: number;
	/** Failure probability at or above which it is considered deterministic. */
	deterministic_above: number;
};

export const DEFAULT_THRESHOLDS: ClassificationThresholds = {
	resolved_below: 0.02,
	deterministic_above: 0.95,
};

export type Classification = {
	verdict: FlakyVerdict;
	posterior: BetaPosterior;
	/** Why this verdict, in terms of the interval. */
	detail: string;
};

/**
 * Classify from the credible interval, not from the point estimate.
 *
 * A verdict is issued only when the *whole* interval falls inside a regime.
 * An interval spanning a boundary means the data does not distinguish the
 * regimes, and `undetermined` says so rather than rounding to the nearest one.
 */
export function classify(
	observations: RunObservation[],
	thresholds: ClassificationThresholds = DEFAULT_THRESHOLDS,
	credibleMass = 0.9,
): Classification {
	const post = posterior(observations, credibleMass);
	const { lower, upper } = post;

	if (upper <= thresholds.resolved_below) {
		return {
			verdict: "resolved",
			posterior: post,
			detail: `the ${credibleMass * 100}% credible interval [${lower.toFixed(3)}, ${upper.toFixed(3)}] lies entirely below ${thresholds.resolved_below}`,
		};
	}
	if (lower >= thresholds.deterministic_above) {
		return {
			verdict: "deterministic",
			posterior: post,
			detail: `the interval [${lower.toFixed(3)}, ${upper.toFixed(3)}] lies entirely above ${thresholds.deterministic_above}`,
		};
	}
	if (lower > thresholds.resolved_below && upper < thresholds.deterministic_above) {
		return {
			verdict: "flaky",
			posterior: post,
			detail: `the interval [${lower.toFixed(3)}, ${upper.toFixed(3)}] excludes both zero and one: the failure is intermittent`,
		};
	}
	return {
		verdict: "undetermined",
		posterior: post,
		detail: `the interval [${lower.toFixed(3)}, ${upper.toFixed(3)}] spans a regime boundary after ${observations.length} run(s); the data does not distinguish these cases`,
	};
}

export type SprtResult = {
	decision: "accept_flaky" | "accept_deterministic" | "continue";
	/** Cumulative log-likelihood ratio. */
	statistic: number;
	upper_bound: number;
	lower_bound: number;
	/** Probability of wrongly accepting flaky. */
	alpha: number;
	/** Probability of wrongly accepting deterministic. */
	beta: number;
	runs: number;
	detail: string;
};

/**
 * Sequential probability ratio test between "flaky at p1" and
 * "deterministic at p0".
 *
 * The value here is not the arithmetic, which is textbook. It is that α and β
 * are inputs and appear in the output, so the policy's error rate is a stated
 * property rather than an emergent one. A fixed three-rerun policy has an error
 * rate too; nobody knows what it is.
 */
export function sprtDecision(
	observations: RunObservation[],
	opts: { p_flaky?: number; p_deterministic?: number; alpha?: number; beta?: number } = {},
): SprtResult {
	const p1 = opts.p_flaky ?? 0.3;
	const p0 = opts.p_deterministic ?? 0.95;
	const alpha = opts.alpha ?? 0.05;
	const beta = opts.beta ?? 0.05;

	const upper = Math.log((1 - beta) / alpha);
	const lower = Math.log(beta / (1 - alpha));

	let statistic = 0;
	for (const observation of observations) {
		statistic += observation.failed ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
	}

	const decision: SprtResult["decision"] =
		statistic >= upper ? "accept_flaky" : statistic <= lower ? "accept_deterministic" : "continue";

	return {
		decision,
		statistic,
		upper_bound: upper,
		lower_bound: lower,
		alpha,
		beta,
		runs: observations.length,
		detail:
			decision === "continue"
				? `after ${observations.length} run(s) the statistic ${statistic.toFixed(3)} is between ${lower.toFixed(3)} and ${upper.toFixed(3)}; more runs are needed to decide at α=${alpha}, β=${beta}`
				: `after ${observations.length} run(s) the statistic ${statistic.toFixed(3)} crossed its bound: ${decision === "accept_flaky" ? `intermittent at around p=${p1}` : `deterministic at around p=${p0}`}, with error rates α=${alpha}, β=${beta}`,
	};
}

export type RerunPolicy = {
	/** Maximum reruns the caller is willing to pay for. */
	max_runs: number;
	thresholds: ClassificationThresholds;
	credible_mass: number;
	alpha: number;
	beta: number;
};

export const DEFAULT_RERUN_POLICY: RerunPolicy = {
	max_runs: 20,
	thresholds: DEFAULT_THRESHOLDS,
	credible_mass: 0.9,
	alpha: 0.05,
	beta: 0.05,
};

export type PolicyDecision = {
	/** Whether to run again. */
	continue_running: boolean;
	/** Only set when `continue_running` is false. */
	verdict?: FlakyVerdict | "inconclusive";
	classification: Classification;
	sprt: SprtResult;
	runs_so_far: number;
	/** Estimated further runs to settle it, when it is not settled. */
	estimated_remaining_runs: number | null;
	reason: string;
};

/**
 * Estimate how many more runs would narrow the interval enough to decide.
 *
 * The interval width shrinks roughly as `1/sqrt(n)`, so the required n scales
 * as the square of the ratio of current to target width. An estimate and
 * labelled as one: the actual number depends on what those runs return, which
 * is exactly what is unknown.
 */
export function estimateRemainingRuns(
	post: BetaPosterior,
	thresholds: ClassificationThresholds,
): number | null {
	const n = post.failures + post.successes;
	if (n === 0) return null;
	const width = post.upper - post.lower;

	// The width that would let the interval fit inside whichever regime the
	// posterior mean currently sits in. Using a single global target would be
	// wrong: an estimate near 0.5 has enormous room, one near a boundary has
	// almost none, and the difference is the whole reason some cases take
	// twenty runs and some take two hundred.
	let target: number;
	if (post.mean <= thresholds.resolved_below) {
		target = thresholds.resolved_below;
	} else if (post.mean >= thresholds.deterministic_above) {
		target = 1 - thresholds.deterministic_above;
	} else {
		const toLower = post.mean - thresholds.resolved_below;
		const toUpper = thresholds.deterministic_above - post.mean;
		target = 2 * Math.min(toLower, toUpper);
	}
	if (target <= 0 || width <= target) return 0;

	const required = n * (width / target) ** 2;
	return required <= n ? 0 : Math.ceil(required - n);
}

/**
 * Decide whether to run again.
 *
 * Budget exhaustion yields `inconclusive`, never `resolved`. That is the whole
 * point: a policy that reports a pass because it ran out of runs has converted
 * an unknown into a false certainty, and every downstream decision inherits it.
 */
export function rerunPolicy(
	observations: RunObservation[],
	policy: RerunPolicy = DEFAULT_RERUN_POLICY,
): PolicyDecision {
	const classification = classify(observations, policy.thresholds, policy.credible_mass);
	const sprt = sprtDecision(observations, {
		alpha: policy.alpha,
		beta: policy.beta,
		p_deterministic: policy.thresholds.deterministic_above,
	});
	const runs = observations.length;
	const remaining = estimateRemainingRuns(classification.posterior, policy.thresholds);

	if (classification.verdict !== "undetermined") {
		return {
			continue_running: false,
			verdict: classification.verdict,
			classification,
			sprt,
			runs_so_far: runs,
			estimated_remaining_runs: 0,
			reason: `settled after ${runs} run(s): ${classification.detail}`,
		};
	}

	if (runs >= policy.max_runs) {
		return {
			continue_running: false,
			verdict: "inconclusive",
			classification,
			sprt,
			runs_so_far: runs,
			estimated_remaining_runs: remaining,
			reason: `the rerun budget of ${policy.max_runs} is spent and the interval still spans a regime boundary; this is INCONCLUSIVE, not resolved — roughly ${remaining ?? "an unknown number of"} further run(s) would be needed`,
		};
	}

	return {
		continue_running: true,
		classification,
		sprt,
		runs_so_far: runs,
		estimated_remaining_runs: remaining,
		reason: `${classification.detail}; ${policy.max_runs - runs} run(s) remain in the budget`,
	};
}

/**
 * Probability that `passes` consecutive passes would occur for a failure with
 * probability `p`.
 *
 * Exported because it is the number that makes the standard policy's error rate
 * concrete: three passes of a 20%-flaky test happen 51% of the time.
 */
export function passStreakProbability(p: number, passes: number): number {
	return (1 - p) ** passes;
}
