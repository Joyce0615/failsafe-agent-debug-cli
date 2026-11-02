/**
 * `failsafe privacy share`/`failsafe privacy aggregate` CLI tests (item 28 —
 * privacy-preserving incident sharing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIVACY_KEY_ENV } from "../../src/cli/privacy-sharing.js";

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

function sampleGraph() {
	return {
		nodes: [
			{ id: "a", kind: "service", status: "failed", ts: 0, service: "svc-a" },
			{ id: "b", kind: "service", status: "ok", ts: 1, service: "svc-a" },
			{ id: "c", kind: "service", status: "ok", ts: 2, service: "svc-a" },
			{ id: "d", kind: "service", status: "failed", ts: 3, service: "svc-b" },
		],
		edges: [{ from: "a", to: "b", type: "causes" }],
		root_causes: [
			{ node_id: "a", kind: "service", status: "failed", score: 1, evidence_path: ["a"], downstream_failures: 1 },
		],
		first_propagating_fault: {
			node_id: "a",
			kind: "service",
			status: "failed",
			score: 1,
			evidence_path: ["a"],
			downstream_failures: 1,
		},
		uncertainty: [],
	};
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-privacy-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("privacy share", () => {
	test("requires FAILSAFE_PRIVACY_KEY", async () => {
		const graphFile = join(workDir, "graph.json");
		writeFileSync(graphFile, JSON.stringify(sampleGraph()));
		const { exitCode, json } = await run(["privacy", "share", "chain-1", "--graph", graphFile], {
			[PRIVACY_KEY_ENV]: "",
		});
		expect(exitCode).not.toBe(0);
		expect(json.error).toBe(true);
	});

	test("discloses only the k-anonymized export stage", async () => {
		const graphFile = join(workDir, "graph2.json");
		writeFileSync(graphFile, JSON.stringify(sampleGraph()));
		const { exitCode, json } = await run(
			["privacy", "share", "chain-1", "--graph", graphFile, "--k", "3"],
			{ [PRIVACY_KEY_ENV]: "test-key" },
		);
		expect(exitCode).toBe(0);
		const records = json.records as Array<{ disclosed: boolean; content?: unknown }>;
		expect(records[0].disclosed).toBe(false);
		expect(records[2].disclosed).toBe(true);
		const exported = records[2].content as { nodes: Array<{ id: string; service: string }> };
		const d = exported.nodes.find((n) => n.id === "d")!;
		expect(d.service).not.toBe("svc-b");
	});
});

describe("privacy aggregate", () => {
	test("refuses a release that exceeds the budget without leaking counts", async () => {
		const graphsFile = join(workDir, "graphs.json");
		const budgetFile = join(workDir, "budget.json");
		writeFileSync(graphsFile, JSON.stringify([sampleGraph()]));
		writeFileSync(budgetFile, JSON.stringify({ epsilon_total: 1, epsilon_spent: 0.9 }));
		const { exitCode, json } = await run([
			"privacy",
			"aggregate",
			"--graphs",
			graphsFile,
			"--epsilon",
			"0.5",
			"--budget",
			budgetFile,
		]);
		expect(exitCode).not.toBe(0);
		expect(json.error).toBe(true);
		expect(json.noisy_counts).toBeUndefined();
	});

	test("releases noisy counts and a decremented budget when within budget", async () => {
		const graphsFile = join(workDir, "graphs2.json");
		const budgetFile = join(workDir, "budget2.json");
		writeFileSync(graphsFile, JSON.stringify([sampleGraph()]));
		writeFileSync(budgetFile, JSON.stringify({ epsilon_total: 2, epsilon_spent: 0 }));
		const { exitCode, json } = await run([
			"privacy",
			"aggregate",
			"--graphs",
			graphsFile,
			"--epsilon",
			"0.5",
			"--budget",
			budgetFile,
		]);
		expect(exitCode).toBe(0);
		const budget = json.budget as { epsilon_spent: number };
		expect(budget.epsilon_spent).toBe(0.5);
		expect(json.noisy_counts).toBeDefined();
	});
});
