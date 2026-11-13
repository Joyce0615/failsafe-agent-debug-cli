/**
 * `failsafe adjudication` CLI tests (item 39 — calibrate diagnoses from
 * operator adjudication).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-adjudication-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function makeRow(i: number, label: "accept" | "reject", prefix: string) {
	return {
		diagnosis_id: `${prefix}${i}`,
		predicted_location: "src/foo.ts",
		predicted_confidence: 0.8,
		label,
		operator_id: `${prefix}op${i}`,
		adjudicated_at_ms: i,
	};
}

describe("adjudication calibrate", () => {
	test("reports no drift and a calibration report for matching batches", async () => {
		const baselineFile = join(workDir, "baseline.json");
		const recentFile = join(workDir, "recent.json");
		const rows = (prefix: string) =>
			Array.from({ length: 20 }, (_, i) => makeRow(i, i % 2 === 0 ? "accept" : "reject", prefix));
		writeFileSync(baselineFile, JSON.stringify(rows("b")));
		writeFileSync(recentFile, JSON.stringify(rows("r")));

		const { exitCode, stdout } = await run([
			"adjudication",
			"calibrate",
			"--baseline",
			baselineFile,
			"--recent",
			recentFile,
			"--max-bytes",
			"50000",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.drift.insufficient_data).toBe(false);
		expect(typeof json.calibration.samples).toBe("number");
	});

	test("errors with a non-zero exit code when a required input file is missing", async () => {
		const { exitCode, stdout } = await run([
			"adjudication",
			"calibrate",
			"--baseline",
			join(workDir, "does-not-exist.json"),
			"--recent",
			join(workDir, "does-not-exist-2.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});

describe("adjudication gate", () => {
	test("refuses without a grant file", async () => {
		const requestFile = join(workDir, "request.json");
		writeFileSync(
			requestFile,
			JSON.stringify({ kind: "learned_ranking", policy_id: "policy-1", requested_by: "alice" }),
		);
		const { exitCode, stdout } = await run(["adjudication", "gate", "--request", requestFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.allowed).toBe(false);
	});

	test("allows when approved by someone other than the requester", async () => {
		const requestFile = join(workDir, "request2.json");
		const grantFile = join(workDir, "grant2.json");
		writeFileSync(
			requestFile,
			JSON.stringify({ kind: "stopping_policy", policy_id: "policy-2", requested_by: "alice" }),
		);
		writeFileSync(grantFile, JSON.stringify({ approver: "bob", approved_at_ms: 1000 }));
		const { exitCode, stdout } = await run([
			"adjudication",
			"gate",
			"--request",
			requestFile,
			"--grant",
			grantFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.allowed).toBe(true);
	});
});
