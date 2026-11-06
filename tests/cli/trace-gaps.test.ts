/**
 * `failsafe trace-gaps` CLI tests (item 32 — detect and explain distributed
 * telemetry gaps).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-trace-gaps-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("trace-gaps", () => {
	test("reports no gaps and exits 0 for a clean integrity span set", async () => {
		const spansFile = join(workDir, "spans.json");
		writeFileSync(
			spansFile,
			JSON.stringify([{ span_id: "a", service: "svc", name: "op", start_ms: 0, end_ms: 10 }]),
		);
		const { exitCode, stdout } = await run(["trace-gaps", "--spans", spansFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toHaveLength(0);
	});

	test("reports an orphan parent as missing_span, unknown_evidence, with a caveat", async () => {
		const spansFile = join(workDir, "spans2.json");
		writeFileSync(
			spansFile,
			JSON.stringify([
				{ span_id: "child", parent_span_id: "ghost", service: "svc", name: "op", start_ms: 0, end_ms: 10 },
			]),
		);
		const { exitCode, stdout } = await run(["trace-gaps", "--spans", spansFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings[0].category).toBe("missing_span");
		expect(json.findings[0].evidence).toBe("unknown_evidence");
		expect(json.caveat).toBeDefined();
	});

	test("errors with a non-zero exit code when no input source is given", async () => {
		const { exitCode, stdout } = await run(["trace-gaps"]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
