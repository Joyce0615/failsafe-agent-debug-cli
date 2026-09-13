import { describe, expect, test } from "bun:test";
import {
	type Belief,
	DISCRIMINATION_THRESHOLD,
	type Experiment,
	RISK_TIERS,
	entropy,
	expectedInformationGain,
	jointInformationGain,
	normalize,
	outcomeDistribution,
	planSequence,
	rankExperiments,
	updateBelief,
	validateExperiment,
} from "../../src/diagnosis/experiments.js";

const TWO: Belief = { a: 0.5, b: 0.5 };
const FOUR: Belief = { a: 0.25, b: 0.25, c: 0.25, d: 0.25 };

/** An experiment that perfectly separates `a` from `b`. */
function decisive(overrides: Partial<Experiment> = {}): Experiment {
	return {
		id: "decisive",
		description: "check the log line",
		risk: "observational",
		cost: 1,
		outcomes: ["present", "absent"],
		likelihoods: {
			a: { present: 1, absent: 0 },
			b: { present: 0, absent: 1 },
		},
		...overrides,
	};
}

/** An experiment whose outcome says nothing. */
function useless(overrides: Partial<Experiment> = {}): Experiment {
	return {
		id: "useless",
		description: "check something unrelated",
		risk: "observational",
		cost: 0.01,
		outcomes: ["yes", "no"],
		likelihoods: {
			a: { yes: 0.5, no: 0.5 },
			b: { yes: 0.5, no: 0.5 },
		},
		...overrides,
	};
}

describe("entropy and belief arithmetic", () => {
	test("a fair binary belief is one bit", () => {
		expect(entropy(TWO)).toBeCloseTo(1, 10);
	});

	test("four equal hypotheses are two bits", () => {
		expect(entropy(FOUR)).toBeCloseTo(2, 10);
	});

	test("a certain belief is zero bits", () => {
		expect(entropy({ a: 1, b: 0 })).toBe(0);
	});

	test("normalization rescales and handles an all-zero belief", () => {
		expect(normalize({ a: 2, b: 2 })).toEqual({ a: 0.5, b: 0.5 });
		expect(normalize({ a: 0, b: 0 })).toEqual({ a: 0.5, b: 0.5 });
	});

	test("a decisive outcome collapses the posterior", () => {
		const { posterior, impossible } = updateBelief(TWO, decisive(), "present");
		expect(posterior.a).toBeCloseTo(1, 10);
		expect(impossible).toBe(false);
	});

	test("an impossible outcome keeps the prior and says so", () => {
		const experiment = decisive({
			outcomes: ["present", "absent", "impossible"],
			likelihoods: {
				a: { present: 1, absent: 0, impossible: 0 },
				b: { present: 0, absent: 1, impossible: 0 },
			},
		});
		const { posterior, impossible } = updateBelief(TWO, experiment, "impossible");
		expect(impossible).toBe(true);
		expect(posterior).toEqual(TWO);
	});

	test("the outcome distribution marginalizes correctly", () => {
		const marginal = outcomeDistribution({ a: 0.8, b: 0.2 }, decisive());
		expect(marginal.present).toBeCloseTo(0.8, 10);
		expect(marginal.absent).toBeCloseTo(0.2, 10);
	});
});

