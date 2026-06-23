/**
 * MCP orchestrator checkpoint contract test (ITEMS #21).
 *
 * The MCP server is positioned as a flow-orchestrator (AgentFlow/Statewright)
 * validation checkpoint. An orchestrator branches on three things and nothing
 * else: (1) the `isError` gating flag, (2) a stable JSON shape with the fields
 * it reads, and (3) exit-code parity with `src/cli/exit-codes.ts` for the error
 * branches. This suite drives the four tools as a real checkpoint sequence
 * (analyze -> diagnose -> repro -> verify) threading a single failure_id, and
 * pins those guarantees so the contract cannot silently drift.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { createFailsafeMcpServer } from "../../src/mcp/server.js";

let client: Client;
let workDir: string;
let originalCwd: string;

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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-mcp-checkpoint-"));
	process.chdir(workDir);

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createFailsafeMcpServer();
	await server.connect(serverTransport);

	client = new Client({ name: "checkpoint-client", version: "1.0.0" });
	await client.connect(clientTransport);
});

afterAll(async () => {
	await client.close();
	process.chdir(originalCwd);
	rmSync(workDir, { recursive: true, force: true });
});

describe("MCP checkpoint: full analyze -> diagnose -> repro -> verify sequence", () => {
	test("threads one failure_id and gates non-error at every step", async () => {
		// 1. analyze — the orchestrator's entry checkpoint.
		const analyze = await callTool("failsafe_analyze", { command: 'node -e "process.exit(1)"' });
		expect(analyze.isError).toBe(false);
		expect(analyze.json.failure_id).toBeDefined();
		expect(analyze.json.status).toBe("failed");
		const failureId = analyze.json.failure_id as string;

		// 2. diagnose — pass the EXPLICIT id (not "last") to prove id threading.
		const diagnose = await callTool("failsafe_diagnose", { failure_id: failureId });
		expect(diagnose.isError).toBe(false);
		expect(diagnose.json.failure_id).toBe(failureId);
		expect(diagnose.json.diagnosis_id).toBeDefined();
		expect(diagnose.json.severity).toBeDefined();
		expect(Array.isArray(diagnose.json.suggested_next_actions)).toBe(true);

		// 3. repro — same id.
		const repro = await callTool("failsafe_repro", { failure_id: failureId });
		expect(repro.isError).toBe(false);
		expect(repro.json.failure_id).toBe(failureId);
		expect(repro.json.repro_id).toBeDefined();
		expect(repro.json.command).toBeDefined();

		// 4. verify — same id. The command still exits 1, so the gating status is
		// "failed": an orchestrator would loop or escalate rather than advance.
		const verify = await callTool("failsafe_verify", { failure_id: failureId });
		expect(verify.isError).toBe(false);
		expect(verify.json.failure_id).toBe(failureId);
		expect(Array.isArray(verify.json.checks)).toBe(true);
		expect(verify.json.status).toBe("failed");
	}, 60_000);
});

describe("MCP checkpoint: error branches have exit-code parity with the CLI", () => {
	test("unknown failure id -> isError, exit_code NO_INPUT", async () => {
		const { isError, json } = await callTool("failsafe_diagnose", { failure_id: "fail_nope" });
		expect(isError).toBe(true);
		expect(json.error).toBe(true);
		expect(json.exit_code).toBe(ExitCode.NO_INPUT);
	});

	test("policy-blocked command -> isError, exit_code POLICY_BLOCK", async () => {
		const { isError, json } = await callTool("failsafe_analyze", { command: "rm -rf /" });
		expect(isError).toBe(true);
		expect(json.error).toBe(true);
		expect(json.exit_code).toBe(ExitCode.POLICY_BLOCK);
	});

	test("shell syntax without shell=true -> isError, exit_code ERROR + needs_shell", async () => {
		// A redirect on an allowed command passes the policy but fails argv
		// parsing, so it gates as ERROR + needs_shell (not a policy block).
		const { isError, json } = await callTool("failsafe_analyze", {
			command: "node --version > out.txt",
		});
		expect(isError).toBe(true);
		expect(json.error).toBe(true);
		expect(json.exit_code).toBe(ExitCode.ERROR);
		expect(json.needs_shell).toBe(true);
	});

	test("repro/verify on an unknown id also gate with NO_INPUT", async () => {
		const repro = await callTool("failsafe_repro", { failure_id: "fail_nope" });
		expect(repro.isError).toBe(true);
		expect(repro.json.exit_code).toBe(ExitCode.NO_INPUT);

		const verify = await callTool("failsafe_verify", { failure_id: "fail_nope" });
		expect(verify.isError).toBe(true);
		expect(verify.json.exit_code).toBe(ExitCode.NO_INPUT);
	});
});

describe("MCP checkpoint: deterministic gating", () => {
	test("the same input yields the same isError and key shape across calls", async () => {
		const first = await callTool("failsafe_diagnose", { failure_id: "fail_nope" });
		const second = await callTool("failsafe_diagnose", { failure_id: "fail_nope" });
		// Determinism is the property an orchestrator relies on to branch safely.
		expect(first.isError).toBe(second.isError);
		expect(Object.keys(first.json).sort()).toEqual(Object.keys(second.json).sort());
		expect(first.json.exit_code).toBe(second.json.exit_code);
	});
});
