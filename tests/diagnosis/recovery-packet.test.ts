/**
 * Failure-anchored structured recovery packets (item 17 / module docstring
 * item 100).
 *
 * Pins down this item's four requirements: extract the first decisive
 * failure (anchored to `causal-graph.ts`'s own uncertainty signals, not a
 * new heuristic), preserve causal evidence immutably, propose bounded
 * recovery that never expands the existing command allow-list, and measure
 * whether a rerun improved while explicitly flagging when that measurement
 * is tainted by an authority expansion.
 */
import { describe, expect, test } from "bun:test";
import {
	type CausalEdge,
	type CausalNode,
	buildCausalGraph,
} from "../../src/diagnosis/causal-graph.js";
import { rankRootCauses } from "../../src/diagnosis/causal-graph.js";
import {
	DEFAULT_MAX_PATCH_LINES,
	type RecoveryAction,
	buildRecoveryPacket,
	extractFirstDecisiveFailure,
	measureRerunImprovement,
	preserveCausalEvidence,
	proposeBoundedRecovery,
	renderRecoveryPacket,
} from "../../src/diagnosis/recovery-packet.js";
import type { CommandPolicy } from "../../src/security/policy.js";

function cascadeRanking() {
	const nodes: CausalNode[] = [
		{ id: "svc", kind: "service", status: "failed", ts: 1, message: "DB pool exhausted" },
		{ id: "tool", kind: "tool", status: "failed", ts: 2, message: "query timeout" },
		{ id: "agent", kind: "agent", status: "failed", ts: 3, message: "task aborted" },
	];
	const edges: CausalEdge[] = [
		{ from: "svc", to: "tool", type: "causes" },
		{ from: "tool", to: "agent", type: "causes" },
	];
	return rankRootCauses(buildCausalGraph(nodes, edges));
}

function isolatedRanking() {
	const nodes: CausalNode[] = [
		{ id: "lonely", kind: "tool", status: "failed", ts: 1, message: "no correlation available" },
	];
	return rankRootCauses(buildCausalGraph(nodes, []));
}

function independentChainsRanking() {
	const nodes: CausalNode[] = [
		{ id: "a1", kind: "service", status: "failed", ts: 1, message: "chain A root" },
		{ id: "a2", kind: "tool", status: "failed", ts: 2, message: "chain A symptom" },
		{ id: "b1", kind: "service", status: "failed", ts: 3, message: "chain B root" },
		{ id: "b2", kind: "tool", status: "failed", ts: 4, message: "chain B symptom" },
	];
	const edges: CausalEdge[] = [
		{ from: "a1", to: "a2", type: "causes" },
		{ from: "b1", to: "b2", type: "causes" },
	];
	return rankRootCauses(buildCausalGraph(nodes, edges));
}

