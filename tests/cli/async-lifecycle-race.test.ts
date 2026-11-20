/**
 * `failsafe async-lifecycle-race diagnose|schedule` CLI tests (item 47 —
 * add asynchronous lifecycle race diagnosis).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-async-lifecycle-race-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function rawEvent(id: string, ts_ms: number, precision_ms = 1000) {
	return { id, source: "trace", clock: "local", ts_ms, precision_ms, label: id };
}

describe("async-lifecycle-race diagnose", () => {
	test("reports a retry_duplication finding when two retries land within clock uncertainty of each other", async () => {
		const eventsFile = join(workDir, "events-dup.json");
		const lifecycleFile = join(workDir, "lifecycle-dup.json");
		// Same reference clock, timestamps 500ms apart with 1000ms precision
		// each -> uncertainty overlaps -> genuinely concurrent.
		writeFileSync(eventsFile, JSON.stringify([rawEvent("r1", 1000), rawEvent("r2", 1500)]));
		writeFileSync(
			lifecycleFile,
			JSON.stringify([
				{ id: "r1", task_id: "t1", kind: "retry_fired", effect_applied: true },
				{ id: "r2", task_id: "t1", kind: "retry_fired", effect_applied: true },
			]),
		);
		const { exitCode, stdout } = await run([
			"async-lifecycle-race",
			"diagnose",
			"--events",
			eventsFile,
			"--lifecycle",
			lifecycleFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toHaveLength(1);
		expect(json.findings[0].kind).toBe("retry_duplication");
		expect(json.duplicated_task_ids).toEqual(["t1"]);
	});

	test("a causal link overriding clock ambiguity removes the race finding", async () => {
		const eventsFile = join(workDir, "events-link.json");
		const lifecycleFile = join(workDir, "lifecycle-link.json");
		const linksFile = join(workDir, "links.json");
		writeFileSync(eventsFile, JSON.stringify([rawEvent("r1", 1000), rawEvent("r2", 1500)]));
		writeFileSync(
			lifecycleFile,
			JSON.stringify([
				{ id: "r1", task_id: "t1", kind: "retry_fired", effect_applied: true },
				{ id: "r2", task_id: "t1", kind: "retry_fired", effect_applied: false },
			]),
		);
		writeFileSync(
			linksFile,
			JSON.stringify([{ before: "r1", after: "r2", reason: "r2 observed r1's completion marker" }]),
		);
		const { exitCode, stdout } = await run([
			"async-lifecycle-race",
			"diagnose",
			"--events",
			eventsFile,
			"--lifecycle",
			lifecycleFile,
			"--links",
			linksFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toHaveLength(0);
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const eventsFile = join(workDir, "events-render.json");
		const lifecycleFile = join(workDir, "lifecycle-render.json");
		writeFileSync(eventsFile, JSON.stringify([]));
		writeFileSync(lifecycleFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"async-lifecycle-race",
			"diagnose",
			"--events",
			eventsFile,
			"--lifecycle",
			lifecycleFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Asynchronous Lifecycle Race Report");
	});

	test("errors with a non-zero exit code when the events file is missing", async () => {
		const lifecycleFile = join(workDir, "lifecycle-missing.json");
		writeFileSync(lifecycleFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"async-lifecycle-race",
			"diagnose",
			"--events",
			join(workDir, "does-not-exist.json"),
			"--lifecycle",
			lifecycleFile,
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});

describe("async-lifecycle-race schedule", () => {
	test("reconstructs a deterministic order for one task's events", async () => {
		const eventsFile = join(workDir, "events-sched.json");
		const lifecycleFile = join(workDir, "lifecycle-sched.json");
		writeFileSync(
			eventsFile,
			JSON.stringify([rawEvent("a", 0, 1), rawEvent("b", 100, 1), rawEvent("c", 200, 1)]),
		);
		writeFileSync(
			lifecycleFile,
			JSON.stringify([
				{ id: "a", task_id: "t1", kind: "created", effect_applied: true },
				{ id: "b", task_id: "t1", kind: "started", effect_applied: true },
				{ id: "c", task_id: "t1", kind: "completed", effect_applied: true },
			]),
		);
		const { exitCode, stdout } = await run([
			"async-lifecycle-race",
			"schedule",
			"--events",
			eventsFile,
			"--lifecycle",
			lifecycleFile,
			"--task",
			"t1",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.order).toEqual(["a", "b", "c"]);
		expect(json.undetermined_pairs).toEqual([]);
	});

	test("errors with a non-zero exit code when the task_id has no lifecycle events", async () => {
		const eventsFile = join(workDir, "events-sched-missing.json");
		const lifecycleFile = join(workDir, "lifecycle-sched-missing.json");
		writeFileSync(eventsFile, JSON.stringify([]));
		writeFileSync(lifecycleFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"async-lifecycle-race",
			"schedule",
			"--events",
			eventsFile,
			"--lifecycle",
			lifecycleFile,
			"--task",
			"does-not-exist",
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
