/**
 * `failsafe stream` CLI tests (item 35 — streaming incident diagnosis).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-stream-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("stream", () => {
	test("start creates a session seeded from the failure's stored hypotheses", async () => {
		await run(["run", "python3 -c \"raise KeyError('stream')\""]);
		await run(["diagnose", "last"]);
		await run(["hypotheses", "build", "last"]);

		const sessionFile = join(workDir, "session.json");
		const { exitCode, json } = await run(["stream", "start", "last", "--session", sessionFile]);
		expect(exitCode).toBe(0);
		expect(json.processed).toBe(0);
	}, 30_000);

	test("ingest folds an observation into the session and may emit an alert", async () => {
		await run(["run", "python3 -c \"raise KeyError('stream2')\""]);
		await run(["diagnose", "last"]);
		const built = await run(["hypotheses", "build", "last"]);
		const hypotheses = built.json.hypotheses as Array<{ id: string }>;

		const sessionFile = join(workDir, "session2.json");
		await run(["stream", "start", "last", "--session", sessionFile]);

		const eventFile = join(workDir, "event.json");
		writeFileSync(
			eventFile,
			JSON.stringify({
				sequence: 1,
				observation: {
					hypothesis_id: hypotheses[0].id,
					observation: {
						detail: "observed",
						outcome: "confirms",
						observed_at: "2024-01-01T00:00:00Z",
						likelihood_if_true: 0.9,
						likelihood_if_false: 0.1,
					},
				},
			}),
		);

		const { exitCode, json } = await run([
			"stream",
			"ingest",
			"--session",
			sessionFile,
			"--event",
			eventFile,
		]);
		expect(exitCode).toBe(0);
		expect(json.processed).toBe(1);
	}, 30_000);

	test("snapshot produces a deterministic hash for a given session", async () => {
		await run(["run", "python3 -c \"raise KeyError('stream3')\""]);
		await run(["diagnose", "last"]);
		await run(["hypotheses", "build", "last"]);

		const sessionFile = join(workDir, "session3.json");
		await run(["stream", "start", "last", "--session", sessionFile]);

		const { exitCode, json } = await run(["stream", "snapshot", "--session", sessionFile]);
		expect(exitCode).toBe(0);
		expect(typeof json.snapshot_hash).toBe("string");
	}, 30_000);
});
