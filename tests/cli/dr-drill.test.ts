/**
 * `failsafe dr-drill run` CLI tests (item 50 — publish diagnostic
 * disaster-recovery drills).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-dr-drill-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function baseInput(extra: Record<string, unknown> = {}) {
	return {
		last_known_good_ms: 1000,
		incident_detected_ms: 5000,
		restoration_complete_ms: 9000,
		restoration_safety: { safe: true, reasons: [] },
		attribution_baseline: 0.9,
		attribution_post_drill: 0.85,
		...extra,
	};
}

describe("dr-drill run", () => {
	test("reports RPO, RTO, and attribution degradation with no scenarios supplied", async () => {
		const inputFile = join(workDir, "input-basic.json");
		writeFileSync(inputFile, JSON.stringify(baseInput()));
		const { exitCode, stdout } = await run(["dr-drill", "run", "--input", inputFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.rpo.exposure_window_ms).toBe(4000);
		expect(json.rto.reported).toBe(true);
		expect(json.rto.rto_ms).toBe(4000);
		expect(json.untested).toHaveLength(5);
	});

	test("withholds RTO when restoration_safety is unsafe", async () => {
		const inputFile = join(workDir, "input-unsafe.json");
		writeFileSync(
			inputFile,
			JSON.stringify(
				baseInput({ restoration_safety: { safe: false, reasons: ["store still corrupted"] } }),
			),
		);
		const { exitCode, stdout } = await run(["dr-drill", "run", "--input", inputFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.rto.reported).toBe(false);
		expect(json.rto.reason).toContain("store still corrupted");
	});

	test("composes a telemetry_loss scenario and flags it as a failed scenario when silent", async () => {
		const inputFile = join(workDir, "input-telemetry.json");
		writeFileSync(
			inputFile,
			JSON.stringify(
				baseInput({
					telemetry_loss: {
						scenario: {
							kind: "exporter_outage",
							description: "outage",
							start_ms: 0,
							duration_ms: 1000,
						},
						observed: {
							offered: 10,
							accepted: 5,
							errors_surfaced: 0,
							silent_drops: 5,
							bytes_offered: 1000,
							bytes_stored: 500,
							timestamps_altered: 0,
						},
					},
				}),
			),
		);
		const { exitCode, stdout } = await run(["dr-drill", "run", "--input", inputFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.failed_scenarios).toEqual(["telemetry_loss"]);
		expect(json.untested).not.toContain("telemetry_loss");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const inputFile = join(workDir, "input-render.json");
		writeFileSync(inputFile, JSON.stringify(baseInput()));
		const { exitCode, stdout } = await run(["dr-drill", "run", "--input", inputFile, "--render"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Diagnostic Disaster-Recovery Drill Report");
	});

	test("errors with a non-zero exit code when the input file is missing", async () => {
		const { exitCode, stdout } = await run([
			"dr-drill",
			"run",
			"--input",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
