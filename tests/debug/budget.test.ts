import { describe, expect, test } from "bun:test";
import {
	type BudgetHypothesis,
	DEFAULT_CEILING,
	DEFAULT_EIG_THRESHOLD,
	DebugBudgetLedger,
	TIER_COST,
	TIER_ORDER,
	allocateBudget,
	buildDebugPlan,
	decideEscalation,
	entropyBits,
	expectedInformationGain,
	terminationSummary,
	tierRank,
} from "../../src/debug/budget.js";
import { guidanceHypotheses, resolveCeiling } from "../../src/core/debug-guidance.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";

const CEILING = { max_actions: 20, max_tokens: 10000, max_ms: 60000 };

function hyps(...priors: number[]): BudgetHypothesis[] {
	return priors.map((p, i) => ({ id: `h${i}`, label: `hypothesis ${i}`, prior: p }));
}

describe("tier ordering", () => {
	test("tiers run coarse to fine and cost more as they go", () => {
		expect(TIER_ORDER).toEqual(["evidence", "slice", "breakpoint", "step"]);
		for (let i = 1; i < TIER_ORDER.length; i++) {
			expect(tierRank(TIER_ORDER[i])).toBeGreaterThan(tierRank(TIER_ORDER[i - 1]));
			expect(TIER_COST[TIER_ORDER[i]].tokens).toBeGreaterThan(TIER_COST[TIER_ORDER[i - 1]].tokens);
		}
	});
});

describe("allocation by hypothesis", () => {
	test("allocations sum to exactly the ceiling", () => {
		const allocations = allocateBudget(hyps(0.7, 0.2, 0.1), CEILING);
		expect(allocations.reduce((a, x) => a + x.actions, 0)).toBe(CEILING.max_actions);
		expect(allocations.reduce((a, x) => a + x.tokens, 0)).toBe(CEILING.max_tokens);
		expect(allocations.reduce((a, x) => a + x.ms, 0)).toBe(CEILING.max_ms);
	});

	test("a higher prior receives a larger share", () => {
		const [a, b] = allocateBudget(hyps(0.8, 0.2), CEILING);
		expect(a.actions).toBeGreaterThan(b.actions);
	});

	test("a long-shot hypothesis is never starved to zero", () => {
		const allocations = allocateBudget(hyps(0.98, 0.02), CEILING);
		const underdog = allocations[1];
		expect(underdog.actions).toBeGreaterThan(0);
		expect(underdog.share).toBeGreaterThanOrEqual(0.05);
	});

	test("the leader is capped so it cannot take the whole budget", () => {
		const [leader] = allocateBudget(hyps(0.99, 0.005, 0.005), CEILING);
		expect(leader.share).toBeLessThanOrEqual(0.6 + 1e-9);
	});

	test("degenerate priors fall back to a uniform split", () => {
		const allocations = allocateBudget(hyps(0, 0), CEILING);
		expect(allocations[0].actions).toBe(allocations[1].actions);
	});

	test("an empty hypothesis set allocates nothing", () => {
		expect(allocateBudget([], CEILING)).toEqual([]);
	});

	test("allocation is deterministic", () => {
		const a = allocateBudget(hyps(0.5, 0.3, 0.2), CEILING);
		const b = allocateBudget(hyps(0.5, 0.3, 0.2), CEILING);
		expect(a).toEqual(b);
	});
});

describe("expected information gain", () => {
	test("entropy of a fair coin is one bit", () => {
		expect(entropyBits([0.5, 0.5])).toBeCloseTo(1, 10);
		expect(entropyBits([1, 0])).toBeCloseTo(0, 10);
	});

	test("a perfectly discriminating probe over two equal hypotheses yields 1 bit", () => {
		const eig = expectedInformationGain(
			[0.5, 0.5],
			[
				[1, 0],
				[0, 1],
			],
		);
		expect(eig).toBeCloseTo(1, 10);
	});

	test("a probe with identical likelihoods yields zero gain", () => {
		const eig = expectedInformationGain(
			[0.5, 0.5],
			[
				[0.5, 0.5],
				[0.5, 0.5],
			],
		);
		expect(eig).toBeCloseTo(0, 10);
	});

	test("a partially discriminating probe lands strictly between", () => {
		const eig = expectedInformationGain(
			[0.5, 0.5],
			[
				[0.7, 0.3],
				[0.3, 0.7],
			],
		);
		expect(eig).toBeGreaterThan(0);
		expect(eig).toBeLessThan(1);
	});

	test("gain is never negative and degenerate input is zero", () => {
		expect(expectedInformationGain([], [])).toBe(0);
		expect(expectedInformationGain([1], [[]])).toBe(0);
		expect(expectedInformationGain([1, 1], [[1, 0]])).toBe(0);
	});
});

