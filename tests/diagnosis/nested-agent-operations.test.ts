import { describe, expect, test } from "bun:test";
import {
	buildNestedTree,
	classifyNestedRole,
	detectAuthorityDrift,
	detectDuplicateRecording,
	detectMisattributedCost,
	diagnoseNestedOperations,
	renderNestedOperationReport,
} from "../../src/diagnosis/nested-agent-operations.js";
import type { GenAiSpan } from "../../src/trace/genai-normalize.js";

function span(overrides: Partial<GenAiSpan> = {}): GenAiSpan {
	return {
		span_id: "s1",
		name: "span",
		kind: "unknown",
		inferred_kind: false,
		start_ms: 0,
		duration_ms: 10,
		...overrides,
	};
}

describe("classifyNestedRole", () => {
	test("a known GenAiKind passes through unchanged", () => {
		expect(classifyNestedRole(span({ kind: "agent" }))).toBe("agent");
		expect(classifyNestedRole(span({ kind: "tool" }))).toBe("tool");
	});

	test("an unknown kind with a currently-unmapped 'retrieval' operation resolves to retrieval", () => {
		expect(classifyNestedRole(span({ kind: "unknown", operation: "retrieval" }))).toBe("retrieval");
	});

	test("an unknown kind with a memory operation resolves to memory", () => {
		for (const op of [
			"create_memory",
			"create_memory_store",
			"delete_memory",
			"delete_memory_store",
			"search_memory",
			"update_memory",
			"upsert_memory",
		]) {
			expect(classifyNestedRole(span({ kind: "unknown", operation: op }))).toBe("memory");
		}
	});

	test("invoke_workflow and invoke_runner resolve to workflow", () => {
		expect(classifyNestedRole(span({ kind: "unknown", operation: "invoke_workflow" }))).toBe(
			"workflow",
		);
		expect(classifyNestedRole(span({ kind: "unknown", operation: "invoke_runner" }))).toBe(
			"workflow",
		);
	});

	test("an unknown kind with an unrecognized operation stays unknown", () => {
		expect(classifyNestedRole(span({ kind: "unknown", operation: "something_else" }))).toBe(
			"unknown",
		);
	});

	test("an unknown kind with no operation at all stays unknown", () => {
		expect(classifyNestedRole(span({ kind: "unknown" }))).toBe("unknown");
	});
});

describe("buildNestedTree", () => {
	test("spans with no parent become roots, children nest under their parent", () => {
		const spans = [
			span({ span_id: "root", kind: "workflow" }),
			span({ span_id: "child", kind: "agent", parent_span_id: "root" }),
		];
		const tree = buildNestedTree(spans);
		expect(tree.roots).toHaveLength(1);
		expect(tree.roots[0].span.span_id).toBe("root");
		expect(tree.roots[0].children).toHaveLength(1);
		expect(tree.roots[0].children[0].span.span_id).toBe("child");
		expect(tree.lost_parents).toEqual([]);
	});

	test("a span whose declared parent is absent is walked as its own root AND recorded as a lost parent", () => {
		const spans = [span({ span_id: "orphan", parent_span_id: "ghost" })];
		const tree = buildNestedTree(spans);
		expect(tree.roots).toHaveLength(1);
		expect(tree.roots[0].span.span_id).toBe("orphan");
		expect(tree.lost_parents).toEqual([
			{ missing_parent_span_id: "ghost", orphan_span_ids: ["orphan"] },
		]);
	});

	test("multiple orphans under the same missing parent are grouped together", () => {
		const spans = [
			span({ span_id: "o1", parent_span_id: "ghost" }),
			span({ span_id: "o2", parent_span_id: "ghost" }),
		];
		const tree = buildNestedTree(spans);
		expect(tree.lost_parents).toHaveLength(1);
		expect(tree.lost_parents[0].orphan_span_ids).toEqual(["o1", "o2"]);
	});

	test("children are ordered by start time then span id, not input order", () => {
		const spans = [
			span({ span_id: "root", kind: "workflow" }),
			span({ span_id: "c2", kind: "tool", parent_span_id: "root", start_ms: 20 }),
			span({ span_id: "c1", kind: "tool", parent_span_id: "root", start_ms: 10 }),
		];
		const tree = buildNestedTree(spans);
		expect(tree.roots[0].children.map((c) => c.span.span_id)).toEqual(["c1", "c2"]);
	});
});

