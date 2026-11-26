/**
 * `failsafe shared-state-race diagnose` CLI tests (item 53 — reconstruct
 * shared-state read/write races).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-shared-state-race-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function rawEvent(id: string, ts_ms: number, precision_ms = 1000) {
	return { id, source: "trace", clock: "local", ts_ms, precision_ms, label: id };
}

describe("shared-state-race diagnose", () => {
	test("a causal link proving the read missed a committed write is a stale_read finding", async () => {
		const eventsFile = join(workDir, "events-stale.json");
		const operationsFile = join(workDir, "operations-stale.json");
		const linksFile = join(workDir, "links-stale.json");
		writeFileSync(eventsFile, JSON.stringify([rawEvent("w1", 1000), rawEvent("r1", 2000)]));
		writeFileSync(
			operationsFile,
			JSON.stringify([
				{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 2 },
				{ id: "r1", actor_id: "a2", resource_id: "res1", kind: "read", version: 1 },
			]),
		);
		writeFileSync(
			linksFile,
			JSON.stringify([{ before: "w1", after: "r1", reason: "w1 committed before r1 ran" }]),
		);
		const { exitCode, stdout } = await run([
			"shared-state-race",
			"diagnose",
			"--events",
			eventsFile,
			"--operations",
			operationsFile,
			"--links",
			linksFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings.some((f: { kind: string }) => f.kind === "stale_read")).toBe(true);
	});

	test("a lost_update finding is reported from version numbers alone, no events/links required", async () => {
		const eventsFile = join(workDir, "events-lost.json");
		const operationsFile = join(workDir, "operations-lost.json");
		writeFileSync(eventsFile, JSON.stringify([]));
		writeFileSync(
			operationsFile,
			JSON.stringify([
				{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
				{ id: "w2", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
				{
					id: "w3",
					actor_id: "a1",
					resource_id: "res1",
					kind: "write",
					version: 3,
					based_on_version: 1,
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"shared-state-race",
			"diagnose",
			"--events",
			eventsFile,
			"--operations",
			operationsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		const lost = json.findings.find((f: { kind: string }) => f.kind === "lost_update");
		expect(lost).toBeDefined();
		expect(lost.blamed_actor_id).toBe("a1");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const eventsFile = join(workDir, "events-render.json");
		const operationsFile = join(workDir, "operations-render.json");
		writeFileSync(eventsFile, JSON.stringify([]));
		writeFileSync(operationsFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"shared-state-race",
			"diagnose",
			"--events",
			eventsFile,
			"--operations",
			operationsFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Shared-State Read/Write Race Report");
	});

	test("errors with a non-zero exit code when the operations file is missing", async () => {
		const eventsFile = join(workDir, "events-missing.json");
		writeFileSync(eventsFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"shared-state-race",
			"diagnose",
			"--events",
			eventsFile,
			"--operations",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
