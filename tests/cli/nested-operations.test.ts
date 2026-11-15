/**
 * `failsafe nested-operations diagnose` CLI tests (item 42 — diagnose nested
 * agent-operation failures).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-nested-operations-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function span(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		span_id: "s1",
		kind: "unknown",
		inferred_kind: false,
		start_ms: 0,
		duration_ms: 10,
		...overrides,
	};
}

describe("nested-operations diagnose", () => {
	test("reports zero findings for a clean two-level tree", async () => {
		const file = join(workDir, "clean.json");
		writeFileSync(
			file,
			JSON.stringify([
				span({ span_id: "root", kind: "workflow" }),
				span({ span_id: "child", kind: "agent", parent_span_id: "root", agent_name: "planner" }),
			]),
		);
		const { exitCode, stdout } = await run(["nested-operations", "diagnose", "--spans", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.duplicate_recording).toHaveLength(0);
		expect(json.misattributed_cost).toHaveLength(0);
		expect(json.authority_drift).toHaveLength(0);
		expect(json.tree.lost_parents).toHaveLength(0);
	});

	test("reports authority_drift for a direct agent-under-agent edge with a different agent_name", async () => {
		const file = join(workDir, "drift.json");
		writeFileSync(
			file,
			JSON.stringify([
				span({ span_id: "parent", kind: "agent", agent_name: "planner" }),
				span({
					span_id: "child",
					kind: "agent",
					parent_span_id: "parent",
					agent_name: "shadow",
				}),
			]),
		);
		const { exitCode, stdout } = await run(["nested-operations", "diagnose", "--spans", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.authority_drift).toHaveLength(1);
		expect(json.authority_drift[0].child_agent).toBe("shadow");
		expect(json.authority_drift[0].parent_agent).toBe("planner");
	});

	test("reports a lost_parents group for an orphaned span", async () => {
		const file = join(workDir, "orphan.json");
		writeFileSync(
			file,
			JSON.stringify([span({ span_id: "orphan", kind: "llm", parent_span_id: "ghost" })]),
		);
		const { exitCode, stdout } = await run(["nested-operations", "diagnose", "--spans", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.tree.lost_parents).toHaveLength(1);
		expect(json.tree.lost_parents[0].missing_parent_span_id).toBe("ghost");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const file = join(workDir, "render.json");
		writeFileSync(file, JSON.stringify([span({ span_id: "root", kind: "workflow" })]));
		const { exitCode, stdout } = await run([
			"nested-operations",
			"diagnose",
			"--spans",
			file,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("# Nested agent-operation diagnosis");
		expect(stdout).toContain("Lost parents (0)");
	});

	test("errors with a non-zero exit code when the spans file is missing", async () => {
		const { exitCode, stdout } = await run([
			"nested-operations",
			"diagnose",
			"--spans",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
