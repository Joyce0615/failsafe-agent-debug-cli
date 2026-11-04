/**
 * `failsafe drift report` CLI tests (item 30 — longitudinal diagnostic
 * drift reports).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-drift-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function flatSeries(value: number, n: number, startMs = 0): Array<Record<string, unknown>> {
	return Array.from({ length: n }, (_, i) => ({
		at_ms: startMs + i * 60_000,
		value,
		provider: "openai",
	}));
}

describe("drift report", () => {
	test("reports a cost regression attributed to a revision, as JSON", async () => {
		const seriesFile = join(workDir, "series.json");
		const revisionsFile = join(workDir, "revisions.json");
		writeFileSync(
			seriesFile,
			JSON.stringify({
				attribution: [],
				remediation: [],
				abstention: [],
				privacy_loss: [],
				cost: [...flatSeries(1.0, 15, 0), ...flatSeries(5.0, 15, 15 * 60_000)],
				latency: [],
			}),
		);
		writeFileSync(
			revisionsFile,
			JSON.stringify([
				{
					id: "r1",
					kind: "model",
					at_ms: 15 * 60_000 - 1000,
					description: "gpt-x upgrade",
					release: "2026.10",
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"drift",
			"report",
			"--series",
			seriesFile,
			"--revisions",
			revisionsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.regressed_dimensions).toContain("cost");
		expect(json.by_dimension.cost.regressions[0].revision.id).toBe("r1");
	});

	test("renders a human-readable Markdown report with --render", async () => {
		const seriesFile = join(workDir, "series2.json");
		writeFileSync(
			seriesFile,
			JSON.stringify({
				attribution: [],
				remediation: [],
				abstention: [],
				privacy_loss: [],
				cost: flatSeries(1, 15),
				latency: [],
			}),
		);
		const { exitCode, stdout } = await run([
			"drift",
			"report",
			"--series",
			seriesFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Longitudinal Diagnostic Drift Report");
		expect(stdout).toContain("cost");
	});
});
