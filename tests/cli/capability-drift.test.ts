/**
 * `failsafe capability-drift diagnose` CLI tests (item 36 — diagnose
 * progressive-discovery and skill drift).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-capability-drift-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("capability-drift diagnose", () => {
	test("reports zero changes for two identical catalogs", async () => {
		const file = join(workDir, "same.json");
		writeFileSync(
			file,
			JSON.stringify({
				source: "mcp",
				captured_at: "2026-11-09T00:00:00.000Z",
				entries: [{ name: "run_tests", version: "1.0" }],
			}),
		);
		const { exitCode, stdout } = await run([
			"capability-drift",
			"diagnose",
			"--before",
			file,
			"--after",
			file,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.changes).toHaveLength(0);
	});

	test("reports a missing_tool change and attributes it from the error text", async () => {
		const beforeFile = join(workDir, "before.json");
		const afterFile = join(workDir, "after.json");
		const contextFile = join(workDir, "context.json");
		writeFileSync(
			beforeFile,
			JSON.stringify({
				source: "mcp",
				captured_at: "2026-11-09T00:00:00.000Z",
				entries: [{ name: "search_docs", version: "1.0" }],
			}),
		);
		writeFileSync(
			afterFile,
			JSON.stringify({ source: "mcp", captured_at: "2026-11-09T01:00:00.000Z", entries: [] }),
		);
		writeFileSync(
			contextFile,
			JSON.stringify({ error_text: "tool 'search_docs' not found in catalog" }),
		);
		const { exitCode, stdout } = await run([
			"capability-drift",
			"diagnose",
			"--before",
			beforeFile,
			"--after",
			afterFile,
			"--context",
			contextFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.changes[0].kind).toBe("missing_tool");
		expect(json.attribution.attributed).toBe(true);
		expect(json.attribution.kind).toBe("missing_tool");
	});

	test("errors with a non-zero exit code when a required catalog file is missing", async () => {
		const { exitCode, stdout } = await run([
			"capability-drift",
			"diagnose",
			"--before",
			join(workDir, "does-not-exist.json"),
			"--after",
			join(workDir, "does-not-exist-2.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
