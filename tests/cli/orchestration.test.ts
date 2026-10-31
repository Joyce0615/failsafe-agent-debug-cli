/**
 * `failsafe orchestration localize` CLI test (item 27 — orchestration-plan
 * fault localization).
 *
 * Drives the real CLI binary against a file-based layer-tagged trace and
 * outcome table, mirroring `incidents.test.ts`'s pattern for a read-only,
 * local-file diagnosis command.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(args: string[]): Promise<{ exitCode: number; json: Record<string, unknown> }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-orchestration-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("orchestration localize", () => {
	test("blames the planner layer when its ablation conclusively flips the outcome", async () => {
		const events = [
			{ id: "plan", layer: "planner", kind: "plan", action: "plan", outcome: "ok" },
			{ id: "tool-call", layer: "tool", kind: "tool_call", action: "call_api", outcome: "ok" },
			{
				id: "worker-step",
				layer: "worker",
				kind: "tool_result",
				action: "handle_result",
				outcome: "error",
				error_class: "validation_error",
			},
		];
		const outcomes = {
			baseline: "failed",
			by_event: { plan: "passed", "tool-call": "failed", "worker-step": "failed" },
		};
		const eventsFile = join(workDir, "events.json");
		const outcomesFile = join(workDir, "outcomes.json");
		writeFileSync(eventsFile, JSON.stringify(events));
		writeFileSync(outcomesFile, JSON.stringify(outcomes));

		const { exitCode, json } = await run([
			"orchestration",
			"localize",
			"--events",
			eventsFile,
			"--outcomes",
			outcomesFile,
		]);
		expect(exitCode).toBe(0);
		expect(json.counterfactual_layer).toBe("planner");
		expect(json.verdict).toBe("planner_defect");
	});

	test("reports indeterminate, with a caveat, when no ablation conclusively flips the outcome", async () => {
		const events = [
			{ id: "plan", layer: "planner", kind: "plan", action: "plan", outcome: "ok" },
			{ id: "tool-call", layer: "tool", kind: "tool_call", action: "call_api", outcome: "ok" },
		];
		const outcomes = {
			baseline: "failed",
			by_event: { plan: "failed", "tool-call": "failed" },
		};
		const eventsFile = join(workDir, "events2.json");
		const outcomesFile = join(workDir, "outcomes2.json");
		writeFileSync(eventsFile, JSON.stringify(events));
		writeFileSync(outcomesFile, JSON.stringify(outcomes));

		const { exitCode, json } = await run([
			"orchestration",
			"localize",
			"--events",
			eventsFile,
			"--outcomes",
			outcomesFile,
		]);
		expect(exitCode).toBe(0);
		expect(json.verdict).toBe("indeterminate");
		expect((json.caveats as string[]).length).toBeGreaterThan(0);
	});
});
