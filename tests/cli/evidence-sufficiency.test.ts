/**
 * `failsafe evidence-sufficiency challenge` CLI tests (item 60 —
 * publish evidence-sufficiency challenge sets).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-evidence-sufficiency-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("evidence-sufficiency challenge", () => {
	test("the reference diagnoser passes all five challenges on the default fixture", async () => {
		const { exitCode, stdout } = await run(["evidence-sufficiency", "challenge"]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.passed).toBe(true);
		expect(json.baseline_confidence).toBe("full");
		expect(json.violations).toEqual([]);
	});

	test("accepts a caller-supplied bundle", async () => {
		const bundleFile = join(workDir, "bundle.json");
		writeFileSync(
			bundleFile,
			JSON.stringify({
				spans: [
					{ span_id: "s1", ts_ms: 0 },
					{ span_id: "s2", ts_ms: 10 },
					{ span_id: "s3", ts_ms: 20 },
				],
				references: ["r1", "r2", "r3"],
				handoffs: [
					{ handoff_id: "h1", sequence: 0, payload: "plan" },
					{ handoff_id: "h2", sequence: 1, payload: "execute" },
					{ handoff_id: "h3", sequence: 2, payload: "verify" },
				],
				labels: { owner: "agent-a" },
			}),
		);
		const { exitCode, stdout } = await run([
			"evidence-sufficiency",
			"challenge",
			"--bundle",
			bundleFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.baseline_confidence).toBe("full");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const { exitCode, stdout } = await run(["evidence-sufficiency", "challenge", "--render"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Evidence-Sufficiency Challenge Report");
	});

	test("errors with a non-zero exit code on an unreadable bundle file", async () => {
		const { exitCode, stdout } = await run([
			"evidence-sufficiency",
			"challenge",
			"--bundle",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
