import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STOPPING_POLICY,
	type InvestigationState,
	REASON_CLASSIFICATION,
	STOP_REASONS,
	shortfall,
	shouldStop,
	replay,
} from "../../src/diagnosis/stopping.js";

function state(overrides: Partial<InvestigationState> = {}): InvestigationState {
	return {
		steps: 5,
		elapsed_ms: 1000,
		tokens_spent: 100,
		actions_taken: 3,
		leading_confidence: 0.5,
		residual: 0.2,
		step_gains: [0.5, 0.4, 0.3],
		remaining_actions: [{ id: "probe", risk: "observational", expected_bits: 0.5 }],
		...overrides,
	};
}

describe("resolved is reachable by exactly one path", () => {
	test("only confidence_reached classifies as resolved", () => {
		const resolved = STOP_REASONS.filter((r) => REASON_CLASSIFICATION[r] === "resolved");
		expect(resolved).toEqual(["confidence_reached"]);
	});

	test("every reason has a classification", () => {
		for (const reason of STOP_REASONS) {
			expect(REASON_CLASSIFICATION[reason]).toBeDefined();
		}
	});

	test("reaching the target after enough steps resolves", () => {
		const decision = shouldStop(state({ leading_confidence: 0.9, steps: 5 }));
		expect(decision.reason).toBe("confidence_reached");
		expect(decision.classification).toBe("resolved");
		expect(decision.stop).toBe(true);
		expect(decision.unblock).toBeUndefined();
	});
});

describe("exhaustion is never reported as success", () => {
	test("an exhausted token budget says the hypothesis was NOT confirmed", () => {
		const decision = shouldStop(
			state({ tokens_spent: 999_999, leading_confidence: 0.9, steps: 10 }),
		);
		expect(decision.reason).toBe("budget_exhausted");
		expect(decision.classification).toBe("exhausted");
		expect(decision.summary).toContain("NOT been confirmed");
	});

	test("exhaustion outranks confidence, so the budget stays visible", () => {
		// Both true at once: the run got there partly by luck of scheduling.
		const decision = shouldStop(
			state({ tokens_spent: 60_000, leading_confidence: 0.99, steps: 20 }),
		);
		expect(decision.classification).toBe("exhausted");
	});

	test("time and action limits are separate, named reasons", () => {
		expect(shouldStop(state({ elapsed_ms: 10 ** 9 })).reason).toBe("time_exhausted");
		expect(shouldStop(state({ actions_taken: 999 })).reason).toBe("action_limit_reached");
	});

	test("every exhaustion reason offers a way to raise the limit", () => {
		for (const s of [
			state({ tokens_spent: 999_999 }),
			state({ elapsed_ms: 10 ** 9 }),
			state({ actions_taken: 999 }),
		]) {
			expect(shouldStop(s).unblock).toContain("raise");
		}
	});
});

describe("high confidence after no work is not a result", () => {
	test("a shallow high-confidence run continues rather than resolving", () => {
		const decision = shouldStop(state({ leading_confidence: 0.95, steps: 1 }));
		expect(decision.reason).toBe("confident_but_unexamined");
		expect(decision.classification).toBe("continue");
		expect(decision.stop).toBe(false);
	});

	test("the summary names the prior as the thing being reported back", () => {
		const decision = shouldStop(state({ leading_confidence: 0.95, steps: 0 }));
		expect(decision.summary).toContain("this is the prior, not a finding");
	});

	test("it says how many more steps are needed", () => {
		const decision = shouldStop(state({ leading_confidence: 0.95, steps: 1 }));
		expect(decision.unblock).toContain(`${DEFAULT_STOPPING_POLICY.min_steps - 1} more step`);
	});

	test("at exactly the minimum, confidence resolves", () => {
		const decision = shouldStop(
			state({ leading_confidence: 0.95, steps: DEFAULT_STOPPING_POLICY.min_steps }),
		);
		expect(decision.reason).toBe("confidence_reached");
	});

	test("the minimum is configurable to zero for callers who mean it", () => {
		const decision = shouldStop(state({ leading_confidence: 0.95, steps: 0 }), {
			...DEFAULT_STOPPING_POLICY,
			min_steps: 0,
		});
		expect(decision.reason).toBe("confidence_reached");
	});
});

describe("diminishing returns are measured over a window", () => {
	test("one flat step does not stop the investigation", () => {
		const decision = shouldStop(state({ step_gains: [0.5, 0.4, 0.0] }));
		expect(decision.reason).toBe("continue");
	});

	test("a flat window does stop it", () => {
		const decision = shouldStop(state({ step_gains: [0.5, 0.01, 0.0, 0.02] }));
		expect(decision.reason).toBe("diminishing_returns");
		expect(decision.classification).toBe("exhausted");
	});

	test("the actual gains are recorded in the observations", () => {
		const decision = shouldStop(state({ step_gains: [0.01, 0.0, 0.02] }));
		expect(decision.observations.some((o) => o.includes("bits"))).toBe(true);
	});

	test("the advice is to change approach, not to spend more", () => {
		const decision = shouldStop(state({ step_gains: [0.01, 0.0, 0.02] }));
		expect(decision.unblock).toContain("change approach");
	});

	test("too few steps to fill the window cannot trigger the rule", () => {
		const decision = shouldStop(state({ step_gains: [0.0] }));
		expect(decision.reason).toBe("continue");
	});
});

