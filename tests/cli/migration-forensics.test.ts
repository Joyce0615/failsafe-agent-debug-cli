/**
 * `failsafe migration-forensics diagnose` CLI tests (item 59 — add
 * protocol-deprecation migration forensics).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-migration-forensics-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("migration-forensics diagnose", () => {
	test("reports client_assumption when the client still sends the legacy shape", async () => {
		const file = join(workDir, "obs-client.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					operation_id: "op-1",
					dimension: "mrtr",
					current_behavior: "stalled",
					spec_expected_behavior: "resumed",
					client_sent_legacy_shape: true,
					server_replied_legacy_shape: false,
				},
			]),
		);
		const { exitCode, stdout } = await run(["migration-forensics", "diagnose", "--observations", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.reports[0].findings[0].attribution).toBe("client_assumption");
	});

	test("reports migrated_cleanly when current behavior already matches spec", async () => {
		const file = join(workDir, "obs-clean.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					operation_id: "op-2",
					dimension: "result_type",
					current_behavior: "typed",
					spec_expected_behavior: "typed",
					client_sent_legacy_shape: false,
					server_replied_legacy_shape: false,
				},
			]),
		);
		const { exitCode, stdout } = await run(["migration-forensics", "diagnose", "--observations", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.reports[0].migrated_cleanly).toEqual(["result_type"]);
		expect(json.reports[0].findings).toEqual([]);
	});

	test("reports sdk_translation_defect when both endpoints sent current shapes but behavior still diverges", async () => {
		const file = join(workDir, "obs-sdk.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					operation_id: "op-3",
					dimension: "subscription",
					current_behavior: "lost",
					spec_expected_behavior: "delivered",
					client_sent_legacy_shape: false,
					server_replied_legacy_shape: false,
				},
			]),
		);
		const { exitCode, stdout } = await run(["migration-forensics", "diagnose", "--observations", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.reports[0].findings[0].attribution).toBe("sdk_translation_defect");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const file = join(workDir, "obs-render.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					operation_id: "op-4",
					dimension: "sse_resume",
					current_behavior: "dropped",
					spec_expected_behavior: "resumed",
					client_sent_legacy_shape: true,
					server_replied_legacy_shape: true,
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"migration-forensics",
			"diagnose",
			"--observations",
			file,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Migration Forensics");
	});

	test("errors with a non-zero exit code on an unreadable observations file", async () => {
		const { exitCode, stdout } = await run([
			"migration-forensics",
			"diagnose",
			"--observations",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
