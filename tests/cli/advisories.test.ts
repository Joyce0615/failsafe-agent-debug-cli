/**
 * `failsafe advisories ingest` CLI tests (item 37 — ingest runtime and
 * dependency security advisories).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-advisories-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("advisories ingest", () => {
	test("an exploitable advisory with a patched_version proposes exactly that upgrade", async () => {
		const advisoriesFile = join(workDir, "advisories.json");
		const sbomFile = join(workDir, "sbom-components.json");
		const exposureFile = join(workDir, "exposure.json");
		const evidenceFile = join(workDir, "evidence.json");
		writeFileSync(
			advisoriesFile,
			JSON.stringify([
				{
					id: "GHSA-test-1",
					package: "left-pad",
					affected_versions: ["1.0.0"],
					patched_version: "1.0.1",
					attack_vector: "network",
					summary: "test advisory",
				},
			]),
		);
		writeFileSync(
			sbomFile,
			JSON.stringify([
				{
					type: "library",
					name: "left-pad",
					version: "1.0.0",
					scope: "required",
					licenses: ["MIT"],
					purl: "pkg:npm/left-pad@1.0.0",
				},
			]),
		);
		writeFileSync(
			exposureFile,
			JSON.stringify({ network_reachable: true, local_reachable: true, physical_reachable: true }),
		);
		writeFileSync(
			evidenceFile,
			JSON.stringify({ implicated_components: ["left-pad"], error_text: "" }),
		);
		const { exitCode, stdout } = await run([
			"advisories",
			"ingest",
			"--advisories",
			advisoriesFile,
			"--sbom-components",
			sbomFile,
			"--exposure",
			exposureFile,
			"--evidence",
			evidenceFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.assessments[0].status).toBe("exploitable");
		expect(json.attribution.attributed).toBe(true);
		expect(json.recoveries[0].actions[0]).toEqual({
			kind: "upgrade",
			package: "left-pad",
			to_version: "1.0.1",
		});
	});

	test("a package absent from the SBOM is not_affected and proposes no recovery", async () => {
		const advisoriesFile = join(workDir, "advisories2.json");
		const sbomFile = join(workDir, "sbom-components2.json");
		const exposureFile = join(workDir, "exposure2.json");
		writeFileSync(
			advisoriesFile,
			JSON.stringify([
				{
					id: "GHSA-test-2",
					package: "left-pad",
					affected_versions: ["1.0.0"],
					attack_vector: "network",
					summary: "test advisory",
				},
			]),
		);
		writeFileSync(
			sbomFile,
			JSON.stringify([
				{
					type: "library",
					name: "other-pkg",
					version: "2.0.0",
					scope: "required",
					licenses: ["MIT"],
					purl: "pkg:npm/other-pkg@2.0.0",
				},
			]),
		);
		writeFileSync(
			exposureFile,
			JSON.stringify({ network_reachable: true, local_reachable: true, physical_reachable: true }),
		);
		const { exitCode, stdout } = await run([
			"advisories",
			"ingest",
			"--advisories",
			advisoriesFile,
			"--sbom-components",
			sbomFile,
			"--exposure",
			exposureFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.assessments[0].status).toBe("not_affected");
		expect(json.recoveries).toHaveLength(0);
	});

	test("errors with a non-zero exit code when a required input file is missing", async () => {
		const { exitCode, stdout } = await run([
			"advisories",
			"ingest",
			"--advisories",
			join(workDir, "does-not-exist.json"),
			"--sbom-components",
			join(workDir, "does-not-exist-2.json"),
			"--exposure",
			join(workDir, "does-not-exist-3.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
