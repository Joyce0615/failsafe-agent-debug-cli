/**
 * `failsafe canary trial`/`failsafe canary promote` CLI tests (item 29 —
 * remediation canary and rollback verification).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_KEY_ENV } from "../../src/remediation/approval.js";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(stdout);
	} catch {}
	return { exitCode, json };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-canary-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("canary trial", () => {
	test("promotes when canary matches baseline pass rate", async () => {
		const runsFile = join(workDir, "runs.json");
		writeFileSync(
			runsFile,
			JSON.stringify({
				baseline: [{ outcome: "pass" }, { outcome: "pass" }, { outcome: "pass" }],
				canary: [{ outcome: "pass" }, { outcome: "pass" }, { outcome: "pass" }],
			}),
		);
		const { exitCode, json } = await run(["canary", "trial", "--runs", runsFile]);
		expect(exitCode).toBe(0);
		expect(json.verdict).toBe("promote");
	});

	test("rolls back when canary pass rate is worse than baseline", async () => {
		const runsFile = join(workDir, "runs2.json");
		writeFileSync(
			runsFile,
			JSON.stringify({
				baseline: [{ outcome: "pass" }, { outcome: "pass" }, { outcome: "pass" }],
				canary: [{ outcome: "pass" }, { outcome: "fail" }, { outcome: "fail" }],
			}),
		);
		const { exitCode, json } = await run(["canary", "trial", "--runs", runsFile]);
		expect(exitCode).toBe(0);
		expect(json.verdict).toBe("rollback");
	});
});

describe("canary promote", () => {
	test("refuses promotion for a non-'promote' verdict without consulting the approval gate", async () => {
		const reportFile = join(workDir, "report.json");
		const actionFile = join(workDir, "action.json");
		writeFileSync(
			reportFile,
			JSON.stringify({
				baseline_runs: [],
				canary_runs: [],
				baseline_pass_rate: 1,
				canary_pass_rate: 0,
				metric_comparisons: [],
				verdict: "rollback",
				reasons: ["canary pass rate worse"],
			}),
		);
		writeFileSync(
			actionFile,
			JSON.stringify({
				mode: "promote_canary_fix",
				target: "svc-a",
				parameters: {},
				reversible: true,
				blast_radius: 0.1,
				requested_by: "alice",
			}),
		);
		const { exitCode, json } = await run(["canary", "promote", "--report", reportFile, "--action", actionFile]);
		expect(exitCode).not.toBe(0);
		expect(json.ok).toBe(false);
		expect((json.reason as string)).toContain("verdict");
	});

	test("a 'promote' verdict with no approval grant is still refused", async () => {
		const reportFile = join(workDir, "report2.json");
		const actionFile = join(workDir, "action2.json");
		writeFileSync(
			reportFile,
			JSON.stringify({
				baseline_runs: [],
				canary_runs: [],
				baseline_pass_rate: 1,
				canary_pass_rate: 1,
				metric_comparisons: [],
				verdict: "promote",
				reasons: ["matched"],
			}),
		);
		writeFileSync(
			actionFile,
			JSON.stringify({
				mode: "promote_canary_fix",
				target: "svc-a",
				parameters: {},
				reversible: true,
				blast_radius: 0.1,
				requested_by: "alice",
			}),
		);
		const { exitCode, json } = await run(
			["canary", "promote", "--report", reportFile, "--action", actionFile],
			{ [APPROVAL_KEY_ENV]: "test-canary-cli-key" },
		);
		expect(exitCode).not.toBe(0);
		expect(json.ok).toBe(false);
	});
});