describe("coarse-to-fine escalation", () => {
	const discriminating = [
		[1, 0],
		[0, 1],
	];
	const useless = [
		[0.5, 0.5],
		[0.5, 0.5],
	];
	const plenty = { actions: 100, tokens: 100000 };

	test("stepping is allowed when the probe is informative", () => {
		const d = decideEscalation({
			from: "breakpoint",
			to: "step",
			priors: [0.5, 0.5],
			likelihoods: discriminating,
			remaining: plenty,
		});
		expect(d.escalate).toBe(true);
		expect(d.tier).toBe("step");
		expect(d.expected_information_gain).toBeGreaterThan(DEFAULT_EIG_THRESHOLD);
	});

	test("stepping is refused when the probe cannot discriminate", () => {
		const d = decideEscalation({
			from: "breakpoint",
			to: "step",
			priors: [0.5, 0.5],
			likelihoods: useless,
			remaining: plenty,
		});
		expect(d.escalate).toBe(false);
		expect(d.tier).toBe("breakpoint");
		expect(d.reason).toContain("below the");
	});

	test("coarse tiers are not gated on information gain", () => {
		const d = decideEscalation({
			from: "evidence",
			to: "slice",
			priors: [0.5, 0.5],
			likelihoods: useless,
			remaining: plenty,
		});
		expect(d.escalate).toBe(true);
	});

	test("an unaffordable tier is refused regardless of gain", () => {
		const d = decideEscalation({
			from: "breakpoint",
			to: "step",
			priors: [0.5, 0.5],
			likelihoods: discriminating,
			remaining: { actions: 1, tokens: 100000 },
		});
		expect(d.escalate).toBe(false);
		expect(d.reason).toContain("cannot afford");
	});

	test("de-escalation is always permitted", () => {
		const d = decideEscalation({
			from: "step",
			to: "slice",
			priors: [0.5, 0.5],
			likelihoods: useless,
			remaining: { actions: 0, tokens: 0 },
		});
		expect(d.escalate).toBe(true);
		expect(d.tier).toBe("slice");
	});
});

describe("debug plan", () => {
	test("a discriminating probe authorizes the full ladder", () => {
		const plan = buildDebugPlan({
			hypotheses: hyps(0.5, 0.5),
			likelihoods: [
				[1, 0],
				[0, 1],
			],
			ceiling: DEFAULT_CEILING,
		});
		expect(plan.max_authorized_tier).toBe("step");
		expect(plan.stop_reason).toBeUndefined();
	});

	test("the default probe model stops short of line-level stepping", () => {
		const plan = buildDebugPlan({ hypotheses: hyps(0.6, 0.4), ceiling: DEFAULT_CEILING });
		expect(plan.max_authorized_tier).toBe("breakpoint");
		expect(plan.stop_reason).toContain("information gain");
		const stepStage = plan.stages.find((s) => s.tier === "step");
		expect(stepStage?.gate?.escalate).toBe(false);
	});

	test("a tiny ceiling stops the ladder on affordability", () => {
		const plan = buildDebugPlan({
			hypotheses: hyps(1),
			likelihoods: [[1]],
			ceiling: { max_actions: 2, max_tokens: 300, max_ms: 1000 },
		});
		expect(plan.max_authorized_tier).toBe("evidence");
		expect(plan.stop_reason).toContain("cannot afford");
	});

	test("every non-leading hypothesis still gets one cheap look", () => {
		const plan = buildDebugPlan({ hypotheses: hyps(0.8, 0.15, 0.05), ceiling: DEFAULT_CEILING });
		const altStages = plan.stages.filter((s) => s.hypothesis_id !== "h0");
		expect(altStages).toHaveLength(2);
		expect(altStages.every((s) => s.tier === "slice")).toBe(true);
	});

	test("an empty hypothesis set produces an empty plan", () => {
		const plan = buildDebugPlan({ hypotheses: [] });
		expect(plan.stages).toEqual([]);
		expect(plan.max_authorized_tier).toBe("evidence");
	});
});

