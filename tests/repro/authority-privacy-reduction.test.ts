import { describe, expect, test } from "bun:test";
import type { CausalEdge, CausalNode } from "../../src/diagnosis/causal-graph.js";
import {
	type ReproElement,
	checkCausalExplanationPreserved,
	checkReducerAuthority,
	checkReducerPrivacy,
	extractMultiKindRepro,
	renderGateRejections,
} from "../../src/repro/authority-privacy-reduction.js";
import type { ReductionOracle } from "../../src/repro/trace-reduction.js";
import { getDefaultPolicy } from "../../src/security/policy.js";

const policy = getDefaultPolicy();

/** An oracle that reproduces exactly when every element of `required` is present. */
function requiring(required: string[], signature = "AssertionError"): ReductionOracle {
	return (ids) => {
		const present = new Set(ids);
		const reproduces = required.every((r) => present.has(r));
		return reproduces ? { reproduces: true, cause_signature: signature } : { reproduces: false };
	};
}

function el(id: string, overrides: Partial<ReproElement> = {}): ReproElement {
	return { id, kind: "event", ...overrides };
}

// ── Authority gate ──

describe("checkReducerAuthority", () => {
	test("an allowed command in the candidate set is not a violation", () => {
		const elements = [el("a", { required_command: "npm test" })];
		const violations = checkReducerAuthority(elements, new Set(["a"]), policy);
		expect(violations).toEqual([]);
	});

	test("a denied command still present in the candidate set is a violation", () => {
		const elements = [el("a", { required_command: "sudo rm -rf /" })];
		const violations = checkReducerAuthority(elements, new Set(["a"]), policy);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.element_id).toBe("a");
	});

	test("a denied command NOT in the candidate set (already dropped) is not a violation", () => {
		const elements = [el("a", { required_command: "sudo rm -rf /" })];
		const violations = checkReducerAuthority(elements, new Set([]), policy);
		expect(violations).toEqual([]);
	});

	test("an element with no required_command is never flagged", () => {
		const elements = [el("a")];
		const violations = checkReducerAuthority(elements, new Set(["a"]), policy);
		expect(violations).toEqual([]);
	});
});

// ── Privacy gate ──

describe("checkReducerPrivacy", () => {
	test("a field classified as secret, kept raw, is a violation", () => {
		const elements = [el("a", { fields: { api_key: "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa" } })];
		const violations = checkReducerPrivacy(elements, new Set(["a"]));
		expect(violations).toHaveLength(1);
		expect(violations[0]?.required_action).toBe("drop");
	});

	test("omitting a sensitive field entirely (already dropped by the caller) is compliant", () => {
		// hash downgrades to drop without a salt; the transformed value is undefined.
		// Simulate a caller that already dropped it by omitting the field entirely.
		const elements = [el("a", { fields: {} })];
		const violations = checkReducerPrivacy(elements, new Set(["a"]));
		expect(violations).toEqual([]);
	});

	test("an ordinary non-sensitive field is never flagged", () => {
		const elements = [el("a", { fields: { status: "working" } })];
		const violations = checkReducerPrivacy(elements, new Set(["a"]));
		expect(violations).toEqual([]);
	});

	test("a sensitive field on an element NOT in the candidate set is not checked", () => {
		const elements = [el("a", { fields: { api_key: "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa" } })];
		const violations = checkReducerPrivacy(elements, new Set([]));
		expect(violations).toEqual([]);
	});

	test("a hash-classified PII value is a violation unless the caller already applied the policy", () => {
		const salt = "0123456789abcdef";
		const elements = [el("a", { fields: { user_email: "person@example.com" } })];
		const violations = checkReducerPrivacy(elements, new Set(["a"]), { salt });
		expect(violations).toHaveLength(1);
		expect(violations[0]?.required_action).toBe("hash");
	});
});

// ── Causal-explanation gate ──

function makeGraph(): { nodes: CausalNode[]; edges: CausalEdge[] } {
	const nodes: CausalNode[] = [
		{ id: "root", kind: "service", status: "failed", ts: 1, message: "db down" },
		{ id: "mid", kind: "tool", status: "failed", ts: 2 },
		{ id: "symptom", kind: "agent", status: "failed", ts: 3 },
		{ id: "unrelated_ok", kind: "tool", status: "ok", ts: 0 },
	];
	const edges: CausalEdge[] = [
		{ from: "root", to: "mid", type: "causes" },
		{ from: "mid", to: "symptom", type: "causes" },
	];
	return { nodes, edges };
}

