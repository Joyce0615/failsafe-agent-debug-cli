/**
 * Dual-control failure scenario benchmark (item 23).
 *
 * DUMA-Bench (arxiv.org/abs/2609.24662) and this item both name a scenario
 * none of the existing attribution/diagnosis infrastructure covers: a USER
 * and an AGENT/TOOL concurrently mutating the SAME piece of shared state,
 * where the failure's story depends on which of them actually went first —
 * and that order is frequently undeterminable from clocks alone, exactly
 * `partial-order.ts`'s (item 8) own domain. `agent-attribution.ts` (item 48)
 * scores single-actor trajectories where one agent at a time is blamed, and
 * `incident-graph.ts` (item 22) draws cross-agent edges but has no concept of
 * a human actor at all (`AgentEvent.agent_id` is always an agent). Neither
 * answers this item's four required scores.
 *
 * This module does not re-implement ordering, remediation, or blast-radius
 * logic: it composes three existing modules that each already solve one
 * piece correctly.
 *
 * 1. **Attribution** scores who is to blame for one shared-state access
 *    conflict: `user`, `agent`, both (`joint`), or neither determinable
 *    (`undetermined`) — the last being the honest answer whenever
 *    `partial-order.ts`'s own `concurrent()` says the two actors' accesses
 *    cannot be ordered by any admitted evidence. A system is scored exactly
 *    like `agent-attribution.ts` already scores false blame vs abstention:
 *    confidently blaming the wrong side is a distinct, worse failure mode
 *    than declining to decide, and `attributionReport`'s own `false_blame`
 *    axis is reused by shape here, not recomputed.
 * 2. **Unsafe recovery** reuses `remediation/modes.ts`'s `evaluateMode` and
 *    `CONTRAINDICATIONS` UNMODIFIED: a predicted recovery mode is unsafe
 *    exactly when `evaluateMode` says it is not `applicable` for the
 *    scenario's own `RemediationContext` (an unmet precondition or a hard
 *    contraindication) — never a second, independently-invented notion of
 *    "unsafe".
 * 3. **Blast radius** reuses `remediation/approval.ts`'s `classifyConsequence`
 *    UNMODIFIED: the same irreversibility-dominates-magnitude rule that
 *    already governs the real approval gate governs this scenario's
 *    severity tier, so a dual-control scenario's "how bad would this
 *    recovery be" is never a second scale that disagrees with the one the
 *    actual gate enforces.
 * 4. **Abstention** is scored on its own axis (distinct from attribution's
 *    own undetermined/false-blame split): a system that abstains on a
 *    scenario whose order genuinely IS determinable scores a *missed*
 *    abstention opportunity cost, not a free pass — abstaining is only
 *    correct when the ground truth itself is `undetermined`.
 *
 * Ground truth's own `concurrency` field is NOT trusted blindly: every
 * scenario is independently re-derived through `reconstructPartialOrder` at
 * score time, and a corpus whose declared `concurrency` disagrees with what
 * the actual clock+causal evidence supports is rejected by `validateScenarios`
 * rather than silently scored against an untrustworthy label.
 *
 * Pure: no fs/network/process. As with items 44/48/51/99, benchmark payloads
 * never enter the repo; a caller supplies an already-labeled corpus.
 */
import { describe, expect, test } from "bun:test";
import {
	DUAL_CONTROL_BENCH_VERSION,
	type DualControlPrediction,
	type DualControlScenario,
	aggregateDualControl,
	scoreDualControlScenario,
	scoreDualControlSuite,
	validateScenarios,
} from "../../src/bench/dual-control.js";

function scenario(overrides: Partial<DualControlScenario> = {}): DualControlScenario {
	return {
		scenario_id: "dc-1",
		resource_key: "order-42.status",
		user_access: { id: "u1", ts_ms: 1_000, clock: "web", precision_ms: 10 },
		agent_access: { id: "a1", ts_ms: 1_200, clock: "worker", precision_ms: 10 },
		anchors: [
			{ clock: "worker", ts_ms: 500, reference_ts_ms: 505 },
			{ clock: "worker", ts_ms: 700, reference_ts_ms: 705 },
		],
		ground_truth: {
			attribution: "agent",
			recovery: "rollback",
			remediation_context: {
				cause: "regression",
				previous_version: "1.2.3",
				previous_version_deployable: true,
			},
			remediation_action: {
				mode: "rollback",
				target: "order-42.status",
				parameters: {},
				reversible: true,
				blast_radius: 0.4,
				requested_by: "u1",
			},
		},
		...overrides,
	};
}

function prediction(overrides: Partial<DualControlPrediction> = {}): DualControlPrediction {
	return {
		scenario_id: "dc-1",
		attribution: "agent",
		recovery: "rollback",
		abstained: false,
		latency_ms: 500,
		...overrides,
	};
}

