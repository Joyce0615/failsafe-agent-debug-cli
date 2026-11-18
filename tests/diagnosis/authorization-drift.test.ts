import { describe, expect, test } from "bun:test";
import {
	type AuthorizationIntent,
	type DelegationNode,
	buildDelegationTree,
	detectAuthorizationDrift,
	diagnoseAuthorizationDrift,
	locateFirstConstraintLoss,
	renderAuthorizationDriftReport,
} from "../../src/diagnosis/authorization-drift.js";

function node(overrides: Partial<DelegationNode> = {}): DelegationNode {
	return {
		node_id: "n1",
		agent_id: "a1",
		delegated_policy: { allowed_actions: ["read_file"] },
		anchor_mode: "re_anchored",
		observed_effects: [],
		...overrides,
	};
}

const intent: AuthorizationIntent = {
	task: "summarize the repo",
	allowed_actions: ["read_file", "search"],
	reserved_actions: ["delete_file", "send_email"],
};

// ── buildDelegationTree ──

describe("buildDelegationTree", () => {
	test("a flat list of roots builds a tree with no children and no lost groups", () => {
		const tree = buildDelegationTree([node({ node_id: "root" })]);
		expect(tree.roots).toHaveLength(1);
		expect(tree.roots[0]?.depth).toBe(0);
		expect(tree.lost_policy_source).toEqual([]);
	});

	test("a child with a present parent is nested, not a second root", () => {
		const tree = buildDelegationTree([
			node({ node_id: "root" }),
			node({ node_id: "child", parent_node_id: "root", anchor_mode: "chain_propagated" }),
		]);
		expect(tree.roots).toHaveLength(1);
		expect(tree.roots[0]?.children).toHaveLength(1);
		expect(tree.roots[0]?.children[0]?.depth).toBe(1);
	});

	test("siblings under the same parent get increasing width_index in supplied order", () => {
		const tree = buildDelegationTree([
			node({ node_id: "root" }),
			node({ node_id: "c1", parent_node_id: "root", anchor_mode: "chain_propagated" }),
			node({ node_id: "c2", parent_node_id: "root", anchor_mode: "chain_propagated" }),
		]);
		const children = tree.roots[0]?.children ?? [];
		expect(children.map((c) => c.node.node_id)).toEqual(["c1", "c2"]);
		expect(children.map((c) => c.width_index)).toEqual([0, 1]);
	});

	test("a node whose declared parent is absent is walked as its own root AND grouped as lost_policy_source", () => {
		const tree = buildDelegationTree([
			node({ node_id: "orphan", parent_node_id: "ghost", anchor_mode: "chain_propagated" }),
		]);
		expect(tree.roots).toHaveLength(1);
		expect(tree.roots[0]?.node.node_id).toBe("orphan");
		expect(tree.lost_policy_source).toHaveLength(1);
		expect(tree.lost_policy_source[0]).toEqual({
			missing_parent_node_id: "ghost",
			orphans: ["orphan"],
		});
	});

	test("two orphans sharing the same missing parent are grouped together", () => {
		const tree = buildDelegationTree([
			node({ node_id: "o1", parent_node_id: "ghost", anchor_mode: "chain_propagated" }),
			node({ node_id: "o2", parent_node_id: "ghost", anchor_mode: "chain_propagated" }),
		]);
		expect(tree.lost_policy_source).toHaveLength(1);
		expect(tree.lost_policy_source[0]?.orphans).toEqual(["o1", "o2"]);
	});

	test("by_id includes every node, including orphans and nested children", () => {
		const tree = buildDelegationTree([
			node({ node_id: "root" }),
			node({ node_id: "child", parent_node_id: "root", anchor_mode: "chain_propagated" }),
			node({ node_id: "orphan", parent_node_id: "ghost", anchor_mode: "chain_propagated" }),
		]);
		expect(Object.keys(tree.by_id).sort()).toEqual(["child", "orphan", "root"]);
	});
});

