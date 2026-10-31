import { describe, expect, test } from "bun:test";
import type { CalibrationMap } from "../../src/diagnosis/calibration.js";
import {
	applyCalibratedObservation,
	competingBelief,
	differentialStopDecision,
	planDiscriminatingExperiments,
} from "../../src/diagnosis/differential.js";
import type { Experiment } from "../../src/diagnosis/experiments.js";
import { buildHypothesisTree } from "../../src/diagnosis/hypothesis.js";
import type { InvestigationState } from "../../src/diagnosis/stopping.js";

function tree() {
	return buildHypothesisTree({
		failure_id: "f1",
		primary_location: { file: "src/a.py", line: 10, symbol: "fn" },
		frames: [
			{ file: "src/a.py", line: 10, function: "fn", is_application: true },
			{ file: "src/b.py", line: 20, function: "other", is_application: true },
		],
		root_cause: { category: "x", explanation: "y", confidence: 0.5 },
	});
}

describe("competingBelief", () => {
	test("maps open/confirmed hypothesis posteriors by id", () => {
		const t = tree();
		const belief = competingBelief(t);
		for (const h of t.hypotheses) {
			if (h.status === "open" || h.status === "confirmed") {
				expect(belief[h.id]).toBe(h.posterior);
			} else {
				expect(belief[h.id]).toBeUndefined();
			}
		}
	});

	test("empty tree yields an empty belief", () => {
		expect(competingBelief({ schema_version: "0.1", failure_id: "f", hypotheses: [] })).toEqual({});
	});
});

describe("planDiscriminatingExperiments", () => {
	test("plans against the tree's own competing belief, under budget and risk ceiling", () => {
		const t = tree();
		const ids = t.hypotheses.map((h) => h.id);
		const decisive: Experiment = {
			id: "decisive",
			description: "a probe that separates the leader from the runner-up",
			risk: "observational",
			cost: 1,
			outcomes: ["a", "b"],
			likelihoods: Object.fromEntries(
				ids.map((id, i) => [id, i === 0 ? { a: 1, b: 0 } : { a: 0, b: 1 }]),
			),
		};
		const { belief, plan } = planDiscriminatingExperiments(t, [decisive], 10);
		expect(Object.keys(belief).sort()).toEqual(
			t.hypotheses
				.filter((h) => h.status === "open" || h.status === "confirmed")
				.map((h) => h.id)
				.sort(),
		);
		expect(plan.steps.length).toBeGreaterThan(0);
		expect(plan.steps[0].experiment.id).toBe("decisive");
	});

	test("an empty catalogue produces a plan with no steps, not an error", () => {
		const { plan } = planDiscriminatingExperiments(tree(), [], 10);
		expect(plan.steps).toEqual([]);
		expect(plan.stop_reason).toBe("catalogue_exhausted");
	});
});

describe("applyCalibratedObservation", () => {
	test("without a calibration map, behaves exactly like recordObservation", () => {
		const t = tree();
		const leaf = t.hypotheses[t.hypotheses.length - 1];
		const result = applyCalibratedObservation(t, leaf.id, {
			detail: "observed",
			outcome: "confirms",
			observed_at: "2026-01-01T00:00:00.000Z",
			likelihood_if_true: 0.9,
			likelihood_if_false: 0.2,
		});
		expect(result.calibrated).toBe(false);
	});

	test("with a calibration map, surviving open/confirmed posteriors are replaced by the observed-accuracy bin, not the raw Bayes update", () => {
		const t = tree();
		const leaf = t.hypotheses[t.hypotheses.length - 1];
		const map: CalibrationMap = {
			bin_count: 10,
			// Every bin reports a fixed observed accuracy of 0.37, deliberately
			// different from whatever the Bayes update alone would have produced.
			bins: Array.from({ length: 10 }, () => 0.37),
		};
		const result = applyCalibratedObservation(
			t,
			leaf.id,
			{
				detail: "observed",
				outcome: "inconclusive",
				observed_at: "2026-01-01T00:00:00.000Z",
				likelihood_if_true: 0.9,
				likelihood_if_false: 0.85,
			},
			map,
		);
		expect(result.calibrated).toBe(true);
		for (const h of result.tree.hypotheses) {
			if (h.status === "open" || h.status === "confirmed") {
				expect(h.posterior).toBe(0.37);
			}
		}
	});

	test("refuted/abandoned hypotheses are left alone, not recalibrated upward from zero", () => {
		const t = tree();
		const leaf = t.hypotheses[t.hypotheses.length - 1];
		const map: CalibrationMap = { bin_count: 10, bins: Array.from({ length: 10 }, () => 0.9) };
		const result = applyCalibratedObservation(
			t,
			leaf.id,
			{
				detail: "refuted",
				outcome: "refutes",
				observed_at: "2026-01-01T00:00:00.000Z",
				likelihood_if_true: 0.01,
				likelihood_if_false: 0.9,
			},
			map,
		);
		const refuted = result.tree.hypotheses.find((h) => h.id === leaf.id);
		expect(refuted?.status).toBe("refuted");
		expect(refuted?.posterior).toBeLessThan(0.9);
	});
});

describe("differentialStopDecision", () => {
	const baseInvestigation: InvestigationState = {
		steps: 5,
		elapsed_ms: 1000,
		tokens_spent: 100,
		actions_taken: 2,
		leading_confidence: 0.52,
		residual: 0.1,
		step_gains: [0.3, 0.3, 0.3],
		remaining_actions: [],
	};

	test("two close-posterior open hypotheses with no informative action left are reported as indistinguishable, not resolved", () => {
		const t = tree();
		// Flatten the two open leaves to a near tie.
		const open = t.hypotheses.filter((h) => h.status === "open");
		open[0].posterior = 0.52;
		if (open[1]) open[1].posterior = 0.48;
		const decision = differentialStopDecision(t, baseInvestigation);
		expect(decision.stop).toBe(true);
		expect(decision.classification).not.toBe("resolved");
		expect(decision.indistinguishable).toBe(true);
	});

	test("a clear leader after enough steps resolves, and is never flagged indistinguishable", () => {
		const t = tree();
		for (const h of t.hypotheses) h.posterior = h.status === "open" ? 0.05 : h.posterior;
		t.hypotheses[0].status = "confirmed";
		t.hypotheses[0].posterior = 0.95;
		const decision = differentialStopDecision(t, { ...baseInvestigation, leading_confidence: 0.95 });
		expect(decision.classification).toBe("resolved");
		expect(decision.indistinguishable).toBe(false);
	});

	test("a distinguishable leader below target with informative actions remaining just continues", () => {
		const t = tree();
		const open = t.hypotheses.filter((h) => h.status === "open");
		open[0].posterior = 0.6;
		if (open[1]) open[1].posterior = 0.1;
		const decision = differentialStopDecision(t, {
			...baseInvestigation,
			remaining_actions: [{ id: "probe", risk: "observational", expected_bits: 0.5 }],
		});
		expect(decision.stop).toBe(false);
		expect(decision.classification).toBe("continue");
		expect(decision.indistinguishable).toBe(false);
	});
});
