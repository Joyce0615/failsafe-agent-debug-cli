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

/** Read the text body of a resource content entry (vs. the binary `blob` variant). */
function resourceText(content: unknown): string {
	return String((content as { text?: unknown }).text);
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
	test("exposes all failsafe tools", async () => {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"failsafe_analyze",
			"failsafe_apply",
			"failsafe_debug",
			"failsafe_diagnose",
			"failsafe_explain",
			"failsafe_history",
			"failsafe_inspect",
			"failsafe_repro",
			"failsafe_step",
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

describe("MCP server: failsafe_explain", () => {
	test("returns a combined-evidence explanation for the last failure", async () => {
		await callTool("failsafe_analyze", {
			command: "python3 -c \"raise KeyError('user_id')\"",
			diagnose: true,
		});
		const { isError, json } = await callTool("failsafe_explain", { failure_id: "last" });
		expect(isError).toBe(false);
		expect(json.failure_id).toBeDefined();
		expect(json.summary).toBeDefined();
		expect(Array.isArray(json.evidence)).toBe(true);
		expect(json.verify).toBeDefined();
	}, 30_000);

	test("unknown failure id returns isError (NO_INPUT)", async () => {
		const { isError, json } = await callTool("failsafe_explain", { failure_id: "fail_missing" });
		expect(isError).toBe(true);
		expect(json.error).toBe(true);
		expect(json.exit_code).toBe(2);
	});
});

describe("MCP server: failsafe_apply", () => {
	test("unknown failure id returns isError (NO_INPUT)", async () => {
		const { isError, json } = await callTool("failsafe_apply", { failure_id: "fail_missing" });
		expect(isError).toBe(true);
		expect(json.status).toBe("not_found");
	});

	test("a diagnosed failure with no declared fix_patch returns no_patch (guarded)", async () => {
		// Builtin diagnosis carries no authored fix_patch, so apply is a no-op —
		// and defaults to a dry run (confirm omitted), never touching the tree.
		await callTool("failsafe_analyze", {
			command: "python3 -c \"raise KeyError('x')\"",
			diagnose: true,
		});
		const { isError, json } = await callTool("failsafe_apply", { failure_id: "last" });
		expect(isError).toBe(true);
		expect(json.status).toBe("no_patch");
	}, 30_000);
});

describe("MCP server: failsafe_history", () => {
	test("lists prior failures", async () => {
		await callTool("failsafe_analyze", { command: 'node -e "process.exit(1)"' });
		const { isError, json } = await callTool("failsafe_history", { limit: 5 });
		expect(isError).toBe(false);
		expect(Array.isArray(json.failures)).toBe(true);
		expect((json.failures as unknown[]).length).toBeGreaterThan(0);
	}, 30_000);
});

describe("MCP server: failsafe_debug", () => {
	test("emits launch guidance for a supported runtime (or a structured unavailable packet)", async () => {
		await callTool("failsafe_analyze", { command: "python3 -c \"raise KeyError('x')\"" });
		const { isError, json } = await callTool("failsafe_debug", {
			failure_id: "last",
			break: "src/x.py:1",
		});
		if (!isError) {
			expect(json.mode).toBe("launch_guidance");
			expect(json.runtime).toBe("python");
		} else {
			// debugpy not installed → adapter_missing (still the debug contract).
			expect(json.error).toBe(true);
		}
	}, 30_000);

	test("go/rust/etc. return the unsupported_runtime packet (isError)", async () => {
		await callTool("failsafe_analyze", { command: 'node -e "process.exit(1)"' });
		const { isError, json } = await callTool("failsafe_debug", {
			failure_id: "last",
			break: "x:1",
			runtime: "go",
		});
		expect(isError).toBe(true);
		expect(json.unsupported_runtime).toBe(true);
		expect(json.runtime).toBe("go");
	}, 30_000);
});

describe("MCP server: failsafe_step / failsafe_inspect", () => {
	test("both return the debug_unavailable session-boundary packet", async () => {
		const step = await callTool("failsafe_step", { session: "dbg_missing" });
		expect(step.isError).toBe(true);
		expect(step.json.debug_unavailable).toBe(true);
		const inspect = await callTool("failsafe_inspect", { session: "dbg_missing" });
		expect(inspect.isError).toBe(true);
		expect(inspect.json.debug_unavailable).toBe(true);
	});
});

describe("MCP server: resources", () => {
	test("advertises the diagnosis and run-log resource templates", async () => {
		const { resourceTemplates } = await client.listResourceTemplates();
		const templates = resourceTemplates.map((r) => r.uriTemplate).sort();
		expect(templates).toEqual(["failsafe://diagnosis/{failure_id}", "failsafe://log/{failure_id}"]);
	});

	test("lists recent failures as diagnosis resources", async () => {
		await callTool("failsafe_analyze", { command: "python3 -c \"raise KeyError('res')\"" });
		const { resources } = await client.listResources();
		const diagnosisResources = resources.filter((r) => r.uri.startsWith("failsafe://diagnosis/"));
		expect(diagnosisResources.length).toBeGreaterThan(0);
		expect(diagnosisResources[0].mimeType).toBe("application/json");
	}, 30_000);

	test("reads a diagnosis resource by uri (diagnoses on demand)", async () => {
		const { json } = await callTool("failsafe_analyze", {
			command: "python3 -c \"raise KeyError('readres')\"",
		});
		const failureId = json.failure_id as string;
		const res = await client.readResource({ uri: `failsafe://diagnosis/${failureId}` });
		expect(res.contents).toHaveLength(1);
		expect(res.contents[0].mimeType).toBe("application/json");
		const packet = JSON.parse(resourceText(res.contents[0])) as Record<string, unknown>;
		expect(packet.diagnosis_id).toBeDefined();
		expect(packet.failure_id).toBe(failureId);
		expect(packet.severity).toBeDefined();
	}, 30_000);

	test("reads a run-log resource as plain text", async () => {
		const { json } = await callTool("failsafe_analyze", {
			command: "python3 -c \"raise KeyError('logres')\"",
		});
		const failureId = json.failure_id as string;
		const res = await client.readResource({ uri: `failsafe://log/${failureId}` });
		expect(res.contents[0].mimeType).toBe("text/plain");
		expect(resourceText(res.contents[0])).toContain("KeyError");
	}, 30_000);

	test("reading a log for an unknown failure reports not found", async () => {
		const res = await client.readResource({ uri: "failsafe://log/fail_missing" });
		expect(resourceText(res.contents[0])).toContain("not found");
	});
});

describe("MCP server: prompts", () => {
	test("advertises the diagnose-and-fix prompt with its argument", async () => {
		const { prompts } = await client.listPrompts();
		const prompt = prompts.find((p) => p.name === "failsafe_diagnose_and_fix");
		expect(prompt).toBeDefined();
		expect(prompt?.arguments?.some((a) => a.name === "failure_id")).toBe(true);
	});

	test("get prompt seeds the fix loop with the diagnosis packet", async () => {
		const { json } = await callTool("failsafe_analyze", {
			command: "python3 -c \"raise KeyError('prompt')\"",
		});
		const failureId = json.failure_id as string;
		const result = await client.getPrompt({
			name: "failsafe_diagnose_and_fix",
			arguments: { failure_id: failureId },
		});
		expect(result.messages).toHaveLength(1);
		const content = result.messages[0].content as { type: string; text: string };
		expect(content.type).toBe("text");
		expect(content.text).toContain(failureId);
		expect(content.text).toContain("Diagnosis packet:");
		expect(content.text).toContain("failsafe_verify");
	}, 30_000);
});