// ── detectAuthorizationDrift ──

describe("detectAuthorizationDrift", () => {
	test("a root node whose policy is a subset of the original intent produces no findings", () => {
		const tree = buildDelegationTree([node({ node_id: "root" })]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings).toEqual([]);
	});

	test("a root node whose policy exceeds the original intent is policy_widened", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "root",
				delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ kind: "policy_widened", node_id: "root", depth: 0 });
		expect(findings[0]?.actions).toEqual(["delete_file"]);
	});

	test("a re_anchored CHILD node is checked against the ORIGINAL intent, not its parent", () => {
		const tree = buildDelegationTree([
			node({ node_id: "root", delegated_policy: { allowed_actions: ["read_file"] } }),
			node({
				node_id: "child",
				parent_node_id: "root",
				anchor_mode: "re_anchored",
				// "search" is in the original intent but NOT in the parent's own
				// policy -- re-anchoring means this is fine, chain propagation
				// would have flagged it.
				delegated_policy: { allowed_actions: ["search"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings).toEqual([]);
	});

	test("a chain_propagated CHILD node is checked against its PARENT's policy, not the original intent", () => {
		const tree = buildDelegationTree([
			node({ node_id: "root", delegated_policy: { allowed_actions: ["read_file"] } }),
			node({
				node_id: "child",
				parent_node_id: "root",
				anchor_mode: "chain_propagated",
				// "search" is in the original intent but the PARENT never granted
				// it -- chain propagation should catch this even though the
				// original intent would have allowed it.
				delegated_policy: { allowed_actions: ["search"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ kind: "policy_widened", node_id: "child", depth: 1 });
		expect(findings[0]?.actions).toEqual(["search"]);
	});

	test("a chain_propagated child whose policy is a subset of its parent's is not widened", () => {
		const tree = buildDelegationTree([
			node({ node_id: "root", delegated_policy: { allowed_actions: ["read_file", "search"] } }),
			node({
				node_id: "child",
				parent_node_id: "root",
				anchor_mode: "chain_propagated",
				delegated_policy: { allowed_actions: ["read_file"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings).toEqual([]);
	});

	test("an observed effect matching a reserved action is reserved_action_executed, regardless of the node's own policy", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "root",
				// delegated_policy does not even grant delete_file -- the node
				// still executed it, so the violation stands independent of the
				// policy check.
				delegated_policy: { allowed_actions: ["read_file"] },
				observed_effects: ["delete_file"],
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings.map((f) => f.kind)).toContain("reserved_action_executed");
		expect(findings.find((f) => f.kind === "reserved_action_executed")?.actions).toEqual([
			"delete_file",
		]);
	});

	test("an observed effect outside the node's own delegated policy is policy_exceeded", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "root",
				delegated_policy: { allowed_actions: ["read_file"] },
				observed_effects: ["search"],
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ kind: "policy_exceeded", actions: ["search"] });
	});

	test("an observed effect inside the node's own delegated policy produces no policy_exceeded finding", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "root",
				delegated_policy: { allowed_actions: ["read_file"] },
				observed_effects: ["read_file"],
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings).toEqual([]);
	});

	test("policy_widened and policy_exceeded are reported as two SEPARATE findings when both apply to the same node", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "root",
				delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
				observed_effects: ["write_file"],
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings.map((f) => f.kind).toSorted()).toEqual(
			(["policy_exceeded", "policy_widened"] as const).toSorted(),
		);
	});

	test("an orphaned node produces a lost_policy_source finding AND is still checked against the original intent as a root", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "orphan",
				parent_node_id: "ghost",
				anchor_mode: "chain_propagated",
				delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings.map((f) => f.kind).toSorted()).toEqual(
			(["lost_policy_source", "policy_widened"] as const).toSorted(),
		);
	});

	test("findings are produced in depth order across a multi-level tree", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "root",
				delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
			}),
			node({
				node_id: "child",
				parent_node_id: "root",
				anchor_mode: "chain_propagated",
				delegated_policy: { allowed_actions: ["read_file", "delete_file", "send_email"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		expect(findings[0]?.node_id).toBe("root");
		expect(findings[0]?.depth).toBe(0);
		expect(findings[1]?.node_id).toBe("child");
		expect(findings[1]?.depth).toBe(1);
	});
});

// ── locateFirstConstraintLoss ──

describe("locateFirstConstraintLoss", () => {
	test("returns null when there are no findings at all", () => {
		expect(locateFirstConstraintLoss([])).toBeNull();
	});

	test("returns null when the ONLY finding is lost_policy_source", () => {
		const findings = detectAuthorizationDrift(
			buildDelegationTree([
				node({ node_id: "orphan", parent_node_id: "ghost", anchor_mode: "chain_propagated" }),
			]),
			intent,
		);
		expect(findings.map((f) => f.kind)).toEqual(["lost_policy_source"]);
		expect(locateFirstConstraintLoss(findings)).toBeNull();
	});

	test("picks the earliest-depth qualifying finding when multiple depths have findings", () => {
		const tree = buildDelegationTree([
			node({
				node_id: "root",
				delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
			}),
			node({
				node_id: "child",
				parent_node_id: "root",
				anchor_mode: "chain_propagated",
				delegated_policy: { allowed_actions: ["read_file", "delete_file", "send_email"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		const loss = locateFirstConstraintLoss(findings);
		expect(loss?.node_id).toBe("root");
		expect(loss?.depth).toBe(0);
	});

	test("skips a lost_policy_source finding in favor of a genuine qualifying finding at a deeper depth", () => {
		// The orphan itself has a widened policy (qualifying), alongside its
		// own lost_policy_source finding (non-qualifying) -- the widened one
		// must win even though both share the same node/depth.
		const tree = buildDelegationTree([
			node({
				node_id: "orphan",
				parent_node_id: "ghost",
				anchor_mode: "chain_propagated",
				delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
			}),
		]);
		const findings = detectAuthorizationDrift(tree, intent);
		const loss = locateFirstConstraintLoss(findings);
		expect(loss?.kind).toBe("policy_widened");
	});
});

// ── diagnoseAuthorizationDrift / renderAuthorizationDriftReport ──

describe("diagnoseAuthorizationDrift", () => {
	test("composes tree + findings + first_constraint_loss into one report", () => {
		const report = diagnoseAuthorizationDrift(
			[
				node({
					node_id: "root",
					delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
				}),
			],
			intent,
		);
		expect(report.tree.roots).toHaveLength(1);
		expect(report.findings).toHaveLength(1);
		expect(report.first_constraint_loss?.node_id).toBe("root");
	});

	test("an empty node list produces an empty, well-formed report", () => {
		const report = diagnoseAuthorizationDrift([], intent);
		expect(report.tree.roots).toEqual([]);
		expect(report.findings).toEqual([]);
		expect(report.first_constraint_loss).toBeNull();
	});
});

describe("renderAuthorizationDriftReport", () => {
	test("renders lost-policy-source groups, every finding, and a found first-constraint-loss line", () => {
		const report = diagnoseAuthorizationDrift(
			[
				node({
					node_id: "root",
					delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
				}),
			],
			intent,
		);
		const rendered = renderAuthorizationDriftReport(report);
		expect(rendered).toContain("Lost policy source groups (0)");
		expect(rendered).toContain("Findings (1)");
		expect(rendered).toContain("[policy_widened]");
		expect(rendered).toContain("First constraint loss: [policy_widened]");
	});

	test("renders 'none found' when there is no qualifying first constraint loss", () => {
		const report = diagnoseAuthorizationDrift([], intent);
		const rendered = renderAuthorizationDriftReport(report);
		expect(rendered).toContain("First constraint loss: none found");
	});
});
