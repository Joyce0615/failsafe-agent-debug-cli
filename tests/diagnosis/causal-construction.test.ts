import { describe, expect, test } from "bun:test";
import type { CausalNode } from "../../src/diagnosis/causal-graph.js";
import {
	CORROBORATION_BONUS,
	type ConstructedEdge,
	EDGE_STRENGTH,
	EVIDENCE_KINDS,
	breakCycles,
	constructCausalGraph,
	explainEdge,
	findCycle,
} from "../../src/diagnosis/causal-construction.js";

function node(id: string, ts: number, overrides: Partial<CausalNode> = {}): CausalNode {
	return { id, kind: "service", status: "failed", ts, ...overrides };
}

const NODES = [node("a", 1000), node("b", 2000), node("c", 3000)];

function edgeBetween(edges: ConstructedEdge[], from: string, to: string) {
	return edges.find((e) => e.from === from && e.to === to);
}

describe("temporal order alone does not create edges", () => {
	test("three ordered failures with no other evidence yield no edges", () => {
		const result = constructCausalGraph(NODES);
		expect(result.edges).toEqual([]);
	});

	test("opting in creates edges, every one marked speculative", () => {
		const result = constructCausalGraph(NODES, {}, { allow_temporal_only: true });
		expect(result.edges.length).toBeGreaterThan(0);
		expect(result.edges.every((e) => e.speculative)).toBe(true);
		expect(result.edges.every((e) => e.strength <= EDGE_STRENGTH.temporal)).toBe(true);
	});

	test("temporal evidence corroborates an edge other evidence already justified", () => {
		const withFlow = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "b", value: "session" }],
		});
		const edge = edgeBetween(withFlow.edges, "a", "b");
		expect(edge?.speculative).toBe(false);
		expect(edge?.justifications.map((j) => j.kind).sort()).toEqual(["data_flow", "temporal"]);
	});

	test("the temporal window bounds which pairs are even considered", () => {
		const far = [node("a", 0), node("b", 10 ** 9)];
		const result = constructCausalGraph(far, {}, { allow_temporal_only: true });
		expect(result.edges).toEqual([]);
	});

	test("simultaneous nodes provide no order to read off", () => {
		const tied = [node("a", 500), node("b", 500)];
		const result = constructCausalGraph(tied, {}, { allow_temporal_only: true });
		expect(result.edges).toEqual([]);
	});

	test("an edge pointing backwards in time is warned about, not silently kept", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [{ producer: "b", consumer: "a", value: "x" }],
		});
		expect(result.warnings.some((w) => w.includes("runs against observed order"))).toBe(true);
		// The edge survives: data flow is better evidence of direction than a clock.
		expect(edgeBetween(result.edges, "b", "a")).toBeDefined();
	});
});

describe("data flow orients edges by production, not by the clock", () => {
	test("the producer is upstream of the consumer", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "c", value: "token" }],
		});
		const edge = edgeBetween(result.edges, "a", "c");
		expect(edge?.type).toBe("causes");
		expect(result.graph.upstream.get("c")).toEqual(["a"]);
	});

	test("a fact naming an unobserved node is ignored with a warning", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "ghost", value: "x" }],
		});
		expect(result.edges).toEqual([]);
		expect(result.warnings.some((w) => w.includes("outside the observed set"))).toBe(true);
	});

	test("repeating one fact does not strengthen the edge", () => {
		const once = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "b", value: "x" }],
		});
		const thrice = constructCausalGraph(NODES, {
			data_flow: [
				{ producer: "a", consumer: "b", value: "x" },
				{ producer: "a", consumer: "b", value: "y" },
				{ producer: "a", consumer: "b", value: "z" },
			],
		});
		expect(edgeBetween(thrice.edges, "a", "b")?.strength).toBe(
			edgeBetween(once.edges, "a", "b")!.strength,
		);
	});

	test("distinct evidence kinds do strengthen it", () => {
		const flowOnly = constructCausalGraph([node("a", 0), node("b", 10 ** 9)], {
			data_flow: [{ producer: "a", consumer: "b", value: "x" }],
		});
		const flowAndDep = constructCausalGraph([node("a", 0), node("b", 10 ** 9)], {
			data_flow: [{ producer: "a", consumer: "b", value: "x" }],
			dependencies: [{ dependent: "b", dependency: "a", source: "import" }],
		});
		expect(edgeBetween(flowAndDep.edges, "a", "b")!.strength).toBeCloseTo(
			edgeBetween(flowOnly.edges, "a", "b")!.strength + CORROBORATION_BONUS,
			5,
		);
	});
});

