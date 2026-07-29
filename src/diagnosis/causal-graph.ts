/**
 * Causal-graph root-cause analysis for multi-agent / distributed traces
 * (item 38).
 *
 * AgentTrace ranks root causes by tracing backward through a causal graph
 * without needing an LLM at diagnosis time. Failsafe diagnoses a single command
 * log; this module ingests correlated events/spans across parent/child agents,
 * tools, services, and retries, builds typed causal edges, and ranks the
 * EARLIEST explanatory failed nodes — attaching a compact evidence path from
 * each root cause to a downstream symptom, and uncertainty when correlation is
 * incomplete.
 *
 * Pure (no fs/network/process): deterministic ranking from an in-memory graph.
 */

export type CausalNodeKind = "agent" | "tool" | "service" | "retry";
export type CausalNodeStatus = "ok" | "failed";

export type CausalNode = {
	id: string;
	kind: CausalNodeKind;
	status: CausalNodeStatus;
	/** Monotonic ordering key (span start time or sequence). */
	ts: number;
	message?: string;
	service?: string;
};

/** An edge `from -> to` means `from` is upstream of (influences/causes) `to`. */
export type CausalEdgeType = "causes" | "child_of" | "retry_of" | "depends_on";
export type CausalEdge = { from: string; to: string; type: CausalEdgeType };

export type CausalGraph = {
	nodes: Map<string, CausalNode>;
	edges: CausalEdge[];
	/** to -> list of upstream node ids. */
	upstream: Map<string, string[]>;
	/** from -> list of downstream node ids. */
	downstream: Map<string, string[]>;
};

export function buildCausalGraph(nodes: CausalNode[], edges: CausalEdge[]): CausalGraph {
	const nodeMap = new Map<string, CausalNode>();
	for (const n of nodes) nodeMap.set(n.id, n);

	const upstream = new Map<string, string[]>();
	const downstream = new Map<string, string[]>();
	const push = (map: Map<string, string[]>, key: string, value: string): void => {
		const list = map.get(key);
		if (list) list.push(value);
		else map.set(key, [value]);
	};
	for (const e of edges) {
		// Only keep edges between known nodes.
		if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
		push(downstream, e.from, e.to);
		push(upstream, e.to, e.from);
	}
	return { nodes: nodeMap, edges, upstream, downstream };
}

export type RootCause = {
	node_id: string;
	kind: CausalNodeKind;
	status: CausalNodeStatus;
	message?: string;
	/** Higher = ranked earlier: primarily earliest ts, then blast radius. */
	score: number;
	/** Node ids from this root cause down to its deepest failed symptom. */
	evidence_path: string[];
	/** Count of distinct downstream failed nodes reachable from this root. */
	downstream_failures: number;
};

export type CausalRanking = {
	root_causes: RootCause[];
	uncertainty: string[];
};

/** Follow downstream edges from `start`, returning all reachable failed nodes. */
function reachableFailures(graph: CausalGraph, start: string): Set<string> {
	const seen = new Set<string>();
	const stack = [...(graph.downstream.get(start) ?? [])];
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const next of graph.downstream.get(id) ?? []) stack.push(next);
	}
	// Only count failed nodes as "failures".
	return new Set([...seen].filter((id) => graph.nodes.get(id)?.status === "failed"));
}

/** Build the evidence path: root -> deepest failed downstream symptom. */
function evidencePath(graph: CausalGraph, root: string): string[] {
	const path = [root];
	let current = root;
	const guard = new Set<string>([root]);
	while (true) {
		const downstreamFailed = (graph.downstream.get(current) ?? [])
			.filter((id) => graph.nodes.get(id)?.status === "failed" && !guard.has(id))
			// Deterministic: earliest downstream failure first.
			.sort((a, b) => graph.nodes.get(a)!.ts - graph.nodes.get(b)!.ts || a.localeCompare(b));
		if (downstreamFailed.length === 0) break;
		current = downstreamFailed[0];
		guard.add(current);
		path.push(current);
	}
	return path;
}

/**
 * Rank the root causes of the failures in a causal graph. A root cause is a
 * FAILED node with no failed upstream cause (the earliest explanatory node in
 * its chain). Roots are ranked earliest-ts-first, breaking ties by blast radius
 * (downstream failure count). Uncertainty is reported when correlation is
 * incomplete (isolated failures with no edges, or multiple independent roots).
 */
export function rankRootCauses(graph: CausalGraph): CausalRanking {
	const failed = [...graph.nodes.values()].filter((n) => n.status === "failed");
	const uncertainty: string[] = [];

	const roots: RootCause[] = [];
	for (const node of failed) {
		const upstreamFailed = (graph.upstream.get(node.id) ?? []).filter(
			(id) => graph.nodes.get(id)?.status === "failed",
		);
		if (upstreamFailed.length > 0) continue; // has a failed cause → not a root

		const downstream = reachableFailures(graph, node.id);
		const hasEdges =
			(graph.upstream.get(node.id)?.length ?? 0) + (graph.downstream.get(node.id)?.length ?? 0) > 0;
		if (!hasEdges) {
			uncertainty.push(
				`Failed node '${node.id}' has no correlated causal edges; root-cause attribution is uncertain.`,
			);
		}

		roots.push({
			node_id: node.id,
			kind: node.kind,
			status: node.status,
			message: node.message,
			// Earlier ts ranks higher; blast radius is the tie-breaker. Negate ts so
			// larger score == earlier + wider.
			score: -node.ts + downstream.size / 1000,
			evidence_path: evidencePath(graph, node.id),
			downstream_failures: downstream.size,
		});
	}

	roots.sort((a, b) => b.score - a.score || a.node_id.localeCompare(b.node_id));

	if (roots.length > 1) {
		const independent = roots.filter((r) => r.downstream_failures > 0).length;
		if (independent > 1) {
			uncertainty.push(
				`${independent} independent failure chains detected; the top root cause may not explain all symptoms.`,
			);
		}
	}
	if (failed.length > 0 && roots.length === 0) {
		uncertainty.push("Failures form a cycle with no identifiable root; correlation is incomplete.");
	}

	return { root_causes: roots, uncertainty };
}