const basePolicy: CommandPolicy = {
	allow_commands: ["npm", "bun", "node"],
	deny_patterns: [/rm -rf \//],
	timeout_seconds: 60,
};

// ── 1. Extract the first decisive failure ──

describe("extractFirstDecisiveFailure", () => {
	test("a fully-correlated single chain is decisive and anchors to the earliest root", () => {
		const result = extractFirstDecisiveFailure(cascadeRanking());
		expect(result.decisive).toBe(true);
		if (result.decisive) {
			expect(result.failure.node_id).toBe("svc");
		}
	});

	test("an empty ranking (no root causes) is not decisive", () => {
		const result = extractFirstDecisiveFailure({ root_causes: [], uncertainty: [] });
		expect(result).toEqual({
			decisive: false,
			reason: expect.stringContaining("no root cause"),
			candidates: [],
		});
	});

	test("an isolated top-ranked failure with no correlated causal edges is not decisive", () => {
		const result = extractFirstDecisiveFailure(isolatedRanking());
		expect(result.decisive).toBe(false);
		if (!result.decisive) {
			expect(result.reason).toContain("no correlated causal evidence");
			expect(result.candidates).toHaveLength(1);
		}
	});

	test("multiple independent failure chains make the top root not decisive", () => {
		const result = extractFirstDecisiveFailure(independentChainsRanking());
		expect(result.decisive).toBe(false);
		if (!result.decisive) {
			expect(result.reason).toContain("independent failure chains");
		}
	});
});

// ── 2. Preserve causal evidence ──

describe("preserveCausalEvidence", () => {
	test("snapshots the exact evidence_path from the root cause", () => {
		const result = extractFirstDecisiveFailure(cascadeRanking());
		expect(result.decisive).toBe(true);
		if (!result.decisive) throw new Error("unreachable");
		const snapshot = preserveCausalEvidence(result.failure);
		expect(snapshot.root_node_id).toBe("svc");
		expect(snapshot.evidence_path).toEqual(["svc", "tool", "agent"]);
		expect(snapshot.downstream_failures).toBe(2);
	});

	test("the snapshot's evidence_path is frozen and independent of the source array", () => {
		const result = extractFirstDecisiveFailure(cascadeRanking());
		if (!result.decisive) throw new Error("unreachable");
		const original = result.failure.evidence_path;
		const snapshot = preserveCausalEvidence(result.failure);
		// Mutate the ORIGINAL array the ranking returned.
		original.push("tampered");
		// The snapshot must be unaffected -- it copied, it did not reference.
		expect(snapshot.evidence_path).toEqual(["svc", "tool", "agent"]);
		expect(() => {
			// Frozen array: pushing in strict mode throws rather than silently no-op'ing.
			(snapshot.evidence_path as string[]).push("should-throw-or-noop");
		}).toThrow();
	});
});

// ── 3. Propose bounded recovery ──

describe("proposeBoundedRecovery", () => {
	test("accepts a command action already within the existing allow-list", () => {
		const failure = extractFirstDecisiveFailure(cascadeRanking());
		const actions: RecoveryAction[] = [
			{ kind: "command", command: "npm test", rationale: "re-run the suite" },
		];
		const result = proposeBoundedRecovery(failure, actions, basePolicy);
		expect(result.accepted).toEqual(actions);
		expect(result.rejected).toEqual([]);
	});

	test("rejects a command action NOT in the existing allow-list, never auto-adding it", () => {
		const failure = extractFirstDecisiveFailure(cascadeRanking());
		const actions: RecoveryAction[] = [
			{ kind: "command", command: "sudo systemctl restart db", rationale: "restart the DB" },
		];
		const result = proposeBoundedRecovery(failure, actions, basePolicy);
		expect(result.accepted).toEqual([]);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0].reason).toContain("expanding tool authority");
		// Confirm the policy itself was never mutated to accommodate the action.
		expect(basePolicy.allow_commands).toEqual(["npm", "bun", "node"]);
	});

	test("accepts a patch action under the default line-count bound", () => {
		const failure = extractFirstDecisiveFailure(cascadeRanking());
		const diff = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join("\n");
		const actions: RecoveryAction[] = [{ kind: "patch", diff, rationale: "small fix" }];
		const result = proposeBoundedRecovery(failure, actions, basePolicy);
		expect(result.accepted).toEqual(actions);
	});

	test("rejects a patch action that exceeds the line-count bound", () => {
		const failure = extractFirstDecisiveFailure(cascadeRanking());
		const diff = Array.from({ length: DEFAULT_MAX_PATCH_LINES + 50 }, (_, i) => `+line ${i}`).join(
			"\n",
		);
		const actions: RecoveryAction[] = [{ kind: "patch", diff, rationale: "huge rewrite" }];
		const result = proposeBoundedRecovery(failure, actions, basePolicy);
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0].reason).toContain("exceeding");
	});

	test("a custom maxPatchLines option is honored", () => {
		const failure = extractFirstDecisiveFailure(cascadeRanking());
		const diff = Array.from({ length: 5 }, (_, i) => `+line ${i}`).join("\n");
		const actions: RecoveryAction[] = [{ kind: "patch", diff, rationale: "fix" }];
		const result = proposeBoundedRecovery(failure, actions, basePolicy, { maxPatchLines: 3 });
		expect(result.accepted).toEqual([]);
	});

	test("refuses to propose ANY action when the failure was not decisive", () => {
		const failure = extractFirstDecisiveFailure(isolatedRanking());
		const actions: RecoveryAction[] = [
			{ kind: "command", command: "npm test", rationale: "re-run the suite" },
		];
		const result = proposeBoundedRecovery(failure, actions, basePolicy);
		expect(result.accepted).toEqual([]);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0].reason).toContain("no decisive failure");
	});

	test("mixed accept/reject: command within policy accepted, oversized patch rejected, in one call", () => {
		const failure = extractFirstDecisiveFailure(cascadeRanking());
		const bigDiff = Array.from({ length: DEFAULT_MAX_PATCH_LINES + 1 }, (_, i) => `+${i}`).join(
			"\n",
		);
		const actions: RecoveryAction[] = [
			{ kind: "command", command: "bun test", rationale: "re-run" },
			{ kind: "patch", diff: bigDiff, rationale: "too big" },
		];
		const result = proposeBoundedRecovery(failure, actions, basePolicy);
		expect(result.accepted).toHaveLength(1);
		expect(result.accepted[0]).toEqual(actions[0]);
		expect(result.rejected).toHaveLength(1);
	});
});

// ── 4. Measure rerun improvement without expanding tool authority ──

