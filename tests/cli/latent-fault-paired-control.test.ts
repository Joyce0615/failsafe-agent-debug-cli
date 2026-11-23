/**
 * `failsafe latent-fault diagnose` CLI tests (item 56 — diagnose latent
 * faults with paired controls).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-latent-fault-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("latent-fault diagnose", () => {
	test("reports a semantic_corruption finding", async () => {
		const failingFile = join(workDir, "failing-corruption.json");
		const controlFile = join(workDir, "control-corruption.json");
		writeFileSync(
			failingFile,
			JSON.stringify({
				id: "f1",
				steps: [
					{ id: "s1", action: "fetch_doc", outcome: "ok", result_fingerprint: "hash-stale" },
				],
			}),
		);
		writeFileSync(
			controlFile,
			JSON.stringify({
				id: "c1",
				steps: [
					{ id: "s1", action: "fetch_doc", outcome: "ok", result_fingerprint: "hash-fresh" },
				],
			}),
		);
		const { exitCode, stdout } = await run([
			"latent-fault",
			"diagnose",
			"--failing",
			failingFile,
			"--control",
			controlFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings.some((f: { kind: string }) => f.kind === "semantic_corruption")).toBe(
			true,
		);
	});

	test("reports no findings for identical fingerprint matches", async () => {
		const failingFile = join(workDir, "failing-clean.json");
		const controlFile = join(workDir, "control-clean.json");
		const steps = [{ id: "s1", action: "fetch_doc", outcome: "ok", result_fingerprint: "h1" }];
		writeFileSync(failingFile, JSON.stringify({ id: "f1", steps }));
		writeFileSync(controlFile, JSON.stringify({ id: "c1", steps }));
		const { exitCode, stdout } = await run([
			"latent-fault",
			"diagnose",
			"--failing",
			failingFile,
			"--control",
			controlFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toEqual([]);
		expect(json.confidence).toBe("full");
	});

	test("reports confidence 'abstained' with no comparable branch", async () => {
		const failingFile = join(workDir, "failing-nomatch.json");
		const controlFile = join(workDir, "control-nomatch.json");
		writeFileSync(
			failingFile,
			JSON.stringify({ id: "f1", steps: [{ id: "s1", action: "write_file", outcome: "ok" }] }),
		);
		writeFileSync(
			controlFile,
			JSON.stringify({ id: "c1", steps: [{ id: "s1", action: "read_file", outcome: "ok" }] }),
		);
		const { exitCode, stdout } = await run([
			"latent-fault",
			"diagnose",
			"--failing",
			failingFile,
			"--control",
			controlFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.confidence).toBe("abstained");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const failingFile = join(workDir, "failing-render.json");
		const controlFile = join(workDir, "control-render.json");
		const steps = [{ id: "s1", action: "fetch_doc", outcome: "ok", result_fingerprint: "h1" }];
		writeFileSync(failingFile, JSON.stringify({ id: "f1", steps }));
		writeFileSync(controlFile, JSON.stringify({ id: "c1", steps }));
		const { exitCode, stdout } = await run([
			"latent-fault",
			"diagnose",
			"--failing",
			failingFile,
			"--control",
			controlFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Latent Fault Report");
	});

	test("errors with a non-zero exit code when the control file is missing", async () => {
		const failingFile = join(workDir, "failing-missing-control.json");
		writeFileSync(
			failingFile,
			JSON.stringify({ id: "f1", steps: [{ id: "s1", action: "fetch_doc", outcome: "ok" }] }),
		);
		const { exitCode, stdout } = await run([
			"latent-fault",
			"diagnose",
			"--failing",
			failingFile,
			"--control",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