describe("detectDuplicateRecording", () => {
	test("a parent/child pair in the same service agreeing on operation+tokens over the same window is flagged", () => {
		const spans = [
			span({
				span_id: "outer",
				kind: "tool",
				service: "svc",
				operation: "execute_tool",
				tool_name: "search",
				input_tokens: 5,
				start_ms: 0,
				duration_ms: 20,
			}),
			span({
				span_id: "inner",
				kind: "tool",
				parent_span_id: "outer",
				service: "svc",
				operation: "execute_tool",
				tool_name: "search",
				input_tokens: 5,
				start_ms: 0,
				duration_ms: 20,
			}),
		];
		const tree = buildNestedTree(spans);
		const findings = detectDuplicateRecording(tree);
		expect(findings).toHaveLength(1);
		expect(findings[0].outer_span_id).toBe("outer");
		expect(findings[0].inner_span_id).toBe("inner");
		expect(findings[0].matched_fields).toContain("operation");
		expect(findings[0].matched_fields).toContain("tool_name");
	});

	test("a legitimate client/internal agent pair crossing services is never flagged", () => {
		const spans = [
			span({
				span_id: "client",
				kind: "agent",
				service: "caller-svc",
				agent_name: "planner",
				start_ms: 0,
				duration_ms: 50,
			}),
			span({
				span_id: "internal",
				kind: "agent",
				parent_span_id: "client",
				service: "agent-svc",
				agent_name: "planner",
				start_ms: 0,
				duration_ms: 50,
			}),
		];
		const tree = buildNestedTree(spans);
		expect(detectDuplicateRecording(tree)).toEqual([]);
	});

	test("a pair with no service declared on either side is never flagged", () => {
		const spans = [
			span({ span_id: "outer", kind: "tool", operation: "execute_tool", tool_name: "x" }),
			span({
				span_id: "inner",
				kind: "tool",
				parent_span_id: "outer",
				operation: "execute_tool",
				tool_name: "x",
			}),
		];
		const tree = buildNestedTree(spans);
		expect(detectDuplicateRecording(tree)).toEqual([]);
	});

	test("a pair sharing a service but disagreeing on a shared field is not flagged", () => {
		const spans = [
			span({
				span_id: "outer",
				kind: "tool",
				service: "svc",
				operation: "execute_tool",
				tool_name: "search",
			}),
			span({
				span_id: "inner",
				kind: "tool",
				parent_span_id: "outer",
				service: "svc",
				operation: "execute_tool",
				tool_name: "fetch",
			}),
		];
		const tree = buildNestedTree(spans);
		expect(detectDuplicateRecording(tree)).toEqual([]);
	});

	test("a pair sharing a service with no overlapping fields at all is not flagged", () => {
		const spans = [
			span({ span_id: "outer", kind: "workflow", service: "svc" }),
			span({ span_id: "inner", kind: "tool", parent_span_id: "outer", service: "svc" }),
		];
		const tree = buildNestedTree(spans);
		expect(detectDuplicateRecording(tree)).toEqual([]);
	});

	test("a pair in the same service and window but non-overlapping window is not flagged", () => {
		const spans = [
			span({
				span_id: "outer",
				kind: "tool",
				service: "svc",
				operation: "execute_tool",
				tool_name: "search",
				start_ms: 0,
				duration_ms: 10,
			}),
			span({
				span_id: "inner",
				kind: "tool",
				parent_span_id: "outer",
				service: "svc",
				operation: "execute_tool",
				tool_name: "search",
				start_ms: 100,
				duration_ms: 10,
			}),
		];
		const tree = buildNestedTree(spans);
		expect(detectDuplicateRecording(tree)).toEqual([]);
	});

	test("non-adjacent spans (grandparent/grandchild) are never compared", () => {
		const spans = [
			span({
				span_id: "gp",
				kind: "tool",
				service: "svc",
				operation: "execute_tool",
				tool_name: "search",
			}),
			span({ span_id: "mid", kind: "llm", parent_span_id: "gp", service: "svc" }),
			span({
				span_id: "gc",
				kind: "tool",
				parent_span_id: "mid",
				service: "svc",
				operation: "execute_tool",
				tool_name: "search",
			}),
		];
		const tree = buildNestedTree(spans);
		expect(detectDuplicateRecording(tree)).toEqual([]);
	});
});