describe("measureRerunImprovement", () => {
	test("reports a genuine improvement as valid when the policy did not change", () => {
		const report = measureRerunImprovement({
			policyBefore: basePolicy,
			policyAfter: basePolicy,
			rerunsBefore: ["failed", "failed", "failed"],
			rerunsAfter: ["passed", "passed", "failed"],
		});
		expect(report.before_pass_rate).toBe(0);
		expect(report.after_pass_rate).toBeCloseTo(2 / 3);
		expect(report.improved).toBe(true);
		expect(report.authority_expanded).toBe(false);
		expect(report.valid).toBe(true);
	});

	test("flags an apparent improvement as tainted when the allow-list grew between reruns", () => {
		const expandedPolicy: CommandPolicy = {
			...basePolicy,
			allow_commands: [...basePolicy.allow_commands, "sudo"],
		};
		const report = measureRerunImprovement({
			policyBefore: basePolicy,
			policyAfter: expandedPolicy,
			rerunsBefore: ["failed", "failed"],
			rerunsAfter: ["passed", "passed"],
		});
		expect(report.improved).toBe(true);
		expect(report.authority_expanded).toBe(true);
		expect(report.newly_allowed_commands).toEqual(["sudo"]);
		expect(report.valid).toBe(false);
	});

	test("a policy that only shrinks (never grows) the allow-list is not flagged as expanded", () => {
		const shrunkPolicy: CommandPolicy = {
			...basePolicy,
			allow_commands: ["npm"],
		};
		const report = measureRerunImprovement({
			policyBefore: basePolicy,
			policyAfter: shrunkPolicy,
			rerunsBefore: ["failed"],
			rerunsAfter: ["passed"],
		});
		expect(report.authority_expanded).toBe(false);
		expect(report.valid).toBe(true);
	});

	test("no improvement is reported honestly even when the measurement itself is valid", () => {
		const report = measureRerunImprovement({
			policyBefore: basePolicy,
			policyAfter: basePolicy,
			rerunsBefore: ["passed", "passed"],
			rerunsAfter: ["failed", "failed"],
		});
		expect(report.improved).toBe(false);
		expect(report.valid).toBe(true);
	});

	test("an empty rerun batch has pass rate 0, not NaN", () => {
		const report = measureRerunImprovement({
			policyBefore: basePolicy,
			policyAfter: basePolicy,
			rerunsBefore: [],
			rerunsAfter: [],
		});
		expect(report.before_pass_rate).toBe(0);
		expect(report.after_pass_rate).toBe(0);
		expect(Number.isNaN(report.before_pass_rate)).toBe(false);
	});
});

// ── Compose: buildRecoveryPacket / renderRecoveryPacket ──

describe("buildRecoveryPacket", () => {
	test("composes all four pieces into one packet for a decisive cascade", () => {
		const actions: RecoveryAction[] = [
			{ kind: "command", command: "npm test", rationale: "verify the fix" },
		];
		const packet = buildRecoveryPacket(cascadeRanking(), actions, basePolicy, {
			improvement: {
				policyBefore: basePolicy,
				policyAfter: basePolicy,
				rerunsBefore: ["failed"],
				rerunsAfter: ["passed"],
			},
		});
		expect(packet.failure.decisive).toBe(true);
		expect(packet.causal_evidence?.evidence_path).toEqual(["svc", "tool", "agent"]);
		expect(packet.recovery.accepted).toEqual(actions);
		expect(packet.improvement?.valid).toBe(true);
	});

	test("an indecisive failure produces a packet with no causal_evidence and no accepted recovery", () => {
		const actions: RecoveryAction[] = [
			{ kind: "command", command: "npm test", rationale: "verify" },
		];
		const packet = buildRecoveryPacket(isolatedRanking(), actions, basePolicy);
		expect(packet.failure.decisive).toBe(false);
		expect(packet.causal_evidence).toBeUndefined();
		expect(packet.recovery.accepted).toEqual([]);
		expect(packet.improvement).toBeUndefined();
	});

	test("renderRecoveryPacket is honest about indecision, rejection, and taint", () => {
		const taintedPolicy: CommandPolicy = {
			...basePolicy,
			allow_commands: [...basePolicy.allow_commands, "curl"],
		};
		const packet = buildRecoveryPacket(
			cascadeRanking(),
			[
				{ kind: "command", command: "npm test", rationale: "verify" },
				{ kind: "command", command: "rm -rf /tmp/x", rationale: "cleanup" },
			],
			basePolicy,
			{
				improvement: {
					policyBefore: basePolicy,
					policyAfter: taintedPolicy,
					rerunsBefore: ["failed"],
					rerunsAfter: ["passed"],
				},
			},
		);
		const rendered = renderRecoveryPacket(packet);
		expect(rendered).toContain("decisive failure: svc");
		expect(rendered).toContain("evidence path: svc -> tool -> agent");
		expect(rendered).toContain("command: npm test");
		expect(rendered).toContain("REJECTED");
		expect(rendered).toContain("TAINTED");
	});

	test("renderRecoveryPacket on an indecisive packet never claims a decision was made", () => {
		const packet = buildRecoveryPacket(isolatedRanking(), [], basePolicy);
		const rendered = renderRecoveryPacket(packet);
		expect(rendered).toContain("NOT decisive");
		expect(rendered).not.toContain("decisive failure:");
	});
});
