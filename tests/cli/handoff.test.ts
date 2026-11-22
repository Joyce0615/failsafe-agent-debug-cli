/**
 * `failsafe handoff receive` CLI tests (item 49 — add causal continuity
 * across handoffs).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-handoff-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function hypothesisFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "h1",
		failure_id: "f1",
		level: "function",
		statement: "auth.py reads a key that may be absent",
		location: "auth.py:42",
		prior: 0.5,
		posterior: 0.8,
		status: "open",
		observations: [],
		...overrides,
	};
}

function packageFixture(overrides: Record<string, unknown> = {}) {
	return {
		handoff_id: "ho1",
		failure_id: "f1",
		captured_at_ms: 1_000_000,
		hypotheses: [hypothesisFixture()],
		rejected_causes: [],
		evidence_spent: { storage_bytes: 100, runtime_ms: 50 },
		privacy_floor: { pii: "hash" },
		ownership: { current_owner: "agent-a", owner_kind: "agent" },
		recovery_state: { run_id: "run1", phase: "attribute", status: "in_progress" },
		...overrides,
	};
}

describe("handoff receive", () => {
	test("within staleness threshold, no refusals and no stale hypotheses", async () => {
		const pkgFile = join(workDir, "pkg-fresh.json");
		writeFileSync(pkgFile, JSON.stringify(packageFixture()));
		const { exitCode, stdout } = await run([
			"handoff",
			"receive",
			"--package",
			pkgFile,
			"--now",
			"1000500",
			"--staleness-threshold",
			"60000",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.within_staleness_threshold).toBe(true);
		expect(json.refusals).toEqual([]);
	});

	test("past staleness threshold, an open hypothesis is capped and reported stale", async () => {
		const pkgFile = join(workDir, "pkg-stale.json");
		writeFileSync(pkgFile, JSON.stringify(packageFixture()));
		const { exitCode, stdout } = await run([
			"handoff",
			"receive",
			"--package",
			pkgFile,
			"--now",
			"2000000",
			"--staleness-threshold",
			"60000",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.within_staleness_threshold).toBe(false);
		expect(json.stale_hypotheses).toHaveLength(1);
		expect(json.effective_hypotheses[0].posterior).toBe(0.5);
	});

	test("declared recovery phase rewound produces a recovery_rewound refusal", async () => {
		const pkgFile = join(workDir, "pkg-recovery.json");
		writeFileSync(
			pkgFile,
			JSON.stringify(
				packageFixture({
					recovery_state: { run_id: "run1", phase: "rerun", status: "in_progress" },
				}),
			),
		);
		const { exitCode, stdout } = await run([
			"handoff",
			"receive",
			"--package",
			pkgFile,
			"--now",
			"1000500",
			"--staleness-threshold",
			"60000",
			"--declared-recovery-phase",
			"attribute",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.refusals).toHaveLength(1);
		expect(json.refusals[0].code).toBe("recovery_rewound");
	});

	test("declared privacy floor loosened produces a privacy_loosened refusal", async () => {
		const pkgFile = join(workDir, "pkg-privacy.json");
		const floorFile = join(workDir, "floor.json");
		writeFileSync(pkgFile, JSON.stringify(packageFixture()));
		writeFileSync(floorFile, JSON.stringify({ pii: "allow" }));
		const { exitCode, stdout } = await run([
			"handoff",
			"receive",
			"--package",
			pkgFile,
			"--now",
			"1000500",
			"--staleness-threshold",
			"60000",
			"--declared-privacy-floor",
			floorFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.refusals).toHaveLength(1);
		expect(json.refusals[0].code).toBe("privacy_loosened");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const pkgFile = join(workDir, "pkg-render.json");
		writeFileSync(pkgFile, JSON.stringify(packageFixture()));
		const { exitCode, stdout } = await run([
			"handoff",
			"receive",
			"--package",
			pkgFile,
			"--now",
			"1000500",
			"--staleness-threshold",
			"60000",
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Handoff Continuity Report");
	});

	test("errors with a non-zero exit code when the package file is missing", async () => {
		const { exitCode, stdout } = await run([
			"handoff",
			"receive",
			"--package",
			join(workDir, "does-not-exist.json"),
			"--now",
			"1000500",
			"--staleness-threshold",
			"60000",
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
