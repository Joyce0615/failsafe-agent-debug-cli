/**
 * `failsafe patch-validation validate` CLI tests (item 48 — validate
 * runtime security patches against incidents).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-patch-validation-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function assessmentFixture() {
	return {
		advisory: {
			id: "GHSA-0001",
			package: "left-pad",
			affected_versions: ["1.0.0"],
			patched_version: "1.0.1",
			attack_vector: "network",
			summary: "test advisory",
		},
		status: "exploitable",
		matched_components: [{ name: "left-pad", version: "1.0.0", purl: "pkg:npm/left-pad@1.0.0" }],
		rationale: "present and reachable",
	};
}

describe("patch-validation validate", () => {
	test("mitigated verdict recommends an upgrade action", async () => {
		const runsFile = join(workDir, "runs-mitigated.json");
		const assessmentFile = join(workDir, "assessment-mitigated.json");
		writeFileSync(
			runsFile,
			JSON.stringify({
				vulnerable: [
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
				],
				patched: [
					{ outcome: "exploit_failed" },
					{ outcome: "exploit_failed" },
					{ outcome: "exploit_failed" },
				],
			}),
		);
		writeFileSync(assessmentFile, JSON.stringify(assessmentFixture()));
		const { exitCode, stdout } = await run([
			"patch-validation",
			"validate",
			"--runs",
			runsFile,
			"--assessment",
			assessmentFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.validation.verdict).toBe("mitigated");
		expect(json.recommended_recovery.actions[0].kind).toBe("upgrade");
	});

	test("not_mitigated verdict withholds the upgrade action", async () => {
		const runsFile = join(workDir, "runs-not-mitigated.json");
		const assessmentFile = join(workDir, "assessment-not-mitigated.json");
		writeFileSync(
			runsFile,
			JSON.stringify({
				vulnerable: [
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
				],
				patched: [
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
				],
			}),
		);
		writeFileSync(assessmentFile, JSON.stringify(assessmentFixture()));
		const { exitCode, stdout } = await run([
			"patch-validation",
			"validate",
			"--runs",
			runsFile,
			"--assessment",
			assessmentFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.validation.verdict).toBe("not_mitigated");
		expect(
			json.recommended_recovery.actions.some((a: { kind: string }) => a.kind === "upgrade"),
		).toBe(false);
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const runsFile = join(workDir, "runs-render.json");
		const assessmentFile = join(workDir, "assessment-render.json");
		writeFileSync(
			runsFile,
			JSON.stringify({
				vulnerable: [
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
					{ outcome: "exploit_succeeded" },
				],
				patched: [
					{ outcome: "exploit_failed" },
					{ outcome: "exploit_failed" },
					{ outcome: "exploit_failed" },
				],
			}),
		);
		writeFileSync(assessmentFile, JSON.stringify(assessmentFixture()));
		const { exitCode, stdout } = await run([
			"patch-validation",
			"validate",
			"--runs",
			runsFile,
			"--assessment",
			assessmentFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Runtime Security Patch Validation");
	});

	test("missing runs for an arm produce a harness_error via the no-recorded-run fallback", async () => {
		const runsFile = join(workDir, "runs-missing-arm.json");
		const assessmentFile = join(workDir, "assessment-missing-arm.json");
		writeFileSync(
			runsFile,
			JSON.stringify({
				vulnerable: [{ outcome: "exploit_succeeded" }], // only 1, but 3 repeats requested by default
				patched: [
					{ outcome: "exploit_failed" },
					{ outcome: "exploit_failed" },
					{ outcome: "exploit_failed" },
				],
			}),
		);
		writeFileSync(assessmentFile, JSON.stringify(assessmentFixture()));
		const { exitCode, stdout } = await run([
			"patch-validation",
			"validate",
			"--runs",
			runsFile,
			"--assessment",
			assessmentFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.validation.verdict).toBe("harness_error");
	});

	test("errors with a non-zero exit code when the runs file is missing", async () => {
		const assessmentFile = join(workDir, "assessment-err.json");
		writeFileSync(assessmentFile, JSON.stringify(assessmentFixture()));
		const { exitCode, stdout } = await run([
			"patch-validation",
			"validate",
			"--runs",
			join(workDir, "does-not-exist.json"),
			"--assessment",
			assessmentFile,
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