describe("budget ledger", () => {
	function ledger(ceiling = CEILING) {
		const allocations = allocateBudget(hyps(0.6, 0.4), ceiling);
		return new DebugBudgetLedger(ceiling, allocations);
	}

	test("accepted spends reduce the remaining budget", () => {
		const l = ledger();
		const r = l.spend("h0", "breakpoint", 500);
		expect(r.accepted).toBe(true);
		expect(r.remaining.actions).toBe(CEILING.max_actions - TIER_COST.breakpoint.actions);
		expect(r.remaining.ms).toBe(CEILING.max_ms - 500);
	});

	test("the ceiling is a real bound: an unaffordable spend is refused, not overrun", () => {
		const l = ledger({ max_actions: 3, max_tokens: 100000, max_ms: 100000 });
		expect(l.spend("h0", "step").accepted).toBe(false);
		expect(l.report().spent.actions).toBe(0);
		expect(l.report().termination_reason).toBe("actions_exhausted");
	});

	test("token exhaustion is reported distinctly from action exhaustion", () => {
		const l = ledger({ max_actions: 100, max_tokens: 100, max_ms: 100000 });
		expect(l.spend("h0", "evidence").refused_reason).toBe("tokens_exhausted");
	});

	test("time exhaustion is reported distinctly", () => {
		const l = ledger({ max_actions: 100, max_tokens: 100000, max_ms: 100 });
		expect(l.spend("h0", "evidence", 500).refused_reason).toBe("time_exhausted");
	});

	test("a terminated ledger refuses all further spend", () => {
		const l = ledger();
		l.terminate("resolved");
		expect(l.spend("h0", "evidence").accepted).toBe(false);
		expect(l.report().termination_reason).toBe("resolved");
	});

	test("terminate does not overwrite an earlier reason", () => {
		const l = ledger({ max_actions: 1, max_tokens: 100000, max_ms: 100000 });
		l.spend("h0", "breakpoint");
		l.terminate("resolved");
		expect(l.report().termination_reason).toBe("actions_exhausted");
	});

	test("the report tracks the finest tier reached and per-hypothesis spend", () => {
		const l = ledger({ max_actions: 100, max_tokens: 100000, max_ms: 100000 });
		l.spend("h0", "evidence");
		l.spend("h0", "breakpoint");
		l.spend("h1", "slice");
		const report = l.report();
		expect(report.tier_reached).toBe("breakpoint");
		const h0 = report.hypotheses.find((h) => h.hypothesis_id === "h0");
		expect(h0?.spent_actions).toBe(TIER_COST.evidence.actions + TIER_COST.breakpoint.actions);
		expect(report.terminated).toBe(false);
		expect(report.summary).toBe("budget remaining");
	});

	test("per-hypothesis allocation exhaustion is detectable", () => {
		const allocations = allocateBudget(hyps(0.5, 0.5), { ...CEILING, max_actions: 4 });
		const l = new DebugBudgetLedger({ ...CEILING, max_actions: 4 }, allocations);
		expect(l.allocationExhausted("h0")).toBe(false);
		l.spend("h0", "breakpoint");
		expect(l.allocationExhausted("h0")).toBe(true);
		expect(l.allocationExhausted("nonexistent")).toBe(false);
	});

	test("every termination reason has a distinct actionable summary", () => {
		const reasons = [
			"resolved",
			"actions_exhausted",
			"tokens_exhausted",
			"time_exhausted",
			"information_gain_below_threshold",
			"hypotheses_exhausted",
		] as const;
		const summaries = reasons.map((r) => terminationSummary(r, "breakpoint"));
		expect(new Set(summaries).size).toBe(reasons.length);
		for (const s of summaries) expect(s.length).toBeGreaterThan(20);
	});
});

describe("guidance hypotheses", () => {
	function diagnosisWith(confidence: number): FailureDiagnosis {
		return {
			root_cause: { category: "key_error", explanation: "missing 'email' key", confidence },
		} as FailureDiagnosis;
	}

	test("an undiagnosed failure gets a single unknown hypothesis", () => {
		const h = guidanceHypotheses(null);
		expect(h).toHaveLength(1);
		expect(h[0].id).toBe("unknown");
	});

	test("residual belief becomes an explicit competing hypothesis", () => {
		const h = guidanceHypotheses(diagnosisWith(0.4));
		expect(h.map((x) => x.id)).toEqual(["key_error", "residual"]);
		expect(h[1].prior).toBeCloseTo(0.6, 10);
		// The residual has no located suspect, so it cannot justify stepping.
		expect(h[1].max_tier).toBe("breakpoint");
	});

	test("a certain diagnosis has no residual", () => {
		expect(guidanceHypotheses(diagnosisWith(1))).toHaveLength(1);
	});

	test("a low-confidence diagnosis does not take the whole budget", () => {
		const allocations = allocateBudget(guidanceHypotheses(diagnosisWith(0.4)), CEILING);
		const leader = allocations.find((a) => a.hypothesis_id === "key_error");
		expect(leader?.share).toBeLessThan(0.5);
	});
});

describe("ceiling parsing", () => {
	test("an absent spec uses the default ceiling", () => {
		expect(resolveCeiling(undefined)).toEqual(DEFAULT_CEILING);
	});

	test("partial specs fill in from the default", () => {
		expect(resolveCeiling("8")).toEqual({ ...DEFAULT_CEILING, max_actions: 8 });
		expect(resolveCeiling("8,500")).toEqual({
			...DEFAULT_CEILING,
			max_actions: 8,
			max_tokens: 500,
		});
	});

	test("garbage and non-positive values fall back rather than throwing", () => {
		expect(resolveCeiling("abc")).toEqual(DEFAULT_CEILING);
		expect(resolveCeiling("0,-5")).toEqual(DEFAULT_CEILING);
	});
});