describe("dependencies are activated, not enumerated", () => {
	test("a declared dependency between observed nodes becomes an edge", () => {
		const result = constructCausalGraph(NODES, {
			dependencies: [{ dependent: "b", dependency: "a", source: "manifest" }],
		});
		const edge = edgeBetween(result.edges, "a", "b");
		expect(edge?.type).toBe("depends_on");
		expect(edge?.justifications.some((j) => j.kind === "dependency")).toBe(true);
	});

	test("a dependency on a node that never ran is dropped without ceremony", () => {
		const result = constructCausalGraph(NODES, {
			dependencies: [
				{ dependent: "b", dependency: "left-pad", source: "manifest" },
				{ dependent: "b", dependency: "lodash", source: "manifest" },
			],
		});
		expect(result.edges).toEqual([]);
		// Not a warning: a manifest listing unused packages is normal, and
		// warning about each would bury the real problems.
		expect(result.warnings).toEqual([]);
	});

	test("the direction is dependency -> dependent, not the declaration order", () => {
		const result = constructCausalGraph(NODES, {
			dependencies: [{ dependent: "a", dependency: "c", source: "config" }],
		});
		expect(edgeBetween(result.edges, "c", "a")).toBeDefined();
		expect(edgeBetween(result.edges, "a", "c")).toBeUndefined();
	});
});

describe("interventions", () => {
	test("a repeated positive intervention is the strongest evidence available", () => {
		const result = constructCausalGraph(NODES, {
			interventions: [
				{ cause: "a", effect: "c", changed: true, description: "disabled the cache", repeats: 5 },
			],
		});
		expect(edgeBetween(result.edges, "a", "c")!.strength).toBeGreaterThanOrEqual(
			EDGE_STRENGTH.intervention,
		);
	});

	test("a single unrepeated observation is discounted", () => {
		const once = constructCausalGraph(NODES, {
			interventions: [{ cause: "a", effect: "c", changed: true, description: "one run" }],
		});
		const many = constructCausalGraph(NODES, {
			interventions: [
				{ cause: "a", effect: "c", changed: true, description: "five runs", repeats: 5 },
			],
		});
		expect(edgeBetween(once.edges, "a", "c")!.strength).toBeLessThan(
			edgeBetween(many.edges, "a", "c")!.strength,
		);
	});

	test("a negative intervention deletes an edge outright", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "b", value: "x" }],
			interventions: [
				{ cause: "a", effect: "b", changed: false, description: "removed the value" },
			],
		});
		expect(edgeBetween(result.edges, "a", "b")).toBeUndefined();
		expect(result.refuted).toHaveLength(1);
		expect(result.refuted[0].reason).toContain("did not move");
	});

	test("refutation beats any amount of correlational support, and says what it overrode", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "b", value: "x" }],
			dependencies: [{ dependent: "b", dependency: "a", source: "import" }],
			interventions: [
				{ cause: "a", effect: "b", changed: false, description: "controlled removal" },
			],
		});
		expect(result.edges).toEqual([]);
		expect(result.refuted[0].overridden_strength).toBeGreaterThan(EDGE_STRENGTH.data_flow);
		expect(result.refuted[0].overridden_justifications.length).toBeGreaterThanOrEqual(2);
	});

	test("refuting an edge nobody proposed is recorded with zero overridden support", () => {
		const result = constructCausalGraph(NODES, {
			interventions: [{ cause: "a", effect: "c", changed: false, description: "checked" }],
		});
		expect(result.refuted[0].overridden_strength).toBe(0);
		expect(result.refuted[0].overridden_justifications).toEqual([]);
	});

	test("an intervention naming an unobserved node is warned about", () => {
		const result = constructCausalGraph(NODES, {
			interventions: [{ cause: "ghost", effect: "b", changed: true, description: "x" }],
		});
		expect(result.warnings.some((w) => w.includes("outside the observed set"))).toBe(true);
	});
});

