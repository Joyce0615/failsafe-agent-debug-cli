/**
 * Authorization-drift diagnosis across a multi-agent delegation chain
 * (item 44, module-header numbering: item 110, confirmed next-free via
 * `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u`,
 * highest prior being item 109 from item 43's
 * `programmatic-tool-failure.ts`).
 *
 * MasDrift (arxiv.org/abs/2608.07556, cited in this project's own
 * "Fifth-cycle research incorporated" section) measures exactly the gap
 * this item names: delegated goals in a multi-agent system do not
 * necessarily carry their original authorization boundary, hierarchy
 * depth widens the gap, and the paper compares two defenses that differ
 * in WHERE authorization evidence lives — **re-anchoring** every pending
 * call to the original request, versus **chain propagation**, carrying an
 * attenuated copy of the policy down the delegation chain. `grep -rn
 * "reserved_action|delegation_chain|authorization_boundary|attenuat" src
 * --include="*.ts"` before this module matched nothing.
 * `incident-graph.ts` (item 22) already draws a `delegates_to` causal edge
 * between agents from EXPLICIT relations, but has no notion of a policy
 * attached to that edge at all — it answers "who delegated to whom and in
 * what order", never "with how much authority". `capability-drift.ts`
 * (item 36) already has a `policy_scope` vocabulary and already names
 * `unexpectedly_expanded` for a widened scope, but compares two polls of
 * ONE agent's own tool catalog over TIME, never a chain of DIFFERENT
 * agents' delegated policies at one point in time — composing a sixth
 * drift category onto it, the way item 36's own module header warns
 * against doing to `drift.ts`, would smuggle a different kind of fact
 * (whose authority an action ran under) into a module about what one
 * agent can currently invoke.
 *
 * This module names four independently-reportable findings — never
 * blended into one severity score, continuing this project's own "don't
 * invent a composite number" discipline (`drift.ts`, `nested-agent-
 * operations.ts`, `capability-drift.ts` all make the same call):
 *
 * - `policy_widened`: a node's OWN declared `delegated_policy` allows an
 *   action that its authority SOURCE did not. The source depends on the
 *   node's own `anchor_mode` — the original intent directly, for a
 *   `re_anchored` node (that is the entire point of re-anchoring: bounded
 *   by the ORIGINAL request, never by whatever a parent happened to
 *   attenuate it to), or the immediate parent's own `delegated_policy`,
 *   for a `chain_propagated` node (attenuation should only ever narrow).
 *   This is the drift MasDrift's hierarchy-depth result names: the point
 *   where a delegation link itself started claiming authority nobody
 *   upstream actually granted.
 * - `reserved_action_executed`: an `observed_effects` entry matches the
 *   ORIGINAL intent's `reserved_actions` — the task's own paired
 *   temptation set, present or absent from `delegated_policy` entirely.
 *   This is an absolute violation independent of any policy the node
 *   carried, mirroring this project's `security/sandbox.ts`'s own
 *   `ALWAYS_DENIED_PATHS`: some constraints apply regardless of whatever
 *   narrower policy a layer declares.
 * - `policy_exceeded`: an `observed_effects` entry is outside the node's
 *   OWN `delegated_policy.allowed_actions` — the node disobeyed even the
 *   (possibly already-too-wide) scope it was itself operating under. This
 *   is reported SEPARATELY from `policy_widened`: a node can have a
 *   correctly-bounded policy and still act outside it, or a wrongly-widened
 *   policy and still act within it — two independent facts the item's own
 *   "observed effects" vs. "delegated policies" wording asks to keep apart.
 * - `lost_policy_source`: a `chain_propagated` node whose declared
 *   `parent_node_id` is absent from the supplied node set. Its policy's
 *   drift cannot be checked against anything, so it is named as its own
 *   evidence-quality finding — mirroring `nested-agent-operations.ts`'s
 *   own `lost_parents` grouping — rather than silently assumed correct or
 *   silently assumed violating.
 *
 * `locateFirstConstraintLoss` names the SINGLE earliest-depth node (then
 * earliest-declared-order at that depth, deterministic) carrying a
 * `policy_widened` or `reserved_action_executed` or `policy_exceeded`
 * finding — the point where the authorization boundary ITSELF first
 * eroded or was first crossed, not merely the first SYMPTOM of it further
 * downstream. `lost_policy_source` is deliberately EXCLUDED from first-
 * constraint-loss candidacy: it is evidence the chain cannot be verified,
 * not evidence the chain was actually violated, and conflating "unknown"
 * with "lost" would misreport an evidence gap as a diagnosis.
 *
 * Pure: builds a delegation tree and runs these four checks over it, no
 * fs/network/process access.
 */

export type AuthorizationIntent = {
	task: string;
	/** The scope the original requester actually granted. */
	allowed_actions: string[];
	/**
	 * This task's own paired temptation set (MasDrift's "reserved
	 * actions"): actions that must never happen for this task regardless of
	 * what any delegated policy later claims, whether or not they overlap
	 * with `allowed_actions`.
	 */
	reserved_actions: string[];
};

