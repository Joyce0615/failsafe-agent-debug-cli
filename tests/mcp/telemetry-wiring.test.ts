/**
 * MCP server telemetry wiring (item 11).
 *
 * `tests/telemetry/mcp-conventions.test.ts` proves `mcpSpanAttributes` builds
 * the right facts in isolation. It does not prove the live server actually
 * calls it for a real tool invocation — the same reachability gap item 11's
 * research notes point at for `agent_hook`'s risk classifier. This file
 * closes that gap by replacing `withSpan` with a recording fake *before*
 * `src/mcp/server.ts` is imported, then driving the real server through a
 * real MCP `Client` over `InMemoryTransport`, exactly like
 * `tests/mcp/server.test.ts` does.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

type RecordedSpan = { name: string; attrs: Record<string, unknown> };
const spans: RecordedSpan[] = [];

// mock.module replaces the module registry entry for ALL files in this test
// run, not just this one — so the factory must re-export everything real
// callers of otel.ts need (applyAttributes, shutdownTelemetry,
// recordExceptionEvent, ...), not just withSpan, or unrelated files that
// import the real module later in the same run (tests/telemetry/*.test.ts)
// break with "export not found". The real exports are snapshotted into a
// plain object (not re-imported later) because mock.module leaves the
// registry entry mocked even after the mocking file's tests finish —
// `realOtelSnapshot` is what afterAll re-installs so later files in the same
// run see the genuine module again, not whatever the live binding has become.
const realOtelModule = await import("../../src/telemetry/otel.js");
const realOtelSnapshot = { ...realOtelModule };

mock.module("../../src/telemetry/otel.js", () => ({
	...realOtelSnapshot,
	isTelemetryEnabled: () => true,
	withSpan: async <T>(
		name: string,
		fn: (setAttributes: (attrs: Record<string, unknown>) => void) => Promise<T>,
	): Promise<T> => {
		let attrs: Record<string, unknown> = {};
		const result = await fn((a) => {
			attrs = a;
		});
		spans.push({ name, attrs });
		return result;
	},
}));

const { createFailsafeMcpServer } = await import("../../src/mcp/server.js");



let client: Client;
let workDir: string;
let originalCwd: string;

beforeAll(async () => {
	originalCwd = process.cwd();
	workDir = mkdtempSync(join(tmpdir(), "failsafe-mcp-telemetry-"));
	process.chdir(workDir);

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createFailsafeMcpServer();
	await server.connect(serverTransport);

	client = new Client({ name: "telemetry-test-client", version: "1.0.0" });
	await client.connect(clientTransport);
});

afterAll(async () => {
	await client.close();
	process.chdir(originalCwd);
	rmSync(workDir, { recursive: true, force: true });
	// Re-install the real otel.ts exports so later files in the same test run
	// (e.g. tests/telemetry/otel.test.ts) see the genuine module, not this
	// file's recording fake. mock.module has no "undo" of its own — the only
	// way back is to mock.module the real snapshot back in.
	mock.module("../../src/telemetry/otel.js", () => realOtelSnapshot);
});

describe("every tools/call reaches withSpan with real mcp-conventions attributes", () => {
	test("failsafe_analyze emits an owned-operation span", async () => {
		await client.callTool({
			name: "failsafe_analyze",
			arguments: { command: 'node -e "process.exit(1)"' },
		});
		const span = spans.find((s) => s.name === "tools/call failsafe_analyze");
		expect(span).toBeDefined();
		expect(span?.attrs["mcp.method.name"]).toBe("tools/call");
		expect(span?.attrs["gen_ai.tool.name"]).toBe("failsafe_analyze");
		expect(span?.attrs["network.transport"]).toBe("pipe");
	});

	test("failsafe_step (always isError) is attributed as a tool_error, not a thrown JSON-RPC fault", async () => {
		spans.length = 0;
		await client.callTool({ name: "failsafe_step", arguments: { session: "s1" } });
		const span = spans.find((s) => s.name === "tools/call failsafe_step");
		expect(span).toBeDefined();
		expect(span?.attrs["error.type"]).toBe("tool_error");
	});

	test("the span's isError reading is the SAME value the client receives, not a re-derived guess", async () => {
		spans.length = 0;
		const res = (await client.callTool({
			name: "failsafe_diagnose",
			arguments: { failure_id: "does_not_exist" },
		})) as { isError?: boolean };
		const span = spans.find((s) => s.name === "tools/call failsafe_diagnose");
		expect(span).toBeDefined();
		expect(Boolean(span?.attrs["error.type"] === "tool_error")).toBe(res.isError === true);
	});

	test("every one of the server's ten owned tools produces a span under its own name", async () => {
		spans.length = 0;
		await client.callTool({ name: "failsafe_history", arguments: {} });
		await client.callTool({ name: "failsafe_inspect", arguments: { session: "s1" } });
		const names = spans.map((s) => s.name);
		expect(names).toContain("tools/call failsafe_history");
		expect(names).toContain("tools/call failsafe_inspect");
	});
});
