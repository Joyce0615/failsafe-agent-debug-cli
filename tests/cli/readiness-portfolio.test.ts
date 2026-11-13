/**
 * `failsafe readiness publish` CLI tests (item 40 — publish
 * incident-readiness release portfolios).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-readiness-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function cleanInputs() {
	return {
		project: "demo",
		version: "1.0.0",
		built_at_ms: 1000,
		telemetry_fidelity: {
			spans_examined: 10,
			findings: [],
			by_category: {},
			confirmed_absence_count: 0,
			unknown_evidence_count: 0,
		},
		attribution: { refused_reason: "only 5 observations" },
		reproducer_quality: {
			verdict: "causal",
			repeats: 3,
			arms: [],
			mutation_safety: { safe: true, reasons: [] },
			summary: "ok",
		},
		recovery_safety: {
			baseline_runs: [],
			canary_runs: [],
			baseline_pass_rate: 1,
			canary_pass_rate: 1,
			metric_comparisons: [],
			verdict: "promote",
			reasons: ["matched baseline"],
		},
		privacy_budget: { epsilon_total: 1, epsilon_spent: 0.1 },
		advisory_exposure: { assessments: [], attribution: { attributed: false, reason: "none" }, recoveries: [] },
		drift: { by_dimension: {}, regressed_dimensions: [] },
	};
}

describe("readiness publish", () => {
	test("errors with a non-zero exit code when the signing key is missing", async () => {
		const inputsFile = join(workDir, "inputs.json");
		writeFileSync(inputsFile, JSON.stringify(cleanInputs()));
		const { exitCode, stdout } = await run(
			["readiness", "publish", "--inputs", inputsFile],
			{ FAILSAFE_READINESS_KEY: "" },
		);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});

	test("promotes and signs when every dimension is clean", async () => {
		const inputsFile = join(workDir, "inputs2.json");
		writeFileSync(inputsFile, JSON.stringify(cleanInputs()));
		const { exitCode, stdout } = await run(
			["readiness", "publish", "--inputs", inputsFile],
			{ FAILSAFE_READINESS_KEY: "test-signing-key" },
		);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.verdict).toBe("promote");
		expect(json.portfolio.signature.length).toBeGreaterThan(0);
	});

	test("errors with a non-zero exit code when a required input file is missing", async () => {
		const { exitCode, stdout } = await run(
			["readiness", "publish", "--inputs", join(workDir, "does-not-exist.json")],
			{ FAILSAFE_READINESS_KEY: "test-signing-key" },
		);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
