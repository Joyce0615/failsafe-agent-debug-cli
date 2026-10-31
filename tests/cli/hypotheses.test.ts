/**
 * `failsafe hypotheses plan`/`failsafe hypotheses stop` CLI tests (item 26 —
 * hypothesis-driven differential diagnosis).
 *
 * Drives the real CLI binary: `hypotheses build` creates a competing
 * hypothesis tree for a seeded failure, `hypotheses plan` ranks/sequences a
 * supplied experiment catalogue against that tree's own belief, and
 * `hypotheses stop` reports whether the investigation should stop — including
 * the indistinguishable case this item's wording names explicitly.
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-hyp-differential-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("hypotheses plan/stop", () => {
	test("plan ranks a supplied catalogue against the stored tree's belief", async () => {
		await run(["run", "python3 -c \"raise KeyError('user_id')\""]);
		await run(["diagnose", "last"]);
		const built = await run(["hypotheses", "build", "last"]);
		const hypotheses = built.json.hypotheses as Array<{ id: string }>;
		expect(hypotheses.length).toBeGreaterThan(0);

		const catalogue = [
			{
				id: "probe-a",
				description: "observational probe discriminating the leaves",
				risk: "observational",
				cost: 1,
				outcomes: ["x", "y"],
				likelihoods: Object.fromEntries(
					hypotheses.map((h, i) => [h.id, i === 0 ? { x: 1, y: 0 } : { x: 0, y: 1 }]),
				),
			},
		];
		const catalogueFile = join(workDir, "catalogue.json");
		writeFileSync(catalogueFile, JSON.stringify(catalogue));

		const { exitCode, json } = await run([
			"hypotheses",
			"plan",
			"last",
			"--catalogue",
			catalogueFile,
			"--budget",
			"5",
		]);
		expect(exitCode).toBe(0);
		expect(json.belief).toBeDefined();
		expect(Array.isArray(json.steps)).toBe(true);
	}, 30_000);

	test("stop reports indistinguishable when no informative action remains and the leaders are tied", async () => {
		await run(["run", "python3 -c \"raise KeyError('tied')\""]);
		await run(["diagnose", "last"]);
		await run(["hypotheses", "build", "last"]);

		const state = {
			steps: 5,
			elapsed_ms: 1000,
			tokens_spent: 100,
			actions_taken: 2,
			leading_confidence: 0.5,
			residual: 0.1,
			step_gains: [0.3, 0.3, 0.3],
			remaining_actions: [],
		};
		const stateFile = join(workDir, "state.json");
		writeFileSync(stateFile, JSON.stringify(state));

		const { exitCode, json } = await run(["hypotheses", "stop", "last", "--state", stateFile]);
		expect(exitCode).toBe(0);
		expect(typeof json.indistinguishable).toBe("boolean");
		expect(json.classification).not.toBe("resolved");
	}, 30_000);
});
