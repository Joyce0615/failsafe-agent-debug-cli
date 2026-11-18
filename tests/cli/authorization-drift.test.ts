/**
 * `failsafe authorization-drift diagnose` CLI tests (item 44 — add
 * authorization-drift diagnosis).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-authorization-drift-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

const intent = {
	task: "summarize the repo",
	allowed_actions: ["read_file", "search"],
	reserved_actions: ["delete_file", "send_email"],
};

describe("authorization-drift diagnose", () => {
	test("reports zero findings for a node whose policy stays inside the original intent", async () => {
		const intentFile = join(workDir, "intent-clean.json");
		const nodesFile = join(workDir, "nodes-clean.json");
		writeFileSync(intentFile, JSON.stringify(intent));
		writeFileSync(
			nodesFile,
			JSON.stringify([
				{
					node_id: "root",
					agent_id: "planner",
					delegated_policy: { allowed_actions: ["read_file"] },
					anchor_mode: "re_anchored",
					observed_effects: ["read_file"],
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"authorization-drift",
			"diagnose",
			"--nodes",
			nodesFile,
			"--intent",
			intentFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toHaveLength(0);
		expect(json.first_constraint_loss).toBeNull();
	});

	test("reports policy_widened when a node's policy exceeds the original intent", async () => {
		const intentFile = join(workDir, "intent-widen.json");
		const nodesFile = join(workDir, "nodes-widen.json");
		writeFileSync(intentFile, JSON.stringify(intent));
		writeFileSync(
			nodesFile,
			JSON.stringify([
				{
					node_id: "root",
					agent_id: "planner",
					delegated_policy: { allowed_actions: ["read_file", "delete_file"] },
					anchor_mode: "re_anchored",
					observed_effects: [],
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"authorization-drift",
			"diagnose",
			"--nodes",
			nodesFile,
			"--intent",
			intentFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toHaveLength(1);
		expect(json.findings[0].kind).toBe("policy_widened");
		expect(json.first_constraint_loss.node_id).toBe("root");
	});

	test("reports a lost_policy_source group for an orphaned node", async () => {
		const intentFile = join(workDir, "intent-orphan.json");
		const nodesFile = join(workDir, "nodes-orphan.json");
		writeFileSync(intentFile, JSON.stringify(intent));
		writeFileSync(
			nodesFile,
			JSON.stringify([
				{
					node_id: "orphan",
					agent_id: "worker",
					parent_node_id: "ghost",
					delegated_policy: { allowed_actions: ["read_file"] },
					anchor_mode: "chain_propagated",
					observed_effects: [],
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"authorization-drift",
			"diagnose",
			"--nodes",
			nodesFile,
			"--intent",
			intentFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.tree.lost_policy_source).toHaveLength(1);
		expect(json.tree.lost_policy_source[0].missing_parent_node_id).toBe("ghost");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const intentFile = join(workDir, "intent-render.json");
		const nodesFile = join(workDir, "nodes-render.json");
		writeFileSync(intentFile, JSON.stringify(intent));
		writeFileSync(nodesFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"authorization-drift",
			"diagnose",
			"--nodes",
			nodesFile,
			"--intent",
			intentFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("# Authorization Drift Report");
		expect(stdout).toContain("Lost policy source groups (0)");
		expect(stdout).toContain("First constraint loss: none found");
	});

	test("errors with a non-zero exit code when the nodes file is missing", async () => {
		const intentFile = join(workDir, "intent-missing.json");
		writeFileSync(intentFile, JSON.stringify(intent));
		const { exitCode, stdout } = await run([
			"authorization-drift",
			"diagnose",
			"--nodes",
			join(workDir, "does-not-exist.json"),
			"--intent",
			intentFile,
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