describe("blocked is not exhausted", () => {
	test("informative actions above the ceiling produce a blocked verdict", () => {
		const decision = shouldStop(
			state({
				remaining_actions: [{ id: "restart-db", risk: "destructive", expected_bits: 1.5 }],
			}),
		);
		expect(decision.reason).toBe("risk_ceiling_blocks_progress");
		expect(decision.classification).toBe("blocked");
		expect(decision.summary).toContain("answerable but not under the current authorization");
	});

	test("the tier that would unblock it is named", () => {
		const decision = shouldStop(
			state({
				remaining_actions: [
					{ id: "restart-db", risk: "destructive", expected_bits: 1.5 },
					{ id: "restart-worker", risk: "disruptive", expected_bits: 1.0 },
				],
			}),
		);
		expect(decision.unblock).toContain("disruptive");
	});

	test("raising the ceiling unblocks it", () => {
		const blocked = state({
			remaining_actions: [{ id: "restart", risk: "disruptive", expected_bits: 1.5 }],
		});
		expect(
			shouldStop(blocked, { ...DEFAULT_STOPPING_POLICY, max_risk: "disruptive" }).reason,
		).toBe("continue");
	});

	test("uninformative blocked actions do not produce a blocked verdict", () => {
		// There is nothing worth authorizing, so the honest answer is exhaustion.
		const decision = shouldStop(
			state({ remaining_actions: [{ id: "x", risk: "destructive", expected_bits: 0.001 }] }),
		);
		expect(decision.reason).toBe("no_informative_action");
	});

	test("no actions at all is exhaustion with advice to widen the catalogue", () => {
		const decision = shouldStop(state({ remaining_actions: [] }));
		expect(decision.reason).toBe("no_informative_action");
		expect(decision.unblock).toContain("catalogue");
	});
});

describe("continuing", () => {
	test("an ordinary mid-investigation state continues", () => {
		const decision = shouldStop(state());
		expect(decision.stop).toBe(false);
		expect(decision.reason).toBe("continue");
		expect(decision.summary).toContain("informative action");
	});

	test("observations always record the resource position and the belief", () => {
		const decision = shouldStop(state());
		expect(decision.observations[0]).toContain("tokens");
		expect(decision.observations[1]).toContain("residual");
	});
});

describe("replay", () => {
	test("a run that resolves stops at the resolving state", () => {
		const trace = replay([
			state({ steps: 1, leading_confidence: 0.3 }),
			state({ steps: 2, leading_confidence: 0.6 }),
			state({ steps: 3, leading_confidence: 0.9 }),
			state({ steps: 4, leading_confidence: 0.95 }),
		]);
		expect(trace.decisions).toHaveLength(3);
		expect(trace.resolved).toBe(true);
	});

	test("a run that exhausts is not marked resolved", () => {
		const trace = replay([
			state({ leading_confidence: 0.3 }),
			state({ leading_confidence: 0.4, tokens_spent: 10 ** 6 }),
		]);
		expect(trace.resolved).toBe(false);
		expect(trace.final.classification).toBe("exhausted");
	});

	test("a shallow high-confidence state does not end the replay", () => {
		const trace = replay([
			state({ steps: 1, leading_confidence: 0.95 }),
			state({ steps: 2, leading_confidence: 0.95 }),
			state({ steps: 3, leading_confidence: 0.95 }),
		]);
		expect(trace.decisions).toHaveLength(3);
		expect(trace.resolved).toBe(true);
	});
});

describe("shortfall", () => {
	test("a resolved run has no shortfall to report", () => {
		const s = state({ leading_confidence: 0.9, steps: 5 });
		expect(shortfall(shouldStop(s), s)).toBeNull();
	});

	test("a near miss with a concentrated belief is worth extending", () => {
		const s = state({ leading_confidence: 0.8, residual: 0.05, tokens_spent: 10 ** 6 });
		const result = shortfall(shouldStop(s), s)!;
		expect(result.gap).toBeCloseTo(0.05, 5);
		expect(result.worth_extending).toBe(true);
	});

	test("a distant miss is not worth extending", () => {
		const s = state({ leading_confidence: 0.2, residual: 0.1, tokens_spent: 10 ** 6 });
		expect(shortfall(shouldStop(s), s)!.worth_extending).toBe(false);
	});

	test("a near miss with a dominant residual is not worth extending either", () => {
		// The answer is probably not among the candidates; more budget on the
		// same candidates buys nothing.
		const s = state({ leading_confidence: 0.8, residual: 0.6, tokens_spent: 10 ** 6 });
		expect(shortfall(shouldStop(s), s)!.worth_extending).toBe(false);
	});
});