export type AnchorMode = "re_anchored" | "chain_propagated";

export type DelegationNode = {
	node_id: string;
	agent_id: string;
	/** Absent only for a node served directly by the original intent (depth 0). */
	parent_node_id?: string;
	/** This node's own declared scope, after whatever its own delegation applied. */
	delegated_policy: { allowed_actions: string[] };
	anchor_mode: AnchorMode;
	/** Actions this node actually took, observed from execution. */
	observed_effects: string[];
};

export type AuthorizationDriftFindingKind =
	| "policy_widened"
	| "reserved_action_executed"
	| "policy_exceeded"
	| "lost_policy_source";

export type AuthorizationDriftFinding = {
	kind: AuthorizationDriftFindingKind;
	node_id: string;
	agent_id: string;
	depth: number;
	detail: string;
	/** Only present for `policy_widened`/`reserved_action_executed`/`policy_exceeded`. */
	actions?: string[];
};

export type DelegationTreeNode = {
	node: DelegationNode;
	depth: number;
	/** Index among siblings sharing the same `parent_node_id` and depth, in supplied order. */
	width_index: number;
	children: DelegationTreeNode[];
};

export type LostPolicySourceGroup = {
	missing_parent_node_id: string;
	orphans: string[];
};

export type DelegationTree = {
	roots: DelegationTreeNode[];
	/** Every node, by id, including orphans and nested children. A plain record (not a Map) so this field round-trips through `JSON.stringify` for CLI/MCP output. */
	by_id: Record<string, DelegationTreeNode>;
	lost_policy_source: LostPolicySourceGroup[];
};

/**
 * Build the delegation tree from a flat node list. A `chain_propagated`
 * node whose `parent_node_id` is absent from the set is walked as its own
 * root (depth 0, same as a genuinely-root node) AND is grouped into
 * `lost_policy_source`, mirroring `nested-agent-operations.ts`'s
 * `buildNestedTree`: losing the parent link never also loses the node's
 * own evidence.
 */
export function buildDelegationTree(nodes: DelegationNode[]): DelegationTree {
	const byId = new Map(nodes.map((n) => [n.node_id, n]));
	const childrenOf = new Map<string, DelegationNode[]>();
	const roots: DelegationNode[] = [];
	const lostGroups = new Map<string, string[]>();

	for (const n of nodes) {
		if (n.parent_node_id === undefined) {
			roots.push(n);
			continue;
		}
		if (!byId.has(n.parent_node_id)) {
			roots.push(n);
			const list = lostGroups.get(n.parent_node_id);
			if (list) list.push(n.node_id);
			else lostGroups.set(n.parent_node_id, [n.node_id]);
			continue;
		}
		const list = childrenOf.get(n.parent_node_id);
		if (list) list.push(n);
		else childrenOf.set(n.parent_node_id, [n]);
	}

	const resultById = new Map<string, DelegationTreeNode>();

	function walk(n: DelegationNode, depth: number, widthIndex: number): DelegationTreeNode {
		const kids = childrenOf.get(n.node_id) ?? [];
		const treeNode: DelegationTreeNode = { node: n, depth, width_index: widthIndex, children: [] };
		resultById.set(n.node_id, treeNode);
		treeNode.children = kids.map((kid, i) => walk(kid, depth + 1, i));
		return treeNode;
	}

	const rootNodes = roots.map((r, i) => walk(r, 0, i));

	const lost_policy_source: LostPolicySourceGroup[] = [...lostGroups.entries()]
		.map(([missing_parent_node_id, orphans]) => ({
			missing_parent_node_id,
			orphans: [...orphans].sort(),
		}))
		.sort((a, b) => a.missing_parent_node_id.localeCompare(b.missing_parent_node_id));

	return { roots: rootNodes, by_id: Object.fromEntries(resultById), lost_policy_source };
}

function actionsNotIn(observed: string[], allowed: readonly string[]): string[] {
	const allowedSet = new Set(allowed);
	return [...new Set(observed.filter((a) => !allowedSet.has(a)))].sort();
}

/**
 * Run all four checks over a built delegation tree against the original
 * intent, producing every finding in depth order (then declared sibling
 * order at that depth — never severity-sorted, so the output already
 * reads as "earliest in the chain first" without a caller needing to
 * re-sort it for `locateFirstConstraintLoss`).
 */