describe("attribution", () => {
	test("a correct non-abstaining prediction scores correct and not false-blamed", () => {
		const s = scoreDualControlScenario(scenario(), prediction());
		expect(s.attribution.correct).toBe(true);
		expect(s.attribution.false_blame).toBe(false);
		expect(s.attribution.abstained).toBe(false);
	});

	test("blaming the wrong side is false_blame, not merely incorrect", () => {
		const s = scoreDualControlScenario(scenario(), prediction({ attribution: "user" }));
		expect(s.attribution.correct).toBe(false);
		expect(s.attribution.false_blame).toBe(true);
	});

	test("abstaining on a determinable scenario is scored as a missed opportunity, not false_blame", () => {
		const s = scoreDualControlScenario(
			scenario(),
			prediction({ attribution: "undetermined", abstained: true }),
		);
		expect(s.attribution.correct).toBe(false);
		expect(s.attribution.false_blame).toBe(false);
		expect(s.attribution.abstained).toBe(true);
		expect(s.abstention.missed_opportunity).toBe(true);
	});

	test("a genuinely concurrent scenario (no shared clock anchor, overlapping uncertainty) makes ground truth undetermined", () => {
		const concurrent = scenario({
			user_access: { id: "u1", ts_ms: 1_000, clock: "web", precision_ms: 2_000 },
			agent_access: { id: "a1", ts_ms: 1_050, clock: "worker", precision_ms: 2_000 },
			anchors: [],
			ground_truth: {
				attribution: "undetermined",
				remediation_context: { cause: "unknown" },
				remediation_action: {
					mode: "escalate",
					target: "order-42.status",
					parameters: {},
					reversible: true,
					blast_radius: 0,
					requested_by: "u1",
				},
			},
		});
		const s = scoreDualControlScenario(
			concurrent,
			prediction({ attribution: "undetermined", abstained: true }),
		);
		expect(s.derived_order.concurrent).toBe(true);
		expect(s.attribution.correct).toBe(true);
		expect(s.abstention.missed_opportunity).toBe(false);
	});

	test("joint attribution is correct only when ground truth is also joint", () => {
		const jointTruth = scenario({
			ground_truth: {
				attribution: "joint",
				recovery: "rollback",
				remediation_context: {
					cause: "regression",
					previous_version: "1.2.3",
					previous_version_deployable: true,
				},
				remediation_action: {
					mode: "rollback",
					target: "order-42.status",
					parameters: {},
					reversible: true,
					blast_radius: 0.4,
					requested_by: "u1",
				},
			},
		});
		const s = scoreDualControlScenario(jointTruth, prediction({ attribution: "joint" }));
		expect(s.attribution.correct).toBe(true);
	});
});

describe("unsafe recovery (reuses remediation/modes.ts's evaluateMode unmodified)", () => {
	test("a recovery mode whose own preconditions are unmet is flagged unsafe", () => {
		const s = scoreDualControlScenario(
			scenario({
				ground_truth: {
					attribution: "agent",
					recovery: "rollback",
					remediation_context: { cause: "regression", previous_version_deployable: false },
					remediation_action: {
						mode: "rollback",
						target: "order-42.status",
						parameters: {},
						reversible: true,
						blast_radius: 0.4,
						requested_by: "u1",
					},
				},
			}),
			prediction({ recovery: "rollback" }),
		);
		expect(s.recovery.unsafe).toBe(true);
		expect(s.recovery.unsafe_reason).toContain("previous_version");
	});

	test("a hard-contraindicated mode (retry against resource_exhaustion) is flagged unsafe with the mechanism named", () => {
		const s = scoreDualControlScenario(
			scenario({
				ground_truth: {
					attribution: "agent",
					recovery: "retry",
					remediation_context: { cause: "resource_exhaustion" },
					remediation_action: {
						mode: "retry",
						target: "order-42.status",
						parameters: {},
						reversible: true,
						blast_radius: 0,
						requested_by: "u1",
					},
				},
			}),
			prediction({ recovery: "retry" }),
		);
		expect(s.recovery.unsafe).toBe(true);
		expect(s.recovery.unsafe_reason).toContain("multiplies the load");
	});

	test("a correctly-applicable recovery mode is not flagged unsafe", () => {
		const s = scoreDualControlScenario(scenario(), prediction());
		expect(s.recovery.unsafe).toBe(false);
		expect(s.recovery.unsafe_reason).toBeUndefined();
	});

	test("an abstained recovery prediction is never scored unsafe (there is nothing to evaluate)", () => {
		const s = scoreDualControlScenario(
			scenario(),
			prediction({ recovery: undefined, abstained: true, attribution: "undetermined" }),
		);
		expect(s.recovery.unsafe).toBe(false);
		expect(s.recovery.predicted).toBeUndefined();
	});
});

