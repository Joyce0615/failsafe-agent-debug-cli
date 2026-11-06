/**
 * Cross-examination diagnosis sessions (item 33).
 */
import { describe, expect, test } from "bun:test";
import type { Experiment } from "../../src/diagnosis/experiments.js";
import type { HypothesisTree, Observation } from "../../src/diagnosis/hypothesis.js";
import {
	challengeCausalClaim,
	crossExaminationVerdict,
	newCrossExaminationSession,
	recordCrossExamObservation,
	requestDiscriminatingEvidence,
} from "../../src/diagnosis/cross-examination.js";

function tree(): HypothesisTree {
	return {
		schema_version: "0.1",
		failure_id: "f1",
		hypotheses: [
			{
				id: "h1",
				failure_id: "f1",
				level: "module",
				statement: "h1",
				prior: 0.5,
				posterior: 0.5,
				status: "open",
				observations: [],
			},
			{
				id: "h2",
				failure_id: "f1",
				level: "module",
				statement: "h2",
				prior: 0.5,
				posterior: 0.5,
				status: "open",
				observations: [],
			},
		],
	};
}

function observation(outcome: Observation["outcome"]): Observation {
	return {
		detail: "observed",
		outcome,
		observed_at: "2024-01-01T00:00:00Z",
		likelihood_if_true: outcome === "confirms" ? 0.9 : 0.1,
		likelihood_if_false: outcome === "confirms" ? 0.1 : 0.9,
	};
}

const experiments: Experiment[] = [
	{
		id: "e1",
		description: "probe",
		risk: "observational",
		cost: 1,
		outcomes: ["a", "b"],
		likelihoods: { h1: { a: 0.9, b: 0.1 }, h2: { a: 0.1, b: 0.9 } },
	},
];

describe("newCrossExaminationSession", () => {
	test("starts at turn 0 with the full privacy and effect budgets unspent", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 3,
			epsilon_total: 1,
			effects_total: 10,
		});
		expect(session.turn).toBe(0);
		expect(session.privacy_budget.epsilon_spent).toBe(0);
		expect(session.effects_spent).toBe(0);
	});
});

describe("requestDiscriminatingEvidence", () => {
	test("plans against the session's own current belief", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 3,
			epsilon_total: 1,
			effects_total: 10,
		});
		const plan = requestDiscriminatingEvidence(session, experiments, 5);
		expect(plan.belief.h1).toBe(0.5);
		expect(plan.plan.steps.length).toBeGreaterThan(0);
	});

	test("refuses to plan once the turn budget is exhausted", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 0,
			epsilon_total: 1,
			effects_total: 10,
		});
		expect(() => requestDiscriminatingEvidence(session, experiments, 5)).toThrow();
	});
});

describe("recordCrossExamObservation", () => {
	test("applies the observation, advances the turn, and deducts both budgets", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 3,
			epsilon_total: 1,
			effects_total: 10,
		});
		const result = recordCrossExamObservation(session, "h1", observation("confirms"), {
			epsilon: 0.2,
			effect: 3,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.session.turn).toBe(1);
			expect(result.session.privacy_budget.epsilon_spent).toBe(0.2);
			expect(result.session.effects_spent).toBe(3);
		}
	});

	test("refuses, leaving the session unchanged, when the privacy budget would be exceeded", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 3,
			epsilon_total: 0.1,
			effects_total: 10,
		});
		const result = recordCrossExamObservation(session, "h1", observation("confirms"), {
			epsilon: 0.5,
			effect: 1,
		});
		expect(result.ok).toBe(false);
		expect(session.turn).toBe(0);
	});

	test("refuses, leaving the session unchanged, when the effect budget would be exceeded", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 3,
			epsilon_total: 1,
			effects_total: 1,
		});
		const result = recordCrossExamObservation(session, "h1", observation("confirms"), {
			epsilon: 0.1,
			effect: 5,
		});
		expect(result.ok).toBe(false);
		expect(session.effects_spent).toBe(0);
	});

	test("refuses once the turn budget is exhausted", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 1,
			epsilon_total: 1,
			effects_total: 10,
		});
		const first = recordCrossExamObservation(session, "h1", observation("confirms"), {
			epsilon: 0.1,
			effect: 1,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("unreachable");
		const second = recordCrossExamObservation(first.session, "h1", observation("confirms"), {
			epsilon: 0.1,
			effect: 1,
		});
		expect(second.ok).toBe(false);
	});
});

describe("challengeCausalClaim", () => {
	test("a refuting intervention overturns an existing causal claim", () => {
		const node = (id: string) => ({ id, kind: "tool" as const, status: "ok" as const, ts: 0 });
		const result = challengeCausalClaim(
			[node("cause"), node("effect")],
			[{ cause: "cause", effect: "effect", changed: false, description: "re-ran with cause changed" }],
		);
		expect(result.refuted).toHaveLength(1);
		expect(result.refuted[0].from).toBe("cause");
	});

	test("a confirming intervention sustains the causal claim, not a refutation", () => {
		const node = (id: string) => ({ id, kind: "tool" as const, status: "ok" as const, ts: 0 });
		const result = challengeCausalClaim(
			[node("cause"), node("effect")],
			[{ cause: "cause", effect: "effect", changed: true, description: "re-ran with cause changed" }],
		);
		expect(result.refuted).toHaveLength(0);
		expect(result.edges.length).toBeGreaterThan(0);
	});
});

describe("crossExaminationVerdict", () => {
	test("abstains when the turn budget is exhausted without convergence", () => {
		const session = newCrossExaminationSession(tree(), {
			max_turns: 0,
			epsilon_total: 1,
			effects_total: 10,
		});
		const verdict = crossExaminationVerdict(session, {
			remaining_actions: [{ id: "e1", expected_bits: 1, risk: "observational" }],
			step_gains: [],
		});
		expect(verdict.abstain).toBe(true);
		expect(verdict.reason).toContain("turn budget");
	});

	test("does not abstain merely because an underlying stop decision resolved", () => {
		const confident = tree();
		confident.hypotheses[0].posterior = 0.95;
		confident.hypotheses[0].status = "confirmed";
		confident.hypotheses[1].posterior = 0.05;
		const session = newCrossExaminationSession(confident, {
			max_turns: 3,
			epsilon_total: 1,
			effects_total: 10,
		});
		// Advance past the shallow-run guard: min_steps default is 3.
		session.turn = 3;
		const verdict = crossExaminationVerdict(session, {
			remaining_actions: [],
			step_gains: [],
		});
		expect(verdict.abstain).toBe(false);
		expect(verdict.decision.classification).toBe("resolved");
	});
});
