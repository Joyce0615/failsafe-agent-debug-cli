/**
 * `failsafe actions validate`/`failsafe actions grade` CLI tests (item 31 —
 * process-oriented agent action recording).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(args: string[]): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-actions-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function action(id: string, sequence: number, causalId?: string, evidence: string[] = []) {
	return {
		schema_version: "0.1",
		id,
		task_id: "t1",
		kind: "tool_call",
		...(causalId ? { causal_id: causalId } : {}),
		sequence,
		at_ms: sequence,
		input: "x",
		output: "y",
		evidence,
		privacy_labels: [],
	};
}

describe("actions validate", () => {
	test("a valid causal chain validates ok", async () => {
		const logFile = join(workDir, "log.jsonl");
		writeFileSync(logFile, [action("a", 1), action("b", 2, "a")].map((r) => JSON.stringify(r)).join("\n"));
		const { exitCode, stdout } = await run(["actions", "validate", logFile]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).valid).toBe(true);
	});

	test("a dangling causal_id fails validation with a non-zero exit code", async () => {
		const logFile = join(workDir, "log2.jsonl");
		writeFileSync(logFile, [action("a", 1, "missing")].map((r) => JSON.stringify(r)).join("\n"));
		const { exitCode, stdout } = await run(["actions", "validate", logFile]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).valid).toBe(false);
	});
});

describe("actions grade", () => {
	test("grades evidence completeness and per-kind counts", async () => {
		const logFile = join(workDir, "log3.jsonl");
		writeFileSync(
			logFile,
			[action("a", 1, undefined, ["e1"]), action("b", 2, "a", ["e2"])]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		const { exitCode, stdout } = await run(["actions", "grade", logFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.verdict).toBe("well_evidenced");
		expect(json.by_kind.tool_call).toBe(2);
	});
});
