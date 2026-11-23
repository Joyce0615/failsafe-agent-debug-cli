/**
 * `failsafe trusted-state-contamination diagnose` CLI tests (item 55 —
 * forensically detect trusted-state contamination).
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

function checkpoint(id: string, sequence: number) {
	return {
		checkpoint_id: id,
		sequence,
		snapshot: { thread_id: "t1", frame_id: "f1", location: { file: "a.py", line: 1 }, scopes: [] },
		delta: null,
	};
}

function deltaWith(overrides: Record<string, unknown> = {}) {
	return {
		debug_session_id: "s1",
		from_location: { file: "a.py", line: 1 },
		to_location: { file: "a.py", line: 2 },
		step_kind: "over",
		changed_variables: [],
		branch_events: [],
		exceptions: [],
		console_events: [],
		...overrides,
	};
}

const action = { kind: "command", command: "pytest tests/test_x.py", rationale: "re-run the test" };

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-trusted-state-contamination-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("trusted-state-contamination diagnose", () => {
	test("reports oracle_injection when post-repair matches a trusted checkpoint with no recorded work", async () => {
		const attemptsFile = join(workDir, "attempts-oracle.json");
		const trustedFile = join(workDir, "trusted.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([
				{
					attempt_id: "a1",
					pre_repair: checkpoint("cp-pre", 5),
					action,
					post_repair: checkpoint("cp-trusted", 6),
					recorded_delta: deltaWith(),
				},
			]),
		);
		writeFileSync(trustedFile, JSON.stringify(["cp-trusted"]));
		const { exitCode, stdout } = await run([
			"trusted-state-contamination",
			"diagnose",
			"--attempts",
			attemptsFile,
			"--trusted-checkpoints",
			trustedFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.verdicts[0].verdict).toBe("oracle_injection");
		expect(json.first_contaminated_attempt_id).toBe("a1");
	});

	test("reports genuine with no trusted/prior checkpoint files supplied", async () => {
		const attemptsFile = join(workDir, "attempts-genuine.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([
				{
					attempt_id: "a1",
					pre_repair: checkpoint("cp-pre", 5),
					action,
					post_repair: checkpoint("cp-new", 6),
					recorded_delta: deltaWith({
						changed_variables: [{ name: "x", before: "1", after: "2" }],
					}),
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"trusted-state-contamination",
			"diagnose",
			"--attempts",
			attemptsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.verdicts[0].verdict).toBe("genuine");
		expect(json.first_contaminated_attempt_id).toBeUndefined();
	});

	test("reports stale_snapshot_reuse when post-repair matches a prior checkpoint", async () => {
		const attemptsFile = join(workDir, "attempts-stale.json");
		const priorFile = join(workDir, "prior.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([
				{
					attempt_id: "a1",
					pre_repair: checkpoint("cp-pre", 5),
					action,
					post_repair: checkpoint("cp-old", 6),
					recorded_delta: deltaWith({
						changed_variables: [{ name: "x", before: "1", after: "2" }],
					}),
				},
			]),
		);
		writeFileSync(priorFile, JSON.stringify(["cp-old"]));
		const { exitCode, stdout } = await run([
			"trusted-state-contamination",
			"diagnose",
			"--attempts",
			attemptsFile,
			"--prior-checkpoints",
			priorFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.verdicts[0].verdict).toBe("stale_snapshot_reuse");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const attemptsFile = join(workDir, "attempts-render.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([
				{
					attempt_id: "a1",
					pre_repair: checkpoint("cp-pre", 5),
					action,
					post_repair: checkpoint("cp-new", 6),
					recorded_delta: null,
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"trusted-state-contamination",
			"diagnose",
			"--attempts",
			attemptsFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Trusted-State Contamination Report");
	});

	test("errors with a non-zero exit code when the attempts file is missing", async () => {
		const { exitCode, stdout } = await run([
			"trusted-state-contamination",
			"diagnose",
			"--attempts",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
