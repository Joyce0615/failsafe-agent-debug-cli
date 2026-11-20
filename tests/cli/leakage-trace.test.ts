/**
 * `failsafe leakage-trace sweep` CLI tests (item 46 — detect prompt-variable
 * and structured-result leakage).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-leakage-trace-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("leakage-trace sweep", () => {
	test("reports no leaked values when every surface dropped the prompt", async () => {
		const file = join(workDir, "captures-clean.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					value: { value_id: "v1", key: "prompt", value: "do the secret thing" },
					captures: [
						{ surface: "span", location: "span.attr.prompt", kind: "content", captured: "" },
						{ surface: "log", location: "logger.info", kind: "schema_metadata" },
					],
				},
			]),
		);
		const { exitCode, stdout } = await run(["leakage-trace", "sweep", "--captures", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.leaked_value_ids).toEqual([]);
	});

	test("reports a leak when a surface recorded the raw prompt verbatim", async () => {
		const file = join(workDir, "captures-leak.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					value: { value_id: "v2", key: "prompt", value: "do the secret thing" },
					captures: [
						{
							surface: "exception",
							location: "exception.message",
							kind: "content",
							captured: "crashed while processing: do the secret thing",
						},
					],
				},
			]),
		);
		const { exitCode, stdout } = await run(["leakage-trace", "sweep", "--captures", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.leaked_value_ids).toEqual(["v2"]);
		expect(json.reports[0].first_leak).toBe("exception");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const file = join(workDir, "captures-render.json");
		writeFileSync(file, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"leakage-trace",
			"sweep",
			"--captures",
			file,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Prompt-Variable / Structured-Result Leakage Report");
	});

	test("--salt threads a custom PII hash salt into the policy check", async () => {
		const file = join(workDir, "captures-salt.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					value: { value_id: "v3", key: "customer_email", value: "alice@example.com" },
					captures: [
						{
							surface: "cache",
							location: "diagnosis_cache",
							kind: "content",
							// sha256(`${salt}:alice@example.com`).hex.slice(0,16), prefixed `pii_` (data-classes.ts's `pseudonym`).
							captured: "pii_5f6b4a7070ce1fbd",
						},
					],
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"leakage-trace",
			"sweep",
			"--captures",
			file,
			"--salt",
			"0123456789abcdef0123",
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.reports[0].observations[0].verdict).toBe("compliant");
	});

	test("errors with a non-zero exit code when the captures file is missing", async () => {
		const { exitCode, stdout } = await run([
			"leakage-trace",
			"sweep",
			"--captures",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
