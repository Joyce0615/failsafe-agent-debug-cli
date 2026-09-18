import { describe, expect, test } from "bun:test";
import {
	DEFAULT_RERUN_POLICY,
	DEFAULT_THRESHOLDS,
	FLAKY_VERDICTS,
	PRIOR_ALPHA,
	PRIOR_BETA,
	type RunObservation,
	classify,
	estimateRemainingRuns,
	passStreakProbability,
	posterior,
	rerunPolicy,
	sprtDecision,
} from "../../src/rules/flaky-model.js";

function runs(pattern: string): RunObservation[] {
	// 'F' = failed, '.' = passed.
	return [...pattern].map((c) => ({ failed: c === "F" }));
}

describe("the posterior", () => {
	test("the prior is Jeffreys, which does not pull away from the boundaries", () => {
		expect(PRIOR_ALPHA).toBe(0.5);
		expect(PRIOR_BETA).toBe(0.5);
		// Ten failures put the mean close to 1, unlike a uniform prior's 11/12.
		expect(posterior(runs("FFFFFFFFFF")).mean).toBeGreaterThan(0.93);
	});

	test("the interval brackets the mean and narrows with data", () => {
		const few = posterior(runs("F...."));
		const many = posterior(runs("F....F....F....F....F...."));
		expect(few.lower).toBeLessThan(few.mean);
		expect(few.upper).toBeGreaterThan(few.mean);
		expect(many.upper - many.lower).toBeLessThan(few.upper - few.lower);
	});

	test("all passes push the interval towards zero without reaching it", () => {
		const post = posterior(runs("..............................."));
		expect(post.upper).toBeLessThan(0.15);
		expect(post.upper).toBeGreaterThan(0);
	});

	test("failures and successes are counted, not inferred", () => {
		const post = posterior(runs("FF..F"));
		expect(post.failures).toBe(3);
		expect(post.successes).toBe(2);
		expect(post.alpha).toBe(PRIOR_ALPHA + 3);
		expect(post.beta).toBe(PRIOR_BETA + 2);
	});

	test("no observations yield the prior, with a very wide interval", () => {
		const post = posterior([]);
		expect(post.mean).toBeCloseTo(0.5, 5);
		expect(post.upper - post.lower).toBeGreaterThan(0.9);
	});

	test("a wider credible mass gives a wider interval", () => {
		const narrow = posterior(runs("F....F...."), 0.5);
		const wide = posterior(runs("F....F...."), 0.99);
		expect(wide.upper - wide.lower).toBeGreaterThan(narrow.upper - narrow.lower);
	});
});

describe("classification is from the interval, not the point estimate", () => {
	test("a long run of passes eventually reads as resolved", () => {
		const result = classify(runs(".".repeat(400)));
		expect(result.verdict).toBe("resolved");
		expect(result.detail).toContain("entirely below");
	});

	test("three passes are NOT enough to call it resolved", () => {
		// The standard policy's error case, asserted directly.
		expect(classify(runs("...")).verdict).toBe("undetermined");
	});

	test("a long run of failures reads as deterministic", () => {
		const result = classify(runs("F".repeat(200)));
		expect(result.verdict).toBe("deterministic");
		expect(result.detail).toContain("entirely above");
	});

	test("a genuinely intermittent failure reads as flaky", () => {
		const result = classify(runs("F....F....F....F....F....F....F....F...."));
		expect(result.verdict).toBe("flaky");
		expect(result.detail).toContain("excludes both zero and one");
	});

	test("an interval spanning a boundary is undetermined, not rounded", () => {
		const result = classify(runs("..."));
		expect(result.verdict).toBe("undetermined");
		expect(result.detail).toContain("does not distinguish these cases");
	});

	test("no observations at all are undetermined", () => {
		expect(classify([]).verdict).toBe("undetermined");
	});

	test("the thresholds are configurable", () => {
		const lenient = classify(runs("....."), {
			resolved_below: 0.9,
			deterministic_above: 0.99,
		});
		expect(lenient.verdict).toBe("resolved");
	});

	test("every verdict is a declared member of the vocabulary", () => {
		for (const pattern of ["", "...", "F".repeat(200), "F....F....F....F....F...."]) {
			expect(FLAKY_VERDICTS).toContain(classify(runs(pattern)).verdict);
		}
	});
});

