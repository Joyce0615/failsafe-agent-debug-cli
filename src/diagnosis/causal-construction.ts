/**
 * Causal-graph construction from temporal order, data flow, dependencies, and
 * interventions (item 59).
 *
 * Item 38 ranks root causes *given* a causal graph. This module is the part
 * that decides which edges exist in the first place, which is where the
 * epistemics actually live. Four kinds of evidence can propose an edge, and
 * they are not remotely equal:
 *
 * | evidence      | what it establishes                                  |
 * |---------------|------------------------------------------------------|
 * | `intervention`| somebody changed the cause and watched the effect     |
 * | `data_flow`   | a value produced here was consumed there             |
 * | `dependency`  | a declared relationship that was actually exercised   |
 * | `temporal`    | one thing happened before another                     |
 *
 * The rule that shapes everything else: **temporal order alone does not create
 * an edge.** Post hoc ergo propter hoc is the oldest error in the subject, and
 * a graph built from timestamps is a timeline with arrows drawn on it. Temporal
 * evidence *orients* an edge that other evidence already justified, and can
 * create one only when a caller explicitly opts in, in which case the edge is
 * marked `speculative` and stays marked all the way through.
 *
 * The other rule that matters: **an intervention can delete an edge.** A
 * negative experiment — changed the cause, the effect did not move — refutes a
 * candidate no matter how much correlational support it had accumulated. That
 * asymmetry is the entire reason to run experiments, and a system that lets ten
 * correlations outvote one clean negative result has thrown it away.
 *
 * Pure: builds on `causal-graph.ts` and performs no I/O.
 */
import {
	type CausalEdge,
	type CausalEdgeType,
	type CausalGraph,
	type CausalNode,
	buildCausalGraph,
} from "./causal-graph.js";