describe("detectMisattributedCost", () => {
	test("a span whose self-declared agent_name disagrees with its structural ancestor agent is flagged", () => {
		const spans = [
			span({ span_id: "root", kind: "agent", agent_name: "planner" }),
			span({
				span_id: "leaf",
				kind: "llm",
				parent_span_id: "root",
				agent_name: "researcher",
				input_tokens: 10,
				output_tokens: 20,
			}),
		];
		const tree = buildNestedTree(spans);
		const findings = detectMisattributedCost(tree, []);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			kind: "self_declared_mismatch",
			span_id: "leaf",
			declared_agent: "researcher",
			structural_agent: "planner",
			input_tokens: 10,
			output_tokens: 20,
		});
	});

	test("a span agreeing with its structural ancestor is never flagged", () => {
		const spans = [
			span({ span_id: "root", kind: "agent", agent_name: "planner" }),
			span({
				span_id: "leaf",
				kind: "llm",
				parent_span_id: "root",
				agent_name: "planner",
				input_tokens: 10,
			}),
		];
		const tree = buildNestedTree(spans);
		expect(detectMisattributedCost(tree, [])).toEqual([]);
	});

	test("a nested agent is compared to ITS OWN parent agent, never to itself", () => {
		const spans = [
			span({ span_id: "root", kind: "agent", agent_name: "planner" }),
			span({
				span_id: "sub",
				kind: "agent",
				parent_span_id: "root",
				agent_name: "researcher",
			}),
			span({
				span_id: "leaf",
				kind: "llm",
				parent_span_id: "sub",
				agent_name: "researcher",
				input_tokens: 5,
			}),
		];
		const tree = buildNestedTree(spans);
		// `sub` itself disagreeing with `root` is an authority-drift concern (tested
		// separately below), not a misattributed-cost one: `sub` has role "agent" and
		// is never compared against its own ancestor in this detector.
		const findings = detectMisattributedCost(tree, []);
		expect(findings).toEqual([]);
	});

	test("usage stranded under a lost parent is reported as orphaned_cost", () => {
		const spans = [
			span({
				span_id: "orphan",
				kind: "llm",
				parent_span_id: "ghost",
				input_tokens: 7,
				output_tokens: 3,
			}),
		];
		const tree = buildNestedTree(spans);
		const findings = detectMisattributedCost(tree, []);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			kind: "orphaned_cost",
			missing_parent_span_id: "ghost",
			span_ids: ["orphan"],
			input_tokens: 7,
			output_tokens: 3,
		});
	});

	test("an orphan with no usage at all produces no orphaned_cost finding", () => {
		const spans = [span({ span_id: "orphan", kind: "llm", parent_span_id: "ghost" })];
		const tree = buildNestedTree(spans);
		expect(detectMisattributedCost(tree, [])).toEqual([]);
	});

	test("the inner half of a flagged duplicate is excluded from the cost rollup", () => {
		const spans = [
			span({
				span_id: "outer",
				kind: "tool",
				service: "svc",
				operation: "execute_tool",
				tool_name: "x",
				input_tokens: 10,
				start_ms: 0,
				duration_ms: 10,
			}),
			span({
				span_id: "inner",
				kind: "tool",
				parent_span_id: "outer",
				service: "svc",
				operation: "execute_tool",
				tool_name: "x",
				input_tokens: 10,
				start_ms: 0,
				duration_ms: 10,
			}),
			span({
				span_id: "ghostchild",
				kind: "llm",
				parent_span_id: "ghost",
				input_tokens: 4,
			}),
		];
		const tree = buildNestedTree(spans);
		const dup = detectDuplicateRecording(tree);
		expect(dup).toHaveLength(1);
		const findings = detectMisattributedCost(tree, dup);
		const orphaned = findings.find((f) => f.kind === "orphaned_cost");
		// `ghostchild` is unrelated to the duplicate pair; its own usage still counts.
		expect(orphaned).toMatchObject({ input_tokens: 4 });
	});
});