describe("checkCausalExplanationPreserved", () => {
	test("keeping the root cause node preserves the explanation", () => {
		const { nodes, edges } = makeGraph();
		const check = checkCausalExplanationPreserved(
			nodes,
			edges,
			new Set(["root", "mid", "symptom"]),
		);
		expect(check.preserved).toBe(true);
		expect(check.original_root_cause).toBe("root");
		expect(check.candidate_root_cause).toBe("root");
	});

	test("removing the root cause node breaks the explanation", () => {
		const { nodes, edges } = makeGraph();
		const check = checkCausalExplanationPreserved(nodes, edges, new Set(["mid", "symptom"]));
		expect(check.preserved).toBe(false);
		expect(check.original_root_cause).toBe("root");
		expect(check.candidate_root_cause).toBe("mid");
	});

	test("removing everything leaves no root cause at all, reported distinctly", () => {
		const { nodes, edges } = makeGraph();
		const check = checkCausalExplanationPreserved(nodes, edges, new Set([]));
		expect(check.preserved).toBe(false);
		expect(check.candidate_root_cause).toBeUndefined();
		expect(check.reason).toContain("no root cause remains");
	});

	test("a graph with no root cause at all is trivially preserved", () => {
		const check = checkCausalExplanationPreserved([], [], new Set([]));
		expect(check.preserved).toBe(true);
	});
});

// ── Composition: extractMultiKindRepro ──