describe("the SPRT states its error rates", () => {
	test("a run of failures accepts the deterministic hypothesis", () => {
		const result = sprtDecision(runs("F".repeat(30)));
		expect(result.decision).toBe("accept_deterministic");
		expect(result.detail).toContain("α=0.05");
	});

	test("a mix of passes and failures accepts the flaky hypothesis", () => {
		const result = sprtDecision(runs("F....F....F....F...."));
		expect(result.decision).toBe("accept_flaky");
	});

	test("too little data leaves the statistic between the bounds", () => {
		const result = sprtDecision(runs("F"));
		expect(result.decision).toBe("continue");
		expect(result.statistic).toBeGreaterThan(result.lower_bound);
		expect(result.statistic).toBeLessThan(result.upper_bound);
	});

	test("tighter error rates widen the bounds and require more evidence", () => {
		const loose = sprtDecision(runs("F..."), { alpha: 0.2, beta: 0.2 });
		const tight = sprtDecision(runs("F..."), { alpha: 0.001, beta: 0.001 });
		expect(tight.upper_bound).toBeGreaterThan(loose.upper_bound);
	});

	test("the chosen error rates travel in the result", () => {
		const result = sprtDecision(runs("F..."), { alpha: 0.01, beta: 0.02 });
		expect(result.alpha).toBe(0.01);
		expect(result.beta).toBe(0.02);
	});

	test("no observations leave the statistic at zero and undecided", () => {
		const result = sprtDecision([]);
		expect(result.statistic).toBe(0);
		expect(result.decision).toBe("continue");
	});
});

describe("the standard policy's error rate is concrete", () => {
	test("three passes of a 20%-flaky test happen about half the time", () => {
		expect(passStreakProbability(0.2, 3)).toBeCloseTo(0.512, 3);
	});

	test("a deterministic failure never produces a pass streak", () => {
		expect(passStreakProbability(1, 3)).toBe(0);
	});

	test("more passes make a flaky test less likely to slip through", () => {
		expect(passStreakProbability(0.2, 20)).toBeLessThan(passStreakProbability(0.2, 3));
	});
});

describe("the rerun policy", () => {
	test("an undetermined case asks for more runs", () => {
		const decision = rerunPolicy(runs("..."));
		expect(decision.continue_running).toBe(true);
		expect(decision.verdict).toBeUndefined();
		expect(decision.reason).toContain("remain in the budget");
	});

	test("a settled case stops with the verdict", () => {
		const decision = rerunPolicy(runs("F".repeat(200)));
		expect(decision.continue_running).toBe(false);
		expect(decision.verdict).toBe("deterministic");
		expect(decision.estimated_remaining_runs).toBe(0);
	});

	test("running out of budget yields INCONCLUSIVE, never resolved", () => {
		const decision = rerunPolicy(runs("..."), { ...DEFAULT_RERUN_POLICY, max_runs: 3 });
		expect(decision.continue_running).toBe(false);
		expect(decision.verdict).toBe("inconclusive");
		expect(decision.reason).toContain("INCONCLUSIVE, not resolved");
	});

	test("an inconclusive stop estimates how many more runs would settle it", () => {
		const decision = rerunPolicy(runs("..."), { ...DEFAULT_RERUN_POLICY, max_runs: 3 });
		expect(decision.estimated_remaining_runs).toBeGreaterThan(0);
	});

	test("the classification and the SPRT are both returned for inspection", () => {
		const decision = rerunPolicy(runs("F...."));
		expect(decision.classification.posterior.failures).toBe(1);
		expect(decision.sprt.runs).toBe(5);
	});

	test("the run count is reported alongside every decision", () => {
		expect(rerunPolicy(runs("F....")).runs_so_far).toBe(5);
	});
});

describe("estimating remaining runs", () => {
	test("a wide interval near a boundary needs many more runs", () => {
		expect(estimateRemainingRuns(posterior(runs("...")), DEFAULT_THRESHOLDS)!).toBeGreaterThan(5);
	});

	test("approaching a regime boundary raises the estimate, which is the honest shape", () => {
		// Nine passes put the mean closer to the `resolved` boundary than three
		// do, so the interval has to be tighter to fit underneath it. More data
		// here makes the *decision* harder, not easier, and the estimate says so.
		const three = estimateRemainingRuns(posterior(runs("...")), DEFAULT_THRESHOLDS)!;
		const nine = estimateRemainingRuns(posterior(runs(".........")), DEFAULT_THRESHOLDS)!;
		expect(nine).toBeGreaterThan(three);
	});

	test("a comfortably central estimate needs far fewer runs than a boundary one", () => {
		const central = estimateRemainingRuns(posterior(runs("F.F.F.F.F.")), DEFAULT_THRESHOLDS)!;
		const boundary = estimateRemainingRuns(posterior(runs(".........")), DEFAULT_THRESHOLDS)!;
		expect(central).toBeLessThan(boundary);
	});

	test("no observations give no estimate rather than a guess", () => {
		expect(estimateRemainingRuns(posterior([]), DEFAULT_THRESHOLDS)).toBeNull();
	});

	test("an already-narrow interval needs none", () => {
		const narrow = posterior(runs(".".repeat(2000)));
		expect(estimateRemainingRuns(narrow, { resolved_below: 0.5, deterministic_above: 0.99 })).toBe(
			0,
		);
	});
});
