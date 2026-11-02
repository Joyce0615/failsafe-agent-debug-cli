import { describe, expect, test } from "bun:test";
import type { CausalNode } from "../../src/diagnosis/causal-graph.js";
import type { IncidentGraphResult } from "../../src/diagnosis/incident-graph.js";
import {
	DEFAULT_K,
	aggregateRootCauseCounts,
	buildIncidentEvidenceChain,
	kAnonymizeNodes,
	laplaceNoise,
	releaseNoisyRootCauseCounts,
	requestEpsilon,
	shareIncidentEvidence,
	type PrivacyBudget,
} from "../../src/exchange/privacy-sharing.js";
import { verifySelectiveDisclosure } from "../../src/exchange/custody.js";

const KEY = "test-signing-key";
const KEY_ID = "k1";
const NOW = "2026-01-01T00:00:00.000Z";

function node(id: string, service: string, status: "ok" | "failed" = "ok"): CausalNode {
	return { id, kind: "service", status, ts: 0, service };
}

function sampleGraph(): IncidentGraphResult {
	const nodes: CausalNode[] = [
		node("a", "svc-a", "failed"),
		node("b", "svc-a"),
		node("c", "svc-a"),
		node("d", "svc-b", "failed"), // svc-b: only one member, below k=3
	];
	return {
		nodes,
		edges: [{ from: "a", to: "b", type: "causes" }],
		root_causes: [
			{
				node_id: "a",
				kind: "service",
				status: "failed",
				score: 1,
				evidence_path: ["a"],
				downstream_failures: 1,
			},
		],
		first_propagating_fault: {
			node_id: "a",
			kind: "service",
			status: "failed",
			score: 1,
			evidence_path: ["a"],
			downstream_failures: 1,
		},
		uncertainty: [],
	};
}

describe("kAnonymizeNodes", () => {
	test("a quasi-identifier value shared by >= k nodes is left intact", () => {
		const result = kAnonymizeNodes(sampleGraph().nodes, 3, "service");
		const svcA = result.nodes.filter((n) => n.id === "a" || n.id === "b" || n.id === "c");
		for (const n of svcA) expect(n.service).toBe("svc-a");
	});

	test("a quasi-identifier value shared by fewer than k nodes is generalized", () => {
		const result = kAnonymizeNodes(sampleGraph().nodes, 3, "service");
		const d = result.nodes.find((n) => n.id === "d")!;
		expect(d.service).not.toBe("svc-b");
		expect(d.suppressed).toBe(true);
	});

	test("default k is 3", () => {
		expect(DEFAULT_K).toBe(3);
	});

	test("when the generalized bucket itself is still below k, a caveat is reported rather than claiming k-anonymity", () => {
		// Only one node total has a non-majority value -> generalized bucket has 1 member, < k=3.
		const result = kAnonymizeNodes(sampleGraph().nodes, 3, "service");
		expect(result.caveats.some((c) => c.includes("k-anonymity"))).toBe(true);
	});
});

describe("buildIncidentEvidenceChain", () => {
	test("produces a three-stage custody chain: evidence, redaction, export", () => {
		const { chain } = buildIncidentEvidenceChain("chain-1", NOW, sampleGraph(), 3, "service");
		expect(chain.records.map((r) => r.stage)).toEqual(["evidence", "redaction", "export"]);
	});
});

describe("shareIncidentEvidence", () => {
	test("discloses only the export stage; evidence and redaction remain withheld but provably intact", () => {
		const disclosure = shareIncidentEvidence("chain-1", NOW, sampleGraph(), KEY, KEY_ID, 3, "service");
		const verification = verifySelectiveDisclosure(disclosure, KEY);
		expect(verification.ok).toBe(true);
		expect(verification.disclosed_verified).toEqual([2]);
		expect(verification.withheld).toEqual([0, 1]);
		expect(disclosure.records[0].content).toBeUndefined();
		expect(disclosure.records[1].content).toBeUndefined();
		expect(disclosure.records[2].content).toBeDefined();
	});

	test("the disclosed export content never contains the pre-anonymization raw service value for a suppressed node", () => {
		const disclosure = shareIncidentEvidence("chain-1", NOW, sampleGraph(), KEY, KEY_ID, 3, "service");
		const exported = disclosure.records[2].content as { nodes: CausalNode[] };
		const d = exported.nodes.find((n) => n.id === "d")!;
		expect(d.service).not.toBe("svc-b");
	});
});

describe("requestEpsilon", () => {
	test("a request within the remaining budget succeeds and decrements it", () => {
		const budget: PrivacyBudget = { epsilon_total: 1, epsilon_spent: 0 };
		const result = requestEpsilon(budget, 0.4);
		expect(result.ok).toBe(true);
		expect(result.budget.epsilon_spent).toBe(0.4);
	});

	test("a request exceeding the remaining budget is refused and leaves the budget unchanged", () => {
		const budget: PrivacyBudget = { epsilon_total: 1, epsilon_spent: 0.8 };
		const result = requestEpsilon(budget, 0.5);
		expect(result.ok).toBe(false);
		expect(result.budget).toEqual(budget);
	});
});

describe("laplaceNoise", () => {
	test("is deterministic for a given rand sequence", () => {
		let i = 0;
		const seq = [0.1, 0.9];
		const rand = () => seq[i++];
		const a = laplaceNoise(rand, 1);
		i = 0;
		const b = laplaceNoise(rand, 1);
		expect(a).toBe(b);
	});

	test("scale 0 always returns exactly 0", () => {
		expect(laplaceNoise(() => 0.37, 0)).toBe(0);
	});
});

describe("aggregateRootCauseCounts", () => {
	test("counts root-cause kinds across multiple shared incident graphs", () => {
		const graphs = [sampleGraph(), sampleGraph()];
		const counts = aggregateRootCauseCounts(graphs);
		expect(counts.service).toBe(2);
	});
});

describe("releaseNoisyRootCauseCounts", () => {
	test("a release within budget returns noised counts and decrements the budget", () => {
		const graphs = [sampleGraph(), sampleGraph(), sampleGraph()];
		const budget: PrivacyBudget = { epsilon_total: 2, epsilon_spent: 0 };
		let i = 0;
		const seq = [0.2];
		const rand = () => seq[Math.min(i++, seq.length - 1)];
		const result = releaseNoisyRootCauseCounts(graphs, 0.5, budget, rand);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.budget.epsilon_spent).toBe(0.5);
			expect(typeof result.noisy_counts.service).toBe("number");
		}
	});

	test("a release that would exceed the budget is refused without leaking the true counts", () => {
		const graphs = [sampleGraph()];
		const budget: PrivacyBudget = { epsilon_total: 1, epsilon_spent: 0.9 };
		const result = releaseNoisyRootCauseCounts(graphs, 0.5, budget, () => 0.5);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/budget/i);
			expect(Object.keys(result as unknown as Record<string, unknown>)).not.toContain(
				"noisy_counts",
			);
		}
	});
});