describe("extractMultiKindRepro", () => {
	test("reduces a multi-kind bundle to the minimal culprit when all three gates pass", async () => {
		const elements: ReproElement[] = [
			el("ev1", { kind: "event" }),
			el("art1", { kind: "artifact" }),
			el("cfg1", { kind: "config" }),
			el("tool1", { kind: "tool_result", required_command: "npm test" }),
			el("noise1", { kind: "event" }),
			el("noise2", { kind: "artifact" }),
		];
		const result = await extractMultiKindRepro(elements, requiring(["tool1"]), {
			command_policy: policy,
		});
		expect(result.elements.map((e) => e.id)).toEqual(["tool1"]);
		expect(result.gate_rejections).toEqual([]);
	});

	test("an authority-violating minimal candidate is rejected, leaving the bundle unreduced rather than unsafe", async () => {
		// "unsafe" alone is sufficient to reproduce, but its required_command is
		// denied by policy; a naive reducer would happily shrink to just it.
		const elements: ReproElement[] = [
			el("unsafe", { kind: "tool_result", required_command: "sudo rm -rf /" }),
			el("noise", { kind: "event" }),
		];
		const oracle: ReductionOracle = (ids) => {
			const present = new Set(ids);
			return present.has("unsafe")
				? { reproduces: true, cause_signature: "X" }
				: { reproduces: false };
		};
		const result = await extractMultiKindRepro(elements, oracle, { command_policy: policy });
		// The reducer refuses the unsafe-only reduction, so the bundle stays at
		// its original (safe, unreduced) size rather than shrinking to something
		// the original command policy would never have permitted.
		expect(result.elements.map((e) => e.id).sort()).toEqual(["noise", "unsafe"]);
		expect(result.minimality).toBe("not_reduced");
		expect(result.gate_rejections.some((r) => r.gate === "authority")).toBe(true);
	});

	test("when a safe alternative also reproduces, the search can still land there instead of the unsafe one", async () => {
		const elements: ReproElement[] = [
			el("unsafe", { kind: "tool_result", required_command: "sudo rm -rf /" }),
			el("safe", { kind: "tool_result", required_command: "npm test" }),
		];
		const oracle: ReductionOracle = (ids) => {
			const present = new Set(ids);
			const reproduces = present.has("unsafe") || present.has("safe");
			return reproduces ? { reproduces: true, cause_signature: "X" } : { reproduces: false };
		};
		const result = await extractMultiKindRepro(elements, oracle, { command_policy: policy });
		expect(result.elements.map((e) => e.id)).toEqual(["safe"]);
	});

	test("a privacy-violating minimal candidate is rejected, leaving the bundle unreduced rather than exfiltrating a secret", async () => {
		const elements: ReproElement[] = [
			el("secret_holder", {
				kind: "artifact",
				fields: { api_key: "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa" },
			}),
			el("noise", { kind: "event" }),
		];
		const oracle: ReductionOracle = (ids) => {
			const present = new Set(ids);
			return present.has("secret_holder")
				? { reproduces: true, cause_signature: "X" }
				: { reproduces: false };
		};
		const result = await extractMultiKindRepro(elements, oracle, { command_policy: policy });
		expect(result.elements.map((e) => e.id).sort()).toEqual(["noise", "secret_holder"]);
		expect(result.minimality).toBe("not_reduced");
		expect(result.gate_rejections.some((r) => r.gate === "privacy")).toBe(true);
	});

	test("when a clean alternative also reproduces, the search can still land there instead of the secret-carrying one", async () => {
		const elements: ReproElement[] = [
			el("secret_holder", {
				kind: "artifact",
				fields: { api_key: "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa" },
			}),
			el("clean", { kind: "artifact", fields: { status: "working" } }),
		];
		const oracle: ReductionOracle = (ids) => {
			const present = new Set(ids);
			const reproduces = present.has("secret_holder") || present.has("clean");
			return reproduces ? { reproduces: true, cause_signature: "X" } : { reproduces: false };
		};
		const result = await extractMultiKindRepro(elements, oracle, { command_policy: policy });
		expect(result.elements.map((e) => e.id)).toEqual(["clean"]);
	});

	test("a candidate that drops the causal root cause is rejected even though the base oracle still 'fails'", async () => {
		const { nodes, edges } = makeGraph();
		const elements: ReproElement[] = [
			el("root", { kind: "event" }),
			el("mid", { kind: "event" }),
			el("symptom", { kind: "event" }),
		];
		// The oracle "fails" (reproduces) as long as symptom is present, even
		// without root -- a naive reducer would happily drop root and mid.
		const oracle: ReductionOracle = (ids) => {
			const present = new Set(ids);
			return present.has("symptom")
				? { reproduces: true, cause_signature: "X" }
				: { reproduces: false };
		};
		const result = await extractMultiKindRepro(elements, oracle, {
			command_policy: policy,
			causal_nodes: nodes,
			causal_edges: edges,
		});
		// root must survive because it is the causal explanation, even though
		// the base oracle alone would have accepted {symptom} as sufficient.
		expect(result.elements.map((e) => e.id)).toContain("root");
		expect(result.gate_rejections.some((r) => r.gate === "causal_explanation")).toBe(true);
	});

	test("omitting causal_nodes skips the causal-explanation gate entirely", async () => {
		const elements: ReproElement[] = [el("a", { kind: "event" }), el("b", { kind: "event" })];
		const result = await extractMultiKindRepro(elements, requiring(["a"]), {
			command_policy: policy,
		});
		expect(result.elements.map((e) => e.id)).toEqual(["a"]);
		expect(result.gate_rejections.every((r) => r.gate !== "causal_explanation")).toBe(true);
	});

	test("a non-reproducing full bundle is reported as not_reduced, same as item 70's base case", async () => {
		const elements: ReproElement[] = [el("a"), el("b")];
		const result = await extractMultiKindRepro(elements, () => ({ reproduces: false }), {
			command_policy: policy,
		});
		expect(result.minimality).toBe("not_reduced");
		expect(result.gate_rejections).toEqual([]);
	});
});

// ── Rendering ──

describe("renderGateRejections", () => {
	test("renders an authority rejection readably", () => {
		const lines = renderGateRejections([
			{
				gate: "authority",
				violations: [{ element_id: "a", command: "sudo rm -rf /", reason: "not permitted" }],
			},
		]);
		expect(lines[0]).toContain("authority");
		expect(lines[0]).toContain("sudo rm -rf /");
	});

	test("renders a privacy rejection readably", () => {
		const lines = renderGateRejections([
			{
				gate: "privacy",
				violations: [
					{ element_id: "a", field: "api_key", required_action: "drop", kept_value: "x" },
				],
			},
		]);
		expect(lines[0]).toContain("privacy");
		expect(lines[0]).toContain("dropped");
	});

	test("renders a causal-explanation rejection readably", () => {
		const lines = renderGateRejections([
			{
				gate: "causal_explanation",
				check: {
					preserved: false,
					original_root_cause: "root",
					candidate_root_cause: "mid",
					reason: "a different explanation",
				},
			},
		]);
		expect(lines[0]).toContain("causal_explanation");
		expect(lines[0]).toContain("a different explanation");
	});
});