describe("detectAuthorityDrift", () => {
	test("a direct agent-under-agent edge with a different agent_name is flagged unconditionally", () => {
		const spans = [
			span({ span_id: "parent", kind: "agent", agent_name: "planner" }),
			span({ span_id: "child", kind: "agent", parent_span_id: "parent", agent_name: "shadow" }),
		];
		const tree = buildNestedTree(spans);
		const findings = detectAuthorityDrift(tree);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			parent_span_id: "parent",
			parent_agent: "planner",
			child_span_id: "child",
			child_agent: "shadow",
		});
	});

	test("a direct agent-under-agent edge with the SAME agent_name is not flagged", () => {
		const spans = [
			span({ span_id: "parent", kind: "agent", agent_name: "planner" }),
			span({ span_id: "child", kind: "agent", parent_span_id: "parent", agent_name: "planner" }),
		];
		const tree = buildNestedTree(spans);
		expect(detectAuthorityDrift(tree)).toEqual([]);
	});

	test("a tool or llm span under an agent is never flagged (only agent-under-agent edges are)", () => {
		const spans = [
			span({ span_id: "parent", kind: "agent", agent_name: "planner" }),
			span({ span_id: "tool", kind: "tool", parent_span_id: "parent", agent_name: "whatever" }),
		];
		const tree = buildNestedTree(spans);
		expect(detectAuthorityDrift(tree)).toEqual([]);
	});

	test("an agent-under-agent edge where either side has no declared agent_name is not flagged", () => {
		const spans = [
			span({ span_id: "parent", kind: "agent" }),
			span({ span_id: "child", kind: "agent", parent_span_id: "parent", agent_name: "shadow" }),
		];
		const tree = buildNestedTree(spans);
		expect(detectAuthorityDrift(tree)).toEqual([]);
	});
});

describe("diagnoseNestedOperations", () => {
	test("composes tree + all three finding kinds into one report", () => {
		const spans = [
			span({ span_id: "root", kind: "workflow" }),
			span({ span_id: "agent1", kind: "agent", parent_span_id: "root", agent_name: "planner" }),
			span({
				span_id: "agent2",
				kind: "agent",
				parent_span_id: "agent1",
				agent_name: "shadow",
			}),
			span({
				span_id: "orphan",
				kind: "llm",
				parent_span_id: "ghost",
				input_tokens: 5,
			}),
		];
		const report = diagnoseNestedOperations(spans);
		expect(report.tree.roots.length).toBeGreaterThan(0);
		expect(report.authority_drift).toHaveLength(1);
		expect(report.misattributed_cost.some((f) => f.kind === "orphaned_cost")).toBe(true);
		expect(report.duplicate_recording).toEqual([]);
	});

	test("an empty span list produces an empty, well-formed report", () => {
		const report = diagnoseNestedOperations([]);
		expect(report.tree.roots).toEqual([]);
		expect(report.tree.lost_parents).toEqual([]);
		expect(report.duplicate_recording).toEqual([]);
		expect(report.misattributed_cost).toEqual([]);
		expect(report.authority_drift).toEqual([]);
	});
});

describe("renderNestedOperationReport", () => {
	test("renders section headers with counts even when every finding list is empty", () => {
		const report = diagnoseNestedOperations([]);
		const text = renderNestedOperationReport(report);
		expect(text).toContain("Lost parents (0)");
		expect(text).toContain("Duplicate recording (0)");
		expect(text).toContain("Misattributed cost (0)");
		expect(text).toContain("Authority drift (0)");
	});

	test("renders each finding's own detail line", () => {
		const spans = [
			span({ span_id: "parent", kind: "agent", agent_name: "planner" }),
			span({ span_id: "child", kind: "agent", parent_span_id: "parent", agent_name: "shadow" }),
		];
		const report = diagnoseNestedOperations(spans);
		const text = renderNestedOperationReport(report);
		expect(text).toContain("Authority drift (1)");
		expect(text).toContain("shadow");
		expect(text).toContain("planner");
	});
});