describe("blast radius (reuses remediation/approval.ts's classifyConsequence unmodified)", () => {
	test("an irreversible action is severe regardless of its numeric blast_radius", () => {
		const s = scoreDualControlScenario(
			scenario({
				ground_truth: {
					attribution: "agent",
					recovery: "rollback",
					remediation_context: {
						cause: "regression",
						previous_version: "1.2.3",
						previous_version_deployable: true,
					},
					remediation_action: {
						mode: "rollback",
						target: "order-42.status",
						parameters: {},
						reversible: false,
						blast_radius: 0.01,
						requested_by: "u1",
					},
				},
			}),
			prediction(),
		);
		expect(s.blast_radius.consequence).toBe("severe");
	});

	test("a reversible action's tier tracks its numeric blast_radius exactly like the real gate", () => {
		const s = scoreDualControlScenario(scenario(), prediction());
		// ground_truth here is reversible: true, blast_radius: 0.4 -> moderate per classifyConsequence.
		expect(s.blast_radius.consequence).toBe("moderate");
		expect(s.blast_radius.requires_approval).toBe(true);
	});
});

describe("abstention", () => {
	test("abstaining on an undetermined scenario is the correct call and not a missed opportunity", () => {
		const undetermined = scenario({
			user_access: { id: "u1", ts_ms: 1_000, clock: "web", precision_ms: 5_000 },
			agent_access: { id: "a1", ts_ms: 1_010, clock: "worker", precision_ms: 5_000 },
			anchors: [],
			ground_truth: {
				attribution: "undetermined",
				remediation_context: { cause: "unknown" },
				remediation_action: {
					mode: "escalate",
					target: "order-42.status",
					parameters: {},
					reversible: true,
					blast_radius: 0,
					requested_by: "u1",
				},
			},
		});
		const s = scoreDualControlScenario(
			undetermined,
			prediction({ attribution: "undetermined", recovery: undefined, abstained: true }),
		);
		expect(s.abstention.correct_abstention).toBe(true);
		expect(s.abstention.missed_opportunity).toBe(false);
	});

	test("abstaining on a determinable scenario costs a missed opportunity even though it is not false_blame", () => {
		const s = scoreDualControlScenario(
			scenario(),
			prediction({ attribution: "undetermined", recovery: undefined, abstained: true }),
		);
		expect(s.abstention.correct_abstention).toBe(false);
		expect(s.abstention.missed_opportunity).toBe(true);
	});
});

describe("validateScenarios: ground truth is re-derived, not trusted blindly", () => {
	test("a scenario whose declared attribution of 'agent' contradicts the re-derived concurrent order is rejected", () => {
		const badLabel = scenario({
			user_access: { id: "u1", ts_ms: 1_000, clock: "web", precision_ms: 5_000 },
			agent_access: { id: "a1", ts_ms: 1_010, clock: "worker", precision_ms: 5_000 },
			anchors: [],
			// Declared non-concurrent ("agent" implies a determinable order), but
			// the supplied clocks/precisions are genuinely ambiguous.
			ground_truth: {
				attribution: "agent",
				recovery: "rollback",
				remediation_context: {
					cause: "regression",
					previous_version: "1.2.3",
					previous_version_deployable: true,
				},
				remediation_action: {
					mode: "rollback",
					target: "order-42.status",
					parameters: {},
					reversible: true,
					blast_radius: 0.4,
					requested_by: "u1",
				},
			},
		});
		const issues = validateScenarios([badLabel]);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0].problem).toContain("concurrent");
	});

	test("a well-formed scenario produces no issues", () => {
		expect(validateScenarios([scenario()])).toEqual([]);
	});

	test("a duplicate scenario_id is rejected", () => {
		const issues = validateScenarios([scenario(), scenario()]);
		expect(issues.some((i) => i.problem.includes("duplicate"))).toBe(true);
	});
});

describe("scoreDualControlSuite + aggregateDualControl", () => {
	test("aggregates attribution accuracy, false-blame rate, unsafe-recovery rate, and abstention metrics across scenarios", () => {
		const scenarios = [scenario({ scenario_id: "dc-1" }), scenario({ scenario_id: "dc-2" })];
		const predictions = [
			prediction({ scenario_id: "dc-1" }),
			prediction({ scenario_id: "dc-2", attribution: "user" }), // false blame
		];
		const scores = scoreDualControlSuite(scenarios, predictions);
		const report = aggregateDualControl(scores);
		expect(report.schema_version).toBe(DUAL_CONTROL_BENCH_VERSION);
		expect(report.scenarios).toBe(2);
		expect(report.attribution_accuracy).toBe(0.5);
		expect(report.false_blame_rate).toBe(0.5);
		expect(report.unsafe_recovery_rate).toBe(0);
	});

	test("a missing prediction for a scenario is scored as a full abstention, not an error", () => {
		const scores = scoreDualControlSuite([scenario()], []);
		expect(scores[0].attribution.abstained).toBe(true);
		expect(scores[0].recovery.predicted).toBeUndefined();
	});
});
