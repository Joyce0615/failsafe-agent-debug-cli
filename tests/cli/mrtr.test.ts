/**
 * `failsafe mrtr diagnose` CLI tests (item 51 — diagnose MRTR stalls and
 * response mismatches).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-mrtr-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("mrtr diagnose", () => {
	test("reports a missing_response finding as the first violated round", async () => {
		const roundsFile = join(workDir, "rounds-missing.json");
		writeFileSync(
			roundsFile,
			JSON.stringify([
				{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			]),
		);
		const { exitCode, stdout } = await run(["mrtr", "diagnose", "--rounds", roundsFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.first_violated_round.kind).toBe("missing_response");
		expect(json.findings).toHaveLength(1);
	});

	test("reports no findings for a clean exchange", async () => {
		const roundsFile = join(workDir, "rounds-clean.json");
		writeFileSync(
			roundsFile,
			JSON.stringify([
				{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
				{ sequence: 2, round_id: "r1", kind: "response", request_state: "s1", payload: "ok" },
			]),
		);
		const { exitCode, stdout } = await run(["mrtr", "diagnose", "--rounds", roundsFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toEqual([]);
		expect(json.first_violated_round).toBeNull();
	});

	test("reports retry_parameter_drift when two asks for the same round_id differ", async () => {
		const roundsFile = join(workDir, "rounds-drift.json");
		writeFileSync(
			roundsFile,
			JSON.stringify([
				{
					sequence: 1,
					round_id: "r1",
					kind: "input_required",
					request_state: "s1",
					retry_params: { field: "email" },
				},
				{
					sequence: 2,
					round_id: "r1",
					kind: "input_required",
					request_state: "s2",
					retry_params: { field: "phone" },
				},
			]),
		);
		const { exitCode, stdout } = await run(["mrtr", "diagnose", "--rounds", roundsFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings.some((f: { kind: string }) => f.kind === "retry_parameter_drift")).toBe(
			true,
		);
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const roundsFile = join(workDir, "rounds-render.json");
		writeFileSync(
			roundsFile,
			JSON.stringify([
				{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			]),
		);
		const { exitCode, stdout } = await run([
			"mrtr",
			"diagnose",
			"--rounds",
			roundsFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("MRTR Stall & Response Mismatch Report");
	});

	test("errors with a non-zero exit code when the rounds file is missing", async () => {
		const { exitCode, stdout } = await run([
			"mrtr",
			"diagnose",
			"--rounds",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
