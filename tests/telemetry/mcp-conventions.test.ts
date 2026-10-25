import { describe, expect, test } from "bun:test";
import { classifyAttribute } from "../../src/telemetry/capture-policy.js";
import {
	FAILSAFE_MCP_TOOL_NAMES,
	MCP_LOSSY_FIELDS,
	MCP_METHOD_NAME,
	MCP_NETWORK_TRANSPORT,
	checkOwnedMcpOperation,
	mcpConventionsLossReport,
	mcpSpanAttributes,
	mcpSpanName,
} from "../../src/telemetry/mcp-conventions.js";

describe("MCP method/transport constants", () => {
	test("Failsafe's MCP server speaks exactly one JSON-RPC method: tools/call", () => {
		expect(MCP_METHOD_NAME).toBe("tools/call");
	});

	test("Failsafe's MCP server is stdio-only, so transport is always pipe", () => {
		expect(MCP_NETWORK_TRANSPORT).toBe("pipe");
	});

	test("span name follows the conventions' {mcp.method.name} {target} format", () => {
		expect(mcpSpanName("failsafe_analyze")).toBe("tools/call failsafe_analyze");
	});
});

describe("owned-operation validation", () => {
	test("the owned catalog is a non-empty, de-duplicated list", () => {
		expect(FAILSAFE_MCP_TOOL_NAMES.length).toBeGreaterThan(0);
		expect(new Set(FAILSAFE_MCP_TOOL_NAMES).size).toBe(FAILSAFE_MCP_TOOL_NAMES.length);
	});

	test("every tool actually registered on the live server is in the catalog", () => {
		// Mirrors tests/mcp/server.test.ts's "exposes all failsafe tools" list,
		// which is the ground truth for what the server registers. Hand-copied
		// here (not imported) so a change to one without the other is a visible
		// diff, not a silent pass.
		const registered = [
			"failsafe_analyze",
			"failsafe_apply",
			"failsafe_debug",
			"failsafe_diagnose",
			"failsafe_explain",
			"failsafe_history",
			"failsafe_inspect",
			"failsafe_repro",
			"failsafe_step",
			"failsafe_trace_diagnose",
			"failsafe_verify",
		];
		expect([...FAILSAFE_MCP_TOOL_NAMES].sort()).toEqual(
			registered.sort() as unknown as (typeof FAILSAFE_MCP_TOOL_NAMES)[number][],
		);
	});

	test("a registered tool name is owned", () => {
		const check = checkOwnedMcpOperation("failsafe_analyze");
		expect(check.owned).toBe(true);
	});

	test("an unrecognized tool name is not owned, with a stated reason", () => {
		const check = checkOwnedMcpOperation("some_other_servers_tool");
		expect(check.owned).toBe(false);
		if (!check.owned) {
			expect(check.reason).toContain("some_other_servers_tool");
			expect(check.reason.toLowerCase()).toContain("not");
		}
	});
});

describe("mcpSpanAttributes: owned operation", () => {
	test("carries the conventions' required/recommended attributes", () => {
		const attrs = mcpSpanAttributes({
			toolName: "failsafe_diagnose",
			sessionId: "sess-123",
			isToolError: false,
		});
		expect(attrs["mcp.method.name"]).toBe("tools/call");
		expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
		expect(attrs["gen_ai.tool.name"]).toBe("failsafe_diagnose");
		expect(attrs["network.transport"]).toBe("pipe");
		expect(attrs["mcp.session.id"]).toBe("sess-123");
		expect(attrs["error.type"]).toBeUndefined();
	});

	test("mcp.session.id is omitted (not emitted as empty/null) when the transport has no session", () => {
		const attrs = mcpSpanAttributes({ toolName: "failsafe_analyze", isToolError: false });
		expect(attrs["mcp.session.id"]).toBeUndefined();
	});

	test("a tool_error result maps error.type per the conventions' isError guidance", () => {
		const attrs = mcpSpanAttributes({ toolName: "failsafe_apply", isToolError: true });
		expect(attrs["error.type"]).toBe("tool_error");
	});

	test("never fabricates mcp.protocol.version, client.*, or server.* attributes", () => {
		const attrs = mcpSpanAttributes({ toolName: "failsafe_verify", isToolError: false });
		expect(attrs["mcp.protocol.version"]).toBeUndefined();
		expect(attrs["client.address"]).toBeUndefined();
		expect(attrs["client.port"]).toBeUndefined();
		expect(attrs["server.address"]).toBeUndefined();
		expect(attrs["server.port"]).toBeUndefined();
	});
});

describe("mcpSpanAttributes: unowned operation", () => {
	test("never invents gen_ai.tool.name/mcp.method.name for an operation outside the catalog", () => {
		const attrs = mcpSpanAttributes({ toolName: "not_a_failsafe_tool", isToolError: false });
		expect(attrs["gen_ai.tool.name"]).toBeUndefined();
		expect(attrs["mcp.method.name"]).toBeUndefined();
		expect(attrs["gen_ai.operation.name"]).toBeUndefined();
		// The fact of the mismatch is still surfaced, not silently dropped.
		expect(attrs["failsafe.mcp.unowned_operation"]).toBe("not_a_failsafe_tool");
	});
});

describe("documented lossy/unsupported fields", () => {
	test("every entry has a key and a non-empty reason", () => {
		expect(MCP_LOSSY_FIELDS.length).toBeGreaterThan(0);
		for (const entry of MCP_LOSSY_FIELDS) {
			expect(entry.key.length).toBeGreaterThan(0);
			expect(entry.reason.length).toBeGreaterThan(10);
		}
	});

	test("mcp.protocol.version is declared lossy with the real SDK-level reason", () => {
		const entry = MCP_LOSSY_FIELDS.find((e) => e.key === "mcp.protocol.version");
		expect(entry).toBeDefined();
		expect(entry?.reason.toLowerCase()).toContain("negotiated");
	});

	test("client/server address+port are declared lossy because the transport is stdio-only", () => {
		for (const key of ["client.address", "client.port", "server.address", "server.port"]) {
			const entry = MCP_LOSSY_FIELDS.find((e) => e.key === key);
			expect(entry).toBeDefined();
			expect(entry?.reason.toLowerCase()).toContain("stdio");
		}
	});

	test("mcpConventionsLossReport renders one line per lossy field, each naming its key", () => {
		const lines = mcpConventionsLossReport();
		expect(lines.length).toBe(MCP_LOSSY_FIELDS.length);
		for (const entry of MCP_LOSSY_FIELDS) {
			expect(lines.some((l) => l.includes(entry.key) && l.includes(entry.reason))).toBe(true);
		}
	});
});

describe("capture-policy classification of new MCP attributes", () => {
	test("mcp.method.name, network.transport, and error.type are closed-enum metadata", () => {
		expect(classifyAttribute("mcp.method.name", "tools/call")).toBe("metadata");
		expect(classifyAttribute("network.transport", "pipe")).toBe("metadata");
		expect(classifyAttribute("error.type", "tool_error")).toBe("metadata");
	});

	test("mcp.session.id is deliberately content, not metadata (same reasoning as gen_ai.conversation.id)", () => {
		expect(classifyAttribute("mcp.session.id", "sess-123")).toBe("content");
	});
});
