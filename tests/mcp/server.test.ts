/**
 * MCP server tests.
 *
 * Drives the server through an in-memory transport with a real MCP client and
 * asserts each tool's response JSON matches the equivalent CLI contract,
 * including `isError` on failures and the analyze+diagnose chaining path.
 *
 * Tools read/write `.failsafe` under process.cwd(), so the suite runs in an
 * isolated temp working directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFailsafeMcpServer } from "../../src/mcp/server.js";

let client: Client;
let workDir: string;
let originalCwd: string;

/** Call a tool and return { isError, json } where json is the parsed text content. */
async function callTool(
	name: string,
	args: Record<string, unknown>,
): Promise<{ isError: boolean; json: Record<string, unknown> }> {
	const res = (await client.callTool({ name, arguments: args })) as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
	};
	return {
		isError: res.isError === true,
		json: JSON.parse(res.content[0].text) as Record<string, unknown>,
	};
}

beforeAll(async () => {
	originalCwd = process.cwd();
	workDir = mkdtempSync(join(tmpdir(), "failsafe-mcp-"));
	process.chdir(workDir);

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createFailsafeMcpServer();
	await server.connect(serverTransport);

	client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);
});

afterAll(async () => {
	await client.close();
	process.chdir(originalCwd);
	rmSync(workDir, { recursive: true, force: true });
});

describe("MCP server: tools/list", () => {
	test("exposes all four failsafe tools", async () => {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"failsafe_analyze",
			"failsafe_diagnose",
			"failsafe_repro",
			"failsafe_verify",
		]);
		// Each tool advertises an input schema with a description.
		for (const t of tools) {
			expect(t.description).toBeDefined();
			expect(t.inputSchema).toBeDefined();
		}
	});
});

describe("MCP server: failsafe_analyze", () => {
	test("captures a failing command (isError false, run contract)", async () => {
		const { isError, json } = await callTool("failsafe_analyze", {
			command: 'node -e "process.exit(1)"',
		});
		expect(isError).toBe(false);
		expect(json.status).toBe("failed");
		expect(json.exit_code).toBe(1);
		expect(json.failure_id).toBeDefined();
		expect(json.token_budget).toBeDefined();
	}, 30_000);

	test("diagnose=true chains run + diagnosis", async () => {
		const { isError, json } = await callTool("failsafe_analyze", {
			command: "python3 -c \"raise KeyError('x')\"",
			diagnose: true,
		});
		expect(isError).toBe(false);
		expect(json.run).toBeDefined();
		expect(json.diagnosis).toBeDefined();
		const diagnosis = json.diagnosis as Record<string, unknown>;
		expect(diagnosis.diagnosis_id).toBeDefined();
		expect(diagnosis.severity).toBeDefined();
	}, 30_000);

	test("blocked command returns isError with policy message", async () => {
		const { isError, json } = await callTool("failsafe_analyze", { command: "rm -rf /" });
		expect(isError).toBe(true);
		expect(json.error).toBe(true);
		expect(json.exit_code).toBe(3); // POLICY_BLOCK
		expect(json.message as string).toContain("blocked");
	});

	test("shell syntax without shell=true returns needs_shell error", async () => {
		const { isError, json } = await callTool("failsafe_analyze", {
			command: "node --version | cat",
		});
		expect(isError).toBe(true);
		expect(json.error).toBe(true);
	});
});

describe("MCP server: failsafe_diagnose", () => {
	test("diagnoses the last captured failure", async () => {
		await callTool("failsafe_analyze", { command: "python3 -c \"raise KeyError('y')\"" });
		const { isError, json } = await callTool("failsafe_diagnose", { failure_id: "last" });
		expect(isError).toBe(false);
		expect(json.diagnosis_id).toBeDefined();
		expect(json.failure_id).toBeDefined();
		expect(json.severity).toBeDefined();
		expect(json.suggested_next_actions).toBeDefined();
	}, 30_000);

	test("unknown failure id returns isError (NO_INPUT)", async () => {
		const { isError, json } = await callTool("failsafe_diagnose", { failure_id: "fail_missing" });
		expect(isError).toBe(true);
		expect(json.error).toBe(true);
		expect(json.exit_code).toBe(2); // NO_INPUT
	});
});

describe("MCP server: failsafe_repro", () => {
	test("returns a repro packet for the last failure", async () => {
		await callTool("failsafe_analyze", { command: "python3 -c \"raise KeyError('z')\"" });
		const { isError, json } = await callTool("failsafe_repro", { failure_id: "last" });
		expect(isError).toBe(false);
		expect(json.repro_id).toBeDefined();
		expect(json.command).toBeDefined();
		expect(json.failure_id).toBeDefined();
	}, 30_000);
});

describe("MCP server: failsafe_verify", () => {
	test("re-runs the original command and reports checks", async () => {
		await callTool("failsafe_analyze", { command: 'node -e "process.exit(1)"' });
		const { isError, json } = await callTool("failsafe_verify", { failure_id: "last" });
		expect(isError).toBe(false);
		expect(json.failure_id).toBeDefined();
		expect(Array.isArray(json.checks)).toBe(true);
		// Original command still exits 1, so verification fails.
		expect(json.status).toBe("failed");
	}, 30_000);
});
