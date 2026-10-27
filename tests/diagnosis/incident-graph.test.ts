/**
 * Cross-agent causal incident graph tests (item 22).
 *
 * Reconstructs delegation, message, memory, tool, and environment edges
 * across traces produced by DIFFERENT agents, reusing item 38's causal
 * ranking and item 8's partial-order evidence combination rather than
 * inventing a second notion of "before" — a clock-skewed guess about two
 * agents' shared resource access must never be asserted as a fact.
 */
import { describe, expect, test } from "bun:test";
import {
	type AgentEvent,
	buildIncidentGraph,
} from "../../src/diagnosis/incident-graph.js";

describe("buildIncidentGraph (item 22)", () => {
	test("reconstructs delegation + message edges and ranks the worker's failure as the first propagating fault", () => {
		const events: AgentEvent[] = [
			{
				id: "planner-delegate",
				trace_id: "t1",
				agent_id: "planner",
				kind: "delegation",
				ts_ms: 0,
				target_agent_id: "worker",
				message: "delegate checkout task",
			},
			{
				// The worker's tool call failed, and this event IS the worker telling
				// the reviewer about it -- kind "message" because that is the relation
				// this test is tracing (delegation -> this -> reviewer), not because a
				// tool was never involved (see `resource_key`/`db_tool` below, and the
				// shares_tool_with test for the tool-sharing edge on its own).
				id: "worker-fail",
				trace_id: "t1",
				agent_id: "worker",
				kind: "message",
				ts_ms: 10,
				target_agent_id: "reviewer",
				failed: true,
				message: "db_tool timed out; notifying reviewer",
			},
			{
				id: "reviewer-review-fail",
				trace_id: "t1",
				agent_id: "reviewer",
				kind: "memory_access",
				ts_ms: 50,
				resource_key: "shared_cache",
				failed: true,
				message: "review aborted: stale cache",
			},
		];

		const result = buildIncidentGraph(events);

		// delegation/message are explicit causal facts: edges are drawn.
		expect(result.edges).toEqual(
			expect.arrayContaining([
				{ from: "planner-delegate", to: "worker-fail", type: "delegates_to" },
				{ from: "worker-fail", to: "reviewer-review-fail", type: "sends_message_to" },
			]),
		);

		// The worker's failure has no FAILED upstream cause (the delegation event
		// is not itself failed) -- it is the first propagating fault, not the
		// planner's (ok) delegation or the reviewer's (downstream) failure.
		expect(result.first_propagating_fault?.node_id).toBe("worker-fail");
		expect(result.first_propagating_fault?.downstream_failures).toBe(1);
		expect(result.first_propagating_fault?.evidence_path).toEqual([
			"worker-fail",
			"reviewer-review-fail",
		]);
	});

	test("shared memory/tool/environment access gets an edge only when order is determined, never both directions", () => {
		const events: AgentEvent[] = [
			{
				id: "agent-a-access",
				trace_id: "trace-a",
				agent_id: "agent-a",
				kind: "environment_access",
				ts_ms: 1000,
				resource_key: "shared_env_var",
				failed: true,
				message: "agent-a read a poisoned env var",
			},
			{
				id: "agent-b-access",
				trace_id: "trace-b",
				agent_id: "agent-b",
				kind: "environment_access",
				ts_ms: 1200,
				resource_key: "shared_env_var",
				failed: true,
				message: "agent-b read the same poisoned env var",
			},
		];

		const result = buildIncidentGraph(events);

		// Different traces with no clock anchor between them: the 200ms gap is
		// well inside the default unanchored uncertainty, so the order of the two
		// accesses is NOT determined. No `shares_environment_with` edge may be
		// invented in either direction.
		const envEdges = result.edges.filter((e) => e.type === "shares_environment_with");
		expect(envEdges).toHaveLength(0);
		expect(result.uncertainty.some((u) => u.includes("shared_env_var"))).toBe(true);
	});

	test("a clearly separated shared-resource access across agents gets exactly one directed edge, never two", () => {
		const events: AgentEvent[] = [
			{
				id: "agent-a-tool",
				trace_id: "trace-a",
				agent_id: "agent-a",
				kind: "tool_call",
				ts_ms: 0,
				resource_key: "search_tool",
				message: "agent-a calls search_tool",
			},
			{
				id: "agent-b-tool",
				trace_id: "trace-b",
				agent_id: "agent-b",
				kind: "tool_call",
				ts_ms: 1_000_000,
				resource_key: "search_tool",
				failed: true,
				message: "agent-b calls search_tool and it fails",
			},
		];

		const result = buildIncidentGraph(events);
		const toolEdges = result.edges.filter((e) => e.type === "shares_tool_with");
		expect(toolEdges).toEqual([{ from: "agent-a-tool", to: "agent-b-tool", type: "shares_tool_with" }]);
		// Never the reverse direction too.
		expect(
			toolEdges.some((e) => e.from === "agent-b-tool" && e.to === "agent-a-tool"),
		).toBe(false);
	});
});
