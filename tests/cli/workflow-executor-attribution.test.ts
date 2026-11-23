/**
 * `failsafe workflow-executor-attribution diagnose` CLI tests (item 57
 * — separate workflow-author defects from executor defects).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-workflow-executor-attribution-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("workflow-executor-attribution diagnose", () => {
	test("reports decomposition_effect present for a workflow failing broadly", async () => {
		const runsFile = join(workDir, "runs-decomposition.json");
		writeFileSync(
			runsFile,
			JSON.stringify([
				{ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" },
				{ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "fail" },
				{ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "fail" },
			]),
		);
		const { exitCode, stdout } = await run([
			"workflow-executor-attribution",
			"diagnose",
			"--runs",
			runsFile,
			"--target",
			"target",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.decomposition_effect).toBe("present");
	});

	test("reports execution_effect present for an executor failing broadly", async () => {
		const runsFile = join(workDir, "runs-execution.json");
		writeFileSync(
			runsFile,
			JSON.stringify([
				{ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" },
				{ run_id: "r2", workflow_id: "wf-b", executor_id: "ex-a", outcome: "fail" },
				{ run_id: "r3", workflow_id: "wf-c", executor_id: "ex-a", outcome: "fail" },
				{ run_id: "r4", workflow_id: "wf-a", executor_id: "ex-b", outcome: "pass" },
				{ run_id: "r5", workflow_id: "wf-a", executor_id: "ex-c", outcome: "pass" },
			]),
		);
		const { exitCode, stdout } = await run([
			"workflow-executor-attribution",
			"diagnose",
			"--runs",
			runsFile,
			"--target",
			"target",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.execution_effect).toBe("present");
	});

	test("reports interaction_effect present when neither main effect explains the failure", async () => {
		const runsFile = join(workDir, "runs-interaction.json");
		writeFileSync(
			runsFile,
			JSON.stringify([
				{ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" },
				{ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "pass" },
				{ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "pass" },
				{ run_id: "r4", workflow_id: "wf-b", executor_id: "ex-a", outcome: "pass" },
				{ run_id: "r5", workflow_id: "wf-c", executor_id: "ex-a", outcome: "pass" },
			]),
		);
		const { exitCode, stdout } = await run([
			"workflow-executor-attribution",
			"diagnose",
			"--runs",
			runsFile,
			"--target",
			"target",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.interaction_effect).toBe("present");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const runsFile = join(workDir, "runs-render.json");
		writeFileSync(
			runsFile,
			JSON.stringify([
				{ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" },
				{ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "fail" },
				{ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "fail" },
			]),
		);
		const { exitCode, stdout } = await run([
			"workflow-executor-attribution",
			"diagnose",
			"--runs",
			runsFile,
			"--target",
			"target",
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Workflow/Executor Defect Attribution");
	});

	test("errors with a non-zero exit code when the target run_id is not found", async () => {
		const runsFile = join(workDir, "runs-missing-target.json");
		writeFileSync(
			runsFile,
			JSON.stringify([{ run_id: "other", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }]),
		);
		const { exitCode, stdout } = await run([
			"workflow-executor-attribution",
			"diagnose",
			"--runs",
			runsFile,
			"--target",
			"does-not-exist",
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