describe("cycles", () => {
	function edge(from: string, to: string, strength: number): ConstructedEdge {
		return { from, to, type: "causes", strength, justifications: [], speculative: false };
	}

	test("an acyclic graph is left alone", () => {
		const edges = [edge("a", "b", 0.7), edge("b", "c", 0.6)];
		const { kept, removed } = breakCycles(edges);
		expect(kept).toHaveLength(2);
		expect(removed).toEqual([]);
		expect(findCycle(edges)).toBeNull();
	});

	test("a cycle is detected and reported as a node path", () => {
		const cycle = findCycle([edge("a", "b", 0.7), edge("b", "a", 0.6)]);
		expect(cycle).not.toBeNull();
		expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
	});

	test("the weakest edge on the cycle is the one sacrificed", () => {
		const { kept, removed } = breakCycles([
			edge("a", "b", 0.9),
			edge("b", "c", 0.8),
			edge("c", "a", 0.2),
		]);
		expect(removed).toHaveLength(1);
		expect(removed[0].edge.from).toBe("c");
		expect(kept).toHaveLength(2);
	});

	test("a self-loop cannot be proposed in the first place", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "a", value: "x" }],
		});
		expect(result.edges).toEqual([]);
	});

	test("cycle removal is deterministic when strengths tie", () => {
		const build = () => [edge("a", "b", 0.5), edge("b", "c", 0.5), edge("c", "a", 0.5)];
		const first = breakCycles(build()).removed[0].edge;
		const second = breakCycles(build().reverse()).removed[0].edge;
		expect(`${first.from}->${first.to}`).toBe(`${second.from}->${second.to}`);
	});

	test("multiple independent cycles are all broken", () => {
		const { kept, removed } = breakCycles([
			edge("a", "b", 0.9),
			edge("b", "a", 0.1),
			edge("c", "d", 0.9),
			edge("d", "c", 0.2),
		]);
		expect(removed).toHaveLength(2);
		expect(findCycle(kept)).toBeNull();
	});

	test("construction reports what it removed and why it matters", () => {
		const result = constructCausalGraph(
			[node("a", 1000), node("b", 2000)],
			{
				data_flow: [
					{ producer: "a", consumer: "b", value: "x" },
					{ producer: "b", consumer: "a", value: "y" },
				],
			},
		);
		expect(result.removed_for_cycles.length).toBeGreaterThan(0);
		expect(result.warnings.some((w) => w.includes("evidence is inconsistent"))).toBe(true);
		expect(findCycle(result.edges)).toBeNull();
	});
});

describe("output shape", () => {
	test("the strength ladder is ordered and temporal is far below the rest", () => {
		expect(EVIDENCE_KINDS).toEqual(["intervention", "data_flow", "dependency", "temporal"]);
		for (let i = 1; i < EVIDENCE_KINDS.length; i++) {
			expect(EDGE_STRENGTH[EVIDENCE_KINDS[i]]).toBeLessThan(EDGE_STRENGTH[EVIDENCE_KINDS[i - 1]]);
		}
		expect(EDGE_STRENGTH.dependency - EDGE_STRENGTH.temporal).toBeGreaterThan(0.25);
	});

	test("edges are sorted strongest first and deterministically", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "c", value: "x" }],
			dependencies: [{ dependent: "b", dependency: "a", source: "manifest" }],
		});
		for (let i = 1; i < result.edges.length; i++) {
			expect(result.edges[i - 1].strength).toBeGreaterThanOrEqual(result.edges[i].strength);
		}
	});

	test("the graph is usable by the item-38 ranker", () => {
		const result = constructCausalGraph(NODES, {
			data_flow: [
				{ producer: "a", consumer: "b", value: "x" },
				{ producer: "b", consumer: "c", value: "y" },
			],
		});
		expect(result.graph.nodes.size).toBe(3);
		expect(result.graph.downstream.get("a")).toEqual(["b"]);
		expect(result.graph.upstream.get("c")).toEqual(["b"]);
	});

	test("an explanation leads with the caveat, not with the claim", () => {
		const speculative = constructCausalGraph(NODES, {}, { allow_temporal_only: true }).edges[0];
		expect(explainEdge(speculative).startsWith("SPECULATIVE")).toBe(true);

		const grounded = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "b", value: "x" }],
		}).edges[0];
		expect(explainEdge(grounded)).toContain("data_flow");
		expect(explainEdge(grounded).startsWith("SPECULATIVE")).toBe(false);
	});

	test("justifications are ordered strongest first within an edge", () => {
		const edge = constructCausalGraph(NODES, {
			data_flow: [{ producer: "a", consumer: "b", value: "x" }],
		}).edges[0];
		expect(edge.justifications[0].kind).toBe("data_flow");
		expect(edge.justifications[edge.justifications.length - 1].kind).toBe("temporal");
	});

	test("no evidence at all yields an empty but well-formed result", () => {
		const result = constructCausalGraph([]);
		expect(result.edges).toEqual([]);
		expect(result.refuted).toEqual([]);
		expect(result.removed_for_cycles).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.graph.nodes.size).toBe(0);
	});
});