export const EVIDENCE_KINDS = ["intervention", "data_flow", "dependency", "temporal"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * How much each evidence kind justifies an edge, before corroboration.
 *
 * `temporal` sits far below the others deliberately: it is the only kind that
 * is available for every pair of events in every trace, and therefore the only
 * one that can manufacture a fully connected graph out of nothing.
 */
export const EDGE_STRENGTH: Record<EvidenceKind, number> = {
	intervention: 0.9,
	data_flow: 0.7,
	dependency: 0.5,
	temporal: 0.2,
};

/** A value produced by one node and consumed by another. */
export type DataFlowFact = { producer: string; consumer: string; value: string };

/** A declared relationship, from wherever it was declared. */
export type DependencyFact = {
	dependent: string;
	dependency: string;
	source: "manifest" | "import" | "config" | "service_mesh";
};

/**
 * An experiment. `changed: false` is a *refutation*, not weak support.
 *
 * `repeats` records how many times the experiment was run, because a single
 * observation of "changed" is not much better than a correlation.
 */
export type InterventionFact = {
	cause: string;
	effect: string;
	changed: boolean;
	description: string;
	repeats?: number;
};

export type CausalEvidence = {
	data_flow?: DataFlowFact[];
	dependencies?: DependencyFact[];
	interventions?: InterventionFact[];
};

export type EdgeJustification = {
	kind: EvidenceKind;
	detail: string;
	strength: number;
};

export type ConstructedEdge = {
	from: string;
	to: string;
	type: CausalEdgeType;
	strength: number;
	justifications: EdgeJustification[];
	/** True when only temporal evidence supports this edge. */
	speculative: boolean;
};

export type RefutedEdge = {
	from: string;
	to: string;
	reason: string;
	/** Support the refuted edge had accumulated, so the reversal is visible. */
	overridden_strength: number;
	overridden_justifications: EdgeJustification[];
};

export type ConstructionOptions = {
	/**
	 * Permit temporal evidence to create edges on its own. Off by default; when
	 * on, every such edge is marked `speculative`.
	 */
	allow_temporal_only?: boolean;
	/** Maximum gap for a temporal orientation/edge, in the nodes' `ts` units. */
	temporal_window?: number;
};

export const DEFAULT_TEMPORAL_WINDOW = 60_000;

/**
 * Corroboration bonus for each *additional distinct kind* of evidence.
 *
 * Distinct kinds only: three data-flow facts about the same pair are one
 * observation seen three times, while a data-flow fact plus a dependency
 * declaration plus an intervention are three independent reasons to believe
 * the same thing.
 */
export const CORROBORATION_BONUS = 0.05;

function edgeKey(from: string, to: string): string {
	return `${from}->${to}`;
}

function combineStrength(justifications: EdgeJustification[]): number {
	const best = Math.max(...justifications.map((j) => j.strength));
	const kinds = new Set(justifications.map((j) => j.kind)).size;
	return Math.min(0.99, Math.round((best + (kinds - 1) * CORROBORATION_BONUS) * 1000) / 1000);
}

/** Which `CausalEdgeType` best describes an edge given its evidence. */
function edgeTypeFor(kinds: Set<EvidenceKind>): CausalEdgeType {
	if (kinds.has("intervention") || kinds.has("data_flow")) return "causes";
	if (kinds.has("dependency")) return "depends_on";
	return "causes";
}

export type ConstructionResult = {
	graph: CausalGraph;
	edges: ConstructedEdge[];
	refuted: RefutedEdge[];
	/** Edges dropped to make the graph acyclic, with the cycle they were on. */
	removed_for_cycles: Array<{ edge: ConstructedEdge; cycle: string[] }>;
	warnings: string[];
};

/**
 * Build a causal graph from evidence.
 *
 * Order of operations is load-bearing: candidates are proposed by all four
 * kinds, then interventions refute, then cycles are broken by removing the
 * *weakest* edge on each cycle. Refuting before cycle-breaking means a refuted
 * edge can never be the thing that "resolves" a cycle, which would let a wrong
 * edge survive by being convenient.
 */
export function constructCausalGraph(
	nodes: CausalNode[],
	evidence: CausalEvidence = {},
	options: ConstructionOptions = {},
): ConstructionResult {
	const known = new Map(nodes.map((n) => [n.id, n]));
	const warnings: string[] = [];
	const candidates = new Map<string, EdgeJustification[]>();

	const propose = (from: string, to: string, justification: EdgeJustification): void => {
		if (from === to) return;
		if (!known.has(from) || !known.has(to)) return;
		const key = edgeKey(from, to);
		const list = candidates.get(key);
		if (list) list.push(justification);
		else candidates.set(key, [justification]);
	};

	// --- data flow: orientation comes from production, not from the clock ---
	for (const fact of evidence.data_flow ?? []) {
		if (!known.has(fact.producer) || !known.has(fact.consumer)) {
			warnings.push(
				`data-flow fact '${fact.value}' references a node outside the observed set; ignored`,
			);
			continue;
		}
		propose(fact.producer, fact.consumer, {
			kind: "data_flow",
			detail: `'${fact.value}' produced by ${fact.producer} and consumed by ${fact.consumer}`,
			strength: EDGE_STRENGTH.data_flow,
		});
	}

	// --- declared dependencies, activated only when both ends participated ---
	for (const fact of evidence.dependencies ?? []) {
		if (!known.has(fact.dependent) || !known.has(fact.dependency)) {
			// A manifest lists everything a project could use; edges for the parts
			// that did not run would swamp the graph with nodes that cannot
			// explain anything.
			continue;
		}
		propose(fact.dependency, fact.dependent, {
			kind: "dependency",
			detail: `${fact.dependent} depends on ${fact.dependency} (declared in ${fact.source})`,
			strength: EDGE_STRENGTH.dependency,
		});
	}

	// --- interventions: the only evidence that is an experiment ---
	for (const fact of evidence.interventions ?? []) {
		if (!known.has(fact.cause) || !known.has(fact.effect)) {
			warnings.push(
				`intervention '${fact.description}' references a node outside the observed set; ignored`,
			);
			continue;
		}
		if (!fact.changed) continue; // handled in the refutation pass
		const repeats = fact.repeats ?? 1;
		propose(fact.cause, fact.effect, {
			kind: "intervention",
			detail: `${fact.description} (observed ${repeats}×)`,
			// A single observation of an effect is barely better than a
			// correlation; repeats are what turn it into a result.
			strength: repeats > 1 ? EDGE_STRENGTH.intervention : EDGE_STRENGTH.intervention - 0.15,
		});
	}

	// --- temporal: orients existing candidates; creates edges only on request ---
	const window = options.temporal_window ?? DEFAULT_TEMPORAL_WINDOW;
	const ordered = [...nodes].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
	for (let i = 0; i < ordered.length; i++) {
		for (let j = i + 1; j < ordered.length; j++) {
			const earlier = ordered[i];
			const later = ordered[j];
			if (later.ts - earlier.ts > window) break;
			if (later.ts === earlier.ts) continue; // no order to read off
			const forward = edgeKey(earlier.id, later.id);
			const backward = edgeKey(later.id, earlier.id);

			if (candidates.has(forward)) {
				candidates.get(forward)!.push({
					kind: "temporal",
					detail: `${earlier.id} precedes ${later.id} by ${later.ts - earlier.ts}`,
					strength: EDGE_STRENGTH.temporal,
				});
			} else if (candidates.has(backward)) {
				// An edge pointing backwards in time contradicts its own evidence.
				warnings.push(
					`edge ${backward} runs against observed order (${later.id} occurred after ${earlier.id})`,
				);
			} else if (options.allow_temporal_only) {
				candidates.set(forward, [
					{
						kind: "temporal",
						detail: `${earlier.id} precedes ${later.id} by ${later.ts - earlier.ts} (temporal only)`,
						strength: EDGE_STRENGTH.temporal,
					},
				]);
			}
		}
	}

	// --- refutation: a negative experiment deletes an edge outright ---
	const refuted: RefutedEdge[] = [];
	for (const fact of evidence.interventions ?? []) {
		if (fact.changed) continue;
		const key = edgeKey(fact.cause, fact.effect);
		const existing = candidates.get(key) ?? [];
		candidates.delete(key);
		refuted.push({
			from: fact.cause,
			to: fact.effect,
			reason: `${fact.description}: the cause was changed and the effect did not move`,
			overridden_strength: existing.length > 0 ? combineStrength(existing) : 0,
			overridden_justifications: existing,
		});
	}

	let edges: ConstructedEdge[] = [...candidates.entries()]
		.map(([key, justifications]) => {
			const [from, to] = key.split("->");
			const kinds = new Set(justifications.map((j) => j.kind));
			return {
				from,
				to,
				type: edgeTypeFor(kinds),
				strength: combineStrength(justifications),
				justifications: [...justifications].sort((a, b) => b.strength - a.strength),
				speculative: kinds.size === 1 && kinds.has("temporal"),
			};
		})
		.sort(
			(a, b) => b.strength - a.strength || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
		);

	const { kept, removed } = breakCycles(edges);
	edges = kept;

	const causalEdges: CausalEdge[] = edges.map((e) => ({ from: e.from, to: e.to, type: e.type }));
	if (removed.length > 0) {
		warnings.push(
			`${removed.length} edge(s) removed to make the graph acyclic; a cycle means the evidence is inconsistent, not that causation is circular`,
		);
	}

	return {
		graph: buildCausalGraph(nodes, causalEdges),
		edges,
		refuted,
		removed_for_cycles: removed,
		warnings,
	};
}

/**
 * Remove the weakest edge on each cycle until the graph is acyclic.
 *
 * A cycle in a causal graph is not a discovery about the world; it is a sign
 * that at least one edge is wrong. Removing the weakest-supported one is the
 * least-damage choice, and the removal is *returned* so a reader can see which
 * belief was sacrificed and on what grounds rather than finding a graph that
 * quietly differs from its evidence.
 */
export function breakCycles(edges: ConstructedEdge[]): {
	kept: ConstructedEdge[];
	removed: Array<{ edge: ConstructedEdge; cycle: string[] }>;
} {
	const kept = [...edges];
	const removed: Array<{ edge: ConstructedEdge; cycle: string[] }> = [];

	for (let guard = 0; guard < edges.length + 1; guard++) {
		const cycle = findCycle(kept);
		if (!cycle) break;

		// Edges on the cycle, in cycle order.
		const onCycle: ConstructedEdge[] = [];
		for (let i = 0; i < cycle.length - 1; i++) {
			const edge = kept.find((e) => e.from === cycle[i] && e.to === cycle[i + 1]);
			if (edge) onCycle.push(edge);
		}
		if (onCycle.length === 0) break;

		const weakest = onCycle.reduce((a, b) =>
			b.strength < a.strength ||
			(b.strength === a.strength && `${b.from}->${b.to}` < `${a.from}->${a.to}`)
				? b
				: a,
		);
		kept.splice(kept.indexOf(weakest), 1);
		removed.push({ edge: weakest, cycle });
	}

	return { kept, removed };
}

/** Depth-first cycle detection; returns the cycle as a node path, or `null`. */
export function findCycle(edges: ConstructedEdge[]): string[] | null {
	const out = new Map<string, string[]>();
	for (const e of edges) {
		const list = out.get(e.from);
		if (list) list.push(e.to);
		else out.set(e.from, [e.to]);
	}

	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];

	const visit = (node: string): string[] | null => {
		const status = state.get(node);
		if (status === "done") return null;
		if (status === "visiting") {
			const start = stack.indexOf(node);
			return [...stack.slice(start), node];
		}
		state.set(node, "visiting");
		stack.push(node);
		for (const next of (out.get(node) ?? []).slice().sort()) {
			const cycle = visit(next);
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(node, "done");
		return null;
	};

	for (const node of [...out.keys()].sort()) {
		const cycle = visit(node);
		if (cycle) return cycle;
	}
	return null;
}

/**
 * A short, human-readable account of why an edge is believed.
 *
 * Every edge in a causal graph should be answerable to "how do you know that",
 * and this is the answer. A speculative edge says so first, before the reason,
 * so a reader who stops at the first clause is not misled.
 */
export function explainEdge(edge: ConstructedEdge): string {
	const prefix = edge.speculative ? "SPECULATIVE (temporal order only): " : "";
	const reasons = edge.justifications.map((j) => `${j.kind}: ${j.detail}`).join("; ");
	return `${prefix}${edge.from} -> ${edge.to} [${edge.strength}] ${reasons}`;
}
