/**
 * `failsafe retry-amplification diagnose` CLI tests (item 58 — trace
 * retry-induced fault persistence and amplification).
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

function makeIncident(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		cause_category: "timeout",
		component: "svc-a",
		causal_path: ["api", "svc-a"],
		message: "deadline exceeded",
		occurred_at_ms: 1000,
		...overrides,
	};
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-retry-amplification-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("retry-amplification diagnose", () => {
	test("reports blind_replication for a retry that reproduces the same fault", async () => {
		const attemptsFile = join(workDir, "attempts-blind.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([
				{ attempt_id: "a1", sequence: 0, incident: makeIncident("inc-1"), blast_radius: 1 },
				{ attempt_id: "a2", sequence: 1, incident: makeIncident("inc-2"), blast_radius: 1 },
			]),
		);
		const { exitCode, stdout } = await run([
			"retry-amplification",
			"diagnose",
			"--attempts",
			attemptsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.confidence).toBe("full");
		expect(json.findings.some((f: { kind: string }) => f.kind === "blind_replication")).toBe(true);
	});

	test("reports cascade_amplification when blast radius grows", async () => {
		const attemptsFile = join(workDir, "attempts-cascade.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([
				{ attempt_id: "a1", sequence: 0, incident: makeIncident("inc-1"), blast_radius: 1 },
				{
					attempt_id: "a2",
					sequence: 1,
					incident: makeIncident("inc-2", { cause_category: "rate_limit" }),
					blast_radius: 4,
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"retry-amplification",
			"diagnose",
			"--attempts",
			attemptsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings.some((f: { kind: string }) => f.kind === "cascade_amplification")).toBe(
			true,
		);
	});

	test("abstains with a single attempt", async () => {
		const attemptsFile = join(workDir, "attempts-single.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([{ attempt_id: "a1", sequence: 0, incident: makeIncident("inc-1"), blast_radius: 1 }]),
		);
		const { exitCode, stdout } = await run([
			"retry-amplification",
			"diagnose",
			"--attempts",
			attemptsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.confidence).toBe("abstained");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const attemptsFile = join(workDir, "attempts-render.json");
		writeFileSync(
			attemptsFile,
			JSON.stringify([
				{ attempt_id: "a1", sequence: 0, incident: makeIncident("inc-1"), blast_radius: 1 },
				{ attempt_id: "a2", sequence: 1, incident: makeIncident("inc-2"), blast_radius: 1 },
			]),
		);
		const { exitCode, stdout } = await run([
			"retry-amplification",
			"diagnose",
			"--attempts",
			attemptsFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Retry Persistence");
	});

	test("errors with a non-zero exit code on an unreadable attempts file", async () => {
		const { exitCode, stdout } = await run([
			"retry-amplification",
			"diagnose",
			"--attempts",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