describe("expected information gain", () => {
	test("a perfectly discriminating binary probe is worth one bit", () => {
		expect(expectedInformationGain(TWO, decisive())).toBeCloseTo(1, 10);
	});

	test("an experiment with the same distribution under every hypothesis is worth zero", () => {
		expect(expectedInformationGain(TWO, useless())).toBe(0);
	});

	test("a noisy probe is worth less than a clean one", () => {
		const noisy = decisive({
			likelihoods: {
				a: { present: 0.7, absent: 0.3 },
				b: { present: 0.3, absent: 0.7 },
			},
		});
		expect(expectedInformationGain(TWO, noisy)).toBeLessThan(
			expectedInformationGain(TWO, decisive()),
		);
		expect(expectedInformationGain(TWO, noisy)).toBeGreaterThan(0);
	});

	test("a probe cannot gain more than the entropy available", () => {
		expect(expectedInformationGain(TWO, decisive())).toBeLessThanOrEqual(entropy(TWO) + 1e-9);
	});

	test("an already-settled belief has nothing left to gain", () => {
		expect(expectedInformationGain({ a: 1, b: 0 }, decisive())).toBeCloseTo(0, 10);
	});

	test("gain is never negative, even with floating-point noise", () => {
		for (let i = 1; i < 20; i++) {
			const belief = normalize({ a: i, b: 20 - i });
			expect(expectedInformationGain(belief, decisive())).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("validation of the likelihood model", () => {
	test("a well-formed experiment has no issues", () => {
		expect(validateExperiment(decisive(), ["a", "b"])).toEqual([]);
	});

	test("a row that does not sum to one is rejected", () => {
		const broken = decisive({
			likelihoods: { a: { present: 0.9, absent: 0.9 }, b: { present: 0, absent: 1 } },
		});
		expect(validateExperiment(broken, ["a", "b"])[0].problem).toContain("sum to");
	});

	test("a missing hypothesis row is rejected", () => {
		expect(validateExperiment(decisive(), ["a", "b", "c"])[0].problem).toContain("no likelihoods");
	});

	test("a negative likelihood is rejected", () => {
		const broken = decisive({
			likelihoods: { a: { present: 1.5, absent: -0.5 }, b: { present: 0, absent: 1 } },
		});
		expect(validateExperiment(broken, ["a", "b"]).some((i) => i.problem.includes("negative"))).toBe(
			true,
		);
	});

	test("a single-outcome experiment is rejected as uninformative by construction", () => {
		const single = decisive({ outcomes: ["only"], likelihoods: { a: { only: 1 }, b: { only: 1 } } });
		expect(validateExperiment(single, ["a", "b"])[0].problem).toContain("cannot inform");
	});

	test("a negative cost is rejected", () => {
		expect(
			validateExperiment(decisive({ cost: -1 }), ["a", "b"]).some((i) =>
				i.problem.includes("negative cost"),
			),
		).toBe(true);
	});
});

describe("ranking", () => {
	test("a cheap useless experiment never outranks an informative one", () => {
		const ranked = rankExperiments(TWO, [useless(), decisive({ cost: 100 })]);
		expect(ranked[0].experiment.id).toBe("decisive");
		expect(ranked[1].uninformative).toBe(true);
	});

	test("an uninformative experiment is named, not merely ranked last", () => {
		const ranked = rankExperiments(TWO, [useless()]);
		expect(ranked[0].rationale).toContain("at any price");
	});

	test("among equally informative experiments the cheaper wins", () => {
		const ranked = rankExperiments(TWO, [
			decisive({ id: "expensive", cost: 10 }),
			decisive({ id: "cheap", cost: 1 }),
		]);
		expect(ranked[0].experiment.id).toBe("cheap");
	});

	test("a free informative experiment has infinite bits per cost", () => {
		expect(rankExperiments(TWO, [decisive({ cost: 0 })])[0].bits_per_cost).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	test("risk is a gate: a destructive experiment cannot outrank a sufficient safe one", () => {
		const ranked = rankExperiments(TWO, [
			decisive({ id: "nuke", risk: "destructive", cost: 0.001 }),
			decisive({ id: "safe", risk: "observational", cost: 1000 }),
		]);
		expect(ranked[0].experiment.id).toBe("safe");
		expect(ranked[0].bits_per_cost).toBeLessThan(ranked[1].bits_per_cost);
	});

	test("the risk gate does not apply when no safe experiment discriminates", () => {
		const ranked = rankExperiments(TWO, [
			useless({ id: "safe-but-useless" }),
			decisive({ id: "risky", risk: "disruptive" }),
		]);
		expect(ranked[0].experiment.id).toBe("risky");
	});

	test("the risk tiers are ordered safest first", () => {
		expect(RISK_TIERS).toEqual(["observational", "reversible", "disruptive", "destructive"]);
	});

	test("an experiment below the threshold is explained rather than silently demoted", () => {
		const weak = decisive({
			id: "weak",
			likelihoods: { a: { present: 0.51, absent: 0.49 }, b: { present: 0.49, absent: 0.51 } },
		});
		const ranked = rankExperiments(TWO, [weak]);
		expect(ranked[0].expected_bits).toBeLessThan(DISCRIMINATION_THRESHOLD);
		expect(ranked[0].rationale).toContain("discrimination threshold");
	});
});

describe("sequential planning", () => {
	/** Two experiments that each split four hypotheses in half, on different axes. */
	function splitters(): Experiment[] {
		return [
			{
				id: "axis1",
				description: "first axis",
				risk: "observational",
				cost: 1,
				outcomes: ["hi", "lo"],
				likelihoods: {
					a: { hi: 1, lo: 0 },
					b: { hi: 1, lo: 0 },
					c: { hi: 0, lo: 1 },
					d: { hi: 0, lo: 1 },
				},
			},
			{
				id: "axis2",
				description: "second axis",
				risk: "observational",
				cost: 1,
				outcomes: ["hi", "lo"],
				likelihoods: {
					a: { hi: 1, lo: 0 },
					b: { hi: 0, lo: 1 },
					c: { hi: 1, lo: 0 },
					d: { hi: 0, lo: 1 },
				},
			},
		];
	}

	test("a plan runs both splitters and resolves four hypotheses", () => {
		const plan = planSequence(FOUR, splitters(), 10);
		expect(plan.steps).toHaveLength(2);
		expect(plan.expected_total_bits).toBeCloseTo(2, 5);
		expect(plan.stop_reason).toBe("resolved");
	});

	test("a budget stops the plan and says so", () => {
		const plan = planSequence(FOUR, splitters(), 1);
		expect(plan.steps).toHaveLength(1);
		expect(plan.stop_reason).toBe("budget_exhausted");
		expect(plan.total_cost).toBe(1);
	});

	test("the greedy caveat always travels with the plan", () => {
		expect(planSequence(FOUR, splitters(), 10).caveats[0]).toContain("greedy");
	});

	test("a catalogue of useless experiments stops with the right reason", () => {
		const plan = planSequence(TWO, [useless(), useless({ id: "useless2" })], 100);
		expect(plan.steps).toEqual([]);
		expect(plan.stop_reason).toBe("no_informative_experiment");
		expect(plan.caveats.some((c) => c.includes("catalogue, not the budget"))).toBe(true);
	});

	test("the risk ceiling is enforced and named", () => {
		const plan = planSequence(TWO, [decisive({ risk: "destructive" })], 100, {
			max_risk: "reversible",
		});
		expect(plan.steps).toEqual([]);
		expect(plan.stop_reason).toBe("risk_ceiling_reached");
		expect(plan.caveats.some((c) => c.includes("may be answerable only by one of them"))).toBe(
			true,
		);
	});

	test("raising the ceiling admits the risky experiment", () => {
		const plan = planSequence(TWO, [decisive({ risk: "destructive" })], 100, {
			max_risk: "destructive",
		});
		expect(plan.steps).toHaveLength(1);
	});

	test("an already-resolved belief plans nothing", () => {
		const plan = planSequence({ a: 0.99, b: 0.01 }, splitters(), 100);
		expect(plan.steps).toEqual([]);
		expect(plan.stop_reason).toBe("resolved");
	});

	test("no experiment is scheduled twice", () => {
		const plan = planSequence(FOUR, splitters(), 100);
		expect(new Set(plan.steps.map((s) => s.experiment.id)).size).toBe(plan.steps.length);
	});

	test("cumulative cost and residual entropy are tracked per step", () => {
		const plan = planSequence(FOUR, splitters(), 100);
		expect(plan.steps[0].cumulative_cost).toBe(1);
		expect(plan.steps[1].cumulative_cost).toBe(2);
		expect(plan.steps[1].expected_posterior_entropy).toBeLessThan(
			plan.steps[0].expected_posterior_entropy,
		);
		expect(plan.expected_residual_entropy).toBeCloseTo(0, 5);
	});

	test("an empty catalogue stops immediately", () => {
		const plan = planSequence(FOUR, [], 100);
		expect(plan.stop_reason).toBe("catalogue_exhausted");
		expect(plan.expected_residual_entropy).toBeCloseTo(2, 5);
	});
});

describe("joint information gain", () => {
	/** Two experiments that each split four hypotheses on a different axis. */
	function axis(id: string, hi: string[]): Experiment {
		const likelihoods: Experiment["likelihoods"] = {};
		for (const h of ["a", "b", "c", "d"]) {
			likelihoods[h] = hi.includes(h) ? { hi: 1, lo: 0 } : { hi: 0, lo: 1 };
		}
		return {
			id,
			description: id,
			risk: "observational",
			cost: 1,
			outcomes: ["hi", "lo"],
			likelihoods,
		};
	}

	test("two orthogonal splits jointly resolve four hypotheses", () => {
		const joint = jointInformationGain(FOUR, [axis("x", ["a", "b"]), axis("y", ["a", "c"])]);
		expect(joint).toBeCloseTo(2, 5);
	});

	test("the average posterior equals the prior, which is why joint gain is needed", () => {
		// The pitfall this formulation exists to avoid: advancing a belief by its
		// expected posterior leaves it exactly where it started.
		const experiment = axis("x", ["a", "b"]);
		const marginal = outcomeDistribution(FOUR, experiment);
		const averaged: Belief = { a: 0, b: 0, c: 0, d: 0 };
		for (const [outcome, p] of Object.entries(marginal)) {
			const { posterior } = updateBelief(FOUR, experiment, outcome);
			for (const [h, v] of Object.entries(posterior)) averaged[h] += p * v;
		}
		for (const h of Object.keys(FOUR)) expect(averaged[h]).toBeCloseTo(FOUR[h], 10);
	});

	test("a duplicate experiment adds nothing to the set", () => {
		const one = jointInformationGain(FOUR, [axis("x", ["a", "b"])]);
		const twice = jointInformationGain(FOUR, [axis("x", ["a", "b"]), axis("x2", ["a", "b"])]);
		expect(twice).toBeCloseTo(one, 10);
	});

	test("the empty set gains nothing", () => {
		expect(jointInformationGain(FOUR, [])).toBe(0);
	});

	test("an oversized joint space returns NaN rather than enumerating it", () => {
		const wide = Array.from({ length: 20 }, (_, i) => axis(`x${i}`, ["a"]));
		expect(Number.isNaN(jointInformationGain(FOUR, wide))).toBe(true);
	});

	test("the planner therefore does not schedule a redundant experiment", () => {
		const plan = planSequence(FOUR, [axis("x", ["a", "b"]), axis("x2", ["a", "b"])], 100);
		expect(plan.steps).toHaveLength(1);
		expect(plan.stop_reason).toBe("no_informative_experiment");
	});
});
