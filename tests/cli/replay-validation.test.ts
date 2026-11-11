/**
 * `failsafe replay validate` CLI tests (item 38 — replay-from-scratch
 * recovery validation).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-replay-validation-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

const ENV = { os: "linux", arch: "x64", cwd: "/workspace", node_version: "20.11.0" };
const SIGNATURE = { exception_type: "AssertionError", test_name: "test_add" };

describe("replay validate", () => {
	test("accepts when provenance is faithful, pre-fix reproduced, and post-fix passed", async () => {
		const inputsFile = join(workDir, "inputs.json");
		const criteriaFile = join(workDir, "criteria.json");
		writeFileSync(
			inputsFile,
			JSON.stringify({
				recordedEnv: ENV,
				rebuiltEnv: ENV,
				recordedSignature: SIGNATURE,
				preFix: { verified: true, exit_code: 1, duration_ms: 10, new_signature: SIGNATURE },
				postFix: { verified: false, exit_code: 0, duration_ms: 10 },
			}),
		);
		writeFileSync(
			criteriaFile,
			JSON.stringify({
				required_provenance_fields: ["os", "arch", "node_version"],
				min_signature_match: 0.5,
			}),
		);
		const { exitCode, stdout } = await run([
			"replay",
			"validate",
			"--inputs",
			inputsFile,
			"--criteria",
			criteriaFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.accepted).toBe(true);
		expect(json.refused).toHaveLength(0);
	});

	test("refuses and names the reason when the rebuilt environment's provenance mismatches", async () => {
		const inputsFile = join(workDir, "inputs2.json");
		const criteriaFile = join(workDir, "criteria2.json");
		writeFileSync(
			inputsFile,
			JSON.stringify({
				recordedEnv: ENV,
				rebuiltEnv: { ...ENV, node_version: "18.0.0" },
				recordedSignature: SIGNATURE,
				preFix: { verified: true, exit_code: 1, duration_ms: 10, new_signature: SIGNATURE },
				postFix: { verified: false, exit_code: 0, duration_ms: 10 },
			}),
		);
		writeFileSync(
			criteriaFile,
			JSON.stringify({
				required_provenance_fields: ["os", "arch", "node_version"],
				min_signature_match: 0.5,
			}),
		);
		const { exitCode, stdout } = await run([
			"replay",
			"validate",
			"--inputs",
			inputsFile,
			"--criteria",
			criteriaFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.accepted).toBe(false);
		expect(json.refused.some((r: string) => r.includes("provenance"))).toBe(true);
	});

	test("errors with a non-zero exit code when a required input file is missing", async () => {
		const { exitCode, stdout } = await run([
			"replay",
			"validate",
			"--inputs",
			join(workDir, "does-not-exist.json"),
			"--criteria",
			join(workDir, "does-not-exist-2.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
