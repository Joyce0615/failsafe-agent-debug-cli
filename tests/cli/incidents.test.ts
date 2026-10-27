/**
 * `failsafe incidents diagnose` CLI tests (item 22 — cross-agent causal
 * incident graphs).
 *
 * Drives the real CLI binary end-to-end: a JSON array of cross-agent events
 * is reconstructed into delegation/message/shared-resource edges and the
 * first propagating fault is reported — the first CLI entry point
 * `diagnosis/incident-graph.ts` is ever wired to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

const EVENTS = [
	{
		id: "planner-delegate",
		trace_id: "t1",
		agent_id: "planner",
		kind: "delegation",
		ts_ms: 0,
		target_agent_id: "worker",
		message: "delegate checkout task",
	},
	{
		id: "worker-fail",
		trace_id: "t1",
		agent_id: "worker",
		kind: "message",
		ts_ms: 10,
		target_agent_id: "reviewer",
		failed: true,
		message: "db_tool timed out; notifying reviewer",
	},
	{
		id: "reviewer-review-fail",
		trace_id: "t1",
		agent_id: "reviewer",
		kind: "memory_access",
		ts_ms: 50,
		resource_key: "shared_cache",
		failed: true,
		message: "review aborted: stale cache",
	},
];

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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-incidents-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("failsafe incidents diagnose", () => {
	test("reconstructs cross-agent edges and reports the first propagating fault", async () => {
		const file = join(workDir, "events.json");
		writeFileSync(file, JSON.stringify(EVENTS));

		const r = await run(["incidents", "diagnose", "--file", file]);
		expect(r.exitCode).toBe(0);
		expect((r.json.first_propagating_fault as Record<string, unknown>).node_id).toBe(
			"worker-fail",
		);
		const edges = r.json.edges as Array<Record<string, unknown>>;
		expect(edges).toEqual(
			expect.arrayContaining([
				{ from: "planner-delegate", to: "worker-fail", type: "delegates_to" },
				{ from: "worker-fail", to: "reviewer-review-fail", type: "sends_message_to" },
			]),
		);
	}, 30_000);

	test("an empty events array is rejected", async () => {
		const file = join(workDir, "empty.json");
		writeFileSync(file, JSON.stringify([]));

		const r = await run(["incidents", "diagnose", "--file", file]);
		expect(r.exitCode).not.toBe(0);
		expect(r.json.message as string).toContain("non-empty JSON array");
	}, 30_000);

	test("a missing --file is rejected before anything is parsed", async () => {
		const r = await run([
			"incidents",
			"diagnose",
			"--file",
			join(workDir, "does-not-exist.json"),
		]);
		expect(r.exitCode).not.toBe(0);
		expect(r.json.message as string).toContain("Failed to read events");
	}, 30_000);
});
