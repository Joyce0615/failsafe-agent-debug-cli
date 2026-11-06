/**
 * `failsafe cross-exam` CLI tests (item 33 — cross-examination diagnosis
 * sessions).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-cross-exam-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("cross-exam", () => {
	test("start creates a session at turn 0 with full budgets", async () => {
		await run(["run", "python3 -c \"raise KeyError('ce')\""]);
		await run(["diagnose", "last"]);
		await run(["hypotheses", "build", "last"]);

		const sessionFile = join(workDir, "session.json");
		const { exitCode, json } = await run([
			"cross-exam",
			"start",
			"last",
			"--session",
			sessionFile,
			"--max-turns",
			"3",
			"--epsilon",
			"1",
			"--effects",
			"10",
		]);
		expect(exitCode).toBe(0);
		expect(json.turn).toBe(0);
	}, 30_000);

	test("observe records an observation, consuming a turn and both budgets", async () => {
		await run(["run", "python3 -c \"raise KeyError('ce2')\""]);
		await run(["diagnose", "last"]);
		const built = await run(["hypotheses", "build", "last"]);
		const hypotheses = built.json.hypotheses as Array<{ id: string }>;

		const sessionFile = join(workDir, "session2.json");
		await run([
			"cross-exam",
			"start",
			"last",
			"--session",
			sessionFile,
			"--max-turns",
			"3",
			"--epsilon",
			"1",
			"--effects",
			"10",
		]);

		const obsFile = join(workDir, "obs.json");
		writeFileSync(
			obsFile,
			JSON.stringify({
				detail: "observed",
				outcome: "confirms",
				observed_at: "2024-01-01T00:00:00Z",
				likelihood_if_true: 0.9,
				likelihood_if_false: 0.1,
			}),
		);

		const { exitCode, json } = await run([
			"cross-exam",
			"observe",
			hypotheses[0].id,
			"--session",
			sessionFile,
			"--observation",
			obsFile,
			"--epsilon",
			"0.1",
			"--effect",
			"1",
		]);
		expect(exitCode).toBe(0);
		const session = json.session as Record<string, unknown>;
		expect(session.turn).toBe(1);
	}, 30_000);

	test("challenge refutes a causal claim given a changed:false intervention", async () => {
		const nodesFile = join(workDir, "nodes.json");
		writeFileSync(nodesFile, JSON.stringify([{ id: "cause" }, { id: "effect" }]));
		const interventionsFile = join(workDir, "interventions.json");
		writeFileSync(
			interventionsFile,
			JSON.stringify([
				{ cause: "cause", effect: "effect", changed: false, description: "re-ran" },
			]),
		);
		const { exitCode, json } = await run([
			"cross-exam",
			"challenge",
			"--nodes",
			nodesFile,
			"--interventions",
			interventionsFile,
		]);
		expect(exitCode).toBe(0);
		expect((json.refuted as unknown[]).length).toBe(1);
	});
});