export function detectAuthorizationDrift(
	tree: DelegationTree,
	intent: AuthorizationIntent,
): AuthorizationDriftFinding[] {
	const findings: AuthorizationDriftFinding[] = [];
	const lostParentIds = new Set(tree.lost_policy_source.flatMap((g) => g.orphans));

	function visit(treeNode: DelegationTreeNode): void {
		const { node, depth } = treeNode;
		const isRoot = node.parent_node_id === undefined || lostParentIds.has(node.node_id);

		if (isRoot) {
			if (lostParentIds.has(node.node_id)) {
				findings.push({
					kind: "lost_policy_source",
					node_id: node.node_id,
					agent_id: node.agent_id,
					depth,
					detail: `node '${node.node_id}' declares parent '${node.parent_node_id}', which is absent from the supplied node set; its policy's authority source cannot be verified`,
				});
			}
			// A root (genuine or orphaned) is always checked against the
			// ORIGINAL intent directly — there is no parent policy to inherit
			// from, regardless of its declared anchor_mode.
			const widened = actionsNotIn(node.delegated_policy.allowed_actions, intent.allowed_actions);
			if (widened.length > 0) {
				findings.push({
					kind: "policy_widened",
					node_id: node.node_id,
					agent_id: node.agent_id,
					depth,
					actions: widened,
					detail: `node '${node.node_id}' (agent '${node.agent_id}') declares a policy allowing ${widened.join(", ")}, which the original intent never granted`,
				});
			}
		} else {
			const parent = tree.by_id[node.parent_node_id as string]?.node;
			const authoritySource =
				node.anchor_mode === "re_anchored"
					? intent.allowed_actions
					: (parent?.delegated_policy.allowed_actions ?? []);
			const widened = actionsNotIn(node.delegated_policy.allowed_actions, authoritySource);
			if (widened.length > 0) {
				findings.push({
					kind: "policy_widened",
					node_id: node.node_id,
					agent_id: node.agent_id,
					depth,
					actions: widened,
					detail:
						node.anchor_mode === "re_anchored"
							? `node '${node.node_id}' (agent '${node.agent_id}') is re-anchored to the original intent but declares a policy allowing ${widened.join(", ")}, which the original intent never granted`
							: `node '${node.node_id}' (agent '${node.agent_id}') chain-propagates from parent '${node.parent_node_id}' but declares a policy allowing ${widened.join(", ")}, which its parent's own policy did not grant`,
				});
			}
		}

		const reservedHit = node.observed_effects.filter((a) => intent.reserved_actions.includes(a));
		if (reservedHit.length > 0) {
			const unique = [...new Set(reservedHit)].sort();
			findings.push({
				kind: "reserved_action_executed",
				node_id: node.node_id,
				agent_id: node.agent_id,
				depth,
				actions: unique,
				detail: `node '${node.node_id}' (agent '${node.agent_id}') executed ${unique.join(", ")}, which this task's original intent reserves against regardless of any delegated policy`,
			});
		}

		const exceeded = actionsNotIn(node.observed_effects, node.delegated_policy.allowed_actions);
		if (exceeded.length > 0) {
			findings.push({
				kind: "policy_exceeded",
				node_id: node.node_id,
				agent_id: node.agent_id,
				depth,
				actions: exceeded,
				detail: `node '${node.node_id}' (agent '${node.agent_id}') executed ${exceeded.join(", ")}, outside its own declared policy`,
			});
		}

		for (const child of treeNode.children) visit(child);
	}

	for (const root of tree.roots) visit(root);
	return findings;
}

/**
 * The single earliest-depth node (then earliest supplied-order at that
 * depth) whose finding is a genuine boundary violation —
 * `policy_widened`, `reserved_action_executed`, or `policy_exceeded`.
 * `lost_policy_source` never qualifies: it is an evidence gap, not a
 * confirmed loss. `null` when no qualifying finding exists.
 */
export function locateFirstConstraintLoss(
	findings: AuthorizationDriftFinding[],
): AuthorizationDriftFinding | null {
	const qualifying = findings.filter((f) => f.kind !== "lost_policy_source");
	if (qualifying.length === 0) return null;
	return qualifying.reduce((earliest, f) => (f.depth < earliest.depth ? f : earliest));
}

export type AuthorizationDriftReport = {
	tree: DelegationTree;
	findings: AuthorizationDriftFinding[];
	first_constraint_loss: AuthorizationDriftFinding | null;
};

/** Compose tree construction, detection, and first-loss location into one report. */
export function diagnoseAuthorizationDrift(
	nodes: DelegationNode[],
	intent: AuthorizationIntent,
): AuthorizationDriftReport {
	const tree = buildDelegationTree(nodes);
	const findings = detectAuthorizationDrift(tree, intent);
	return { tree, findings, first_constraint_loss: locateFirstConstraintLoss(findings) };
}

/** Render a human-readable summary of an authorization-drift report. */
export function renderAuthorizationDriftReport(report: AuthorizationDriftReport): string {
	const lines: string[] = ["# Authorization Drift Report", ""];
	lines.push(`Lost policy source groups (${report.tree.lost_policy_source.length})`);
	for (const g of report.tree.lost_policy_source) {
		lines.push(`- missing parent '${g.missing_parent_node_id}': orphans ${g.orphans.join(", ")}`);
	}
	lines.push("", `Findings (${report.findings.length})`);
	for (const f of report.findings) {
		lines.push(`- [${f.kind}] depth ${f.depth} ${f.node_id} (${f.agent_id}): ${f.detail}`);
	}
	lines.push(
		"",
		report.first_constraint_loss
			? `First constraint loss: [${report.first_constraint_loss.kind}] depth ${report.first_constraint_loss.depth} ${report.first_constraint_loss.node_id} (${report.first_constraint_loss.agent_id})`
			: "First constraint loss: none found",
	);
	return lines.join("\n");
}
