/**
 * Causal-graph root-cause ranking tests (item 38).
 *
 * A cascading failure (upstream service → tool → agent) ranks the injected
 * upstream fault above the downstream symptoms, exposes an evidence path from
 * root to symptom, and surfaces uncertainty when a failure has no correlated
 * edges.
 */
import { describe, expect, test } from "bun:test";
import {
	type CausalEdge,
	type CausalNode,
	buildCausalGraph,
	rankRootCauses,
} from "../../src/diagnosis/causal-graph.js";

describe("rankRootCauses", () => {
	test("ranks the upstream fault above downstream symptoms in a cascade", () => {
		const nodes: CausalNode[] = [
			{ id: "svc", kind: "service", status: "failed", ts: 1, message: "DB pool exhausted" },
			{ id: "tool", kind: "tool", status: "failed", ts: 2, message: "query timeout" },
			{ id: "agent", kind: "agent", status: "failed", ts: 3, message: "task aborted" },
			{ id: "sibling", kind: "tool", status: "ok", ts: 2 },
		];
		const edges: CausalEdge[] = [
			{ from: "svc", to: "tool", type: "causes" },
			{ from: "tool", to: "agent", type: "causes" },
		];

		const { root_causes, uncertainty } = rankRootCauses(buildCausalGraph(nodes, edges));

		// Exactly one root cause: the earliest failed node with no failed cause.
		expect(root_causes).toHaveLength(1);
		expect(root_causes[0].node_id).toBe("svc");
		expect(root_causes[0].message).toBe("DB pool exhausted");
		// Evidence path traces root -> deepest symptom.
		expect(root_causes[0].evidence_path).toEqual(["svc", "tool", "agent"]);
		expect(root_causes[0].downstream_failures).toBe(2);
		// A fully-correlated single chain carries no uncertainty.
		expect(uncertainty).toEqual([]);
	});

	test("retries pointing at the same upstream fault do not become separate roots", () => {
		const nodes: CausalNode[] = [
			{ id: "svc", kind: "service", status: "failed", ts: 1 },
			{ id: "try1", kind: "retry", status: "failed", ts: 2 },
			{ id: "try2", kind: "retry", status: "failed", ts: 3 },
		];
		const edges: CausalEdge[] = [
			{ from: "svc", to: "try1", type: "causes" },
			{ from: "svc", to: "try2", type: "causes" },
		];
		const { root_causes } = rankRootCauses(buildCausalGraph(nodes, edges));
		expect(root_causes.map((r) => r.node_id)).toEqual(["svc"]);
		expect(root_causes[0].downstream_failures).toBe(2);
	});

	test("earliest-then-blast-radius ordering across two independent chains", () => {
		const nodes: CausalNode[] = [
			{ id: "a0", kind: "service", status: "failed", ts: 1 },
			{ id: "a1", kind: "tool", status: "failed", ts: 2 },
			{ id: "b0", kind: "service", status: "failed", ts: 5 },
		];
		const edges: CausalEdge[] = [{ from: "a0", to: "a1", type: "causes" }];
		const { root_causes, uncertainty } = rankRootCauses(buildCausalGraph(nodes, edges));
		// Two roots (a0, b0); a0 is earlier → ranked first.
		expect(root_causes.map((r) => r.node_id)).toEqual(["a0", "b0"]);
		// b0 is isolated (no edges) → uncertainty is surfaced.
		expect(uncertainty.some((u) => u.includes("b0"))).toBe(true);
	});

	test("no failures yields no root causes and no uncertainty", () => {
		const nodes: CausalNode[] = [{ id: "ok", kind: "agent", status: "ok", ts: 1 }];
		const { root_causes, uncertainty } = rankRootCauses(buildCausalGraph(nodes, []));
		expect(root_causes).toEqual([]);
		expect(uncertainty).toEqual([]);
	});
});
