/**
 * `failsafe spec-divergence diagnose|reduce` CLI tests (item 45 — diagnose
 * generated-SDK and spec divergence).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-spec-divergence-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("spec-divergence diagnose", () => {
	test("reports no classifications when both clients agree", async () => {
		const fixturesFile = join(workDir, "fixtures-clean.json");
		const runsFile = join(workDir, "runs-clean.json");
		writeFileSync(fixturesFile, JSON.stringify([{ fixture_id: "f1" }]));
		writeFileSync(
			runsFile,
			JSON.stringify([
				{
					fixture_id: "f1",
					generated: { outcome: "ok", response: { a: 1 } },
					handwritten: { outcome: "ok", response: { a: 1 } },
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"spec-divergence",
			"diagnose",
			"--fixtures",
			fixturesFile,
			"--runs",
			runsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.classifications).toHaveLength(0);
	});

	test("classifies a fully-ambiguous mismatch as spec_ambiguity", async () => {
		const fixturesFile = join(workDir, "fixtures-ambig.json");
		const runsFile = join(workDir, "runs-ambig.json");
		writeFileSync(
			fixturesFile,
			JSON.stringify([{ fixture_id: "f1", spec_ambiguous_fields: ["a"] }]),
		);
		writeFileSync(
			runsFile,
			JSON.stringify([
				{
					fixture_id: "f1",
					generated: { outcome: "ok", response: { a: 1 } },
					handwritten: { outcome: "ok", response: { a: 2 } },
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"spec-divergence",
			"diagnose",
			"--fixtures",
			fixturesFile,
			"--runs",
			runsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.classifications[0].cause).toBe("spec_ambiguity");
	});

	test("--evidence routes a generator_defect finding through to the classification", async () => {
		const fixturesFile = join(workDir, "fixtures-gen.json");
		const runsFile = join(workDir, "runs-gen.json");
		const evidenceFile = join(workDir, "evidence-gen.json");
		writeFileSync(fixturesFile, JSON.stringify([{ fixture_id: "f1" }]));
		writeFileSync(
			runsFile,
			JSON.stringify([
				{
					fixture_id: "f1",
					generated: { outcome: "ok", response: { a: 1 } },
					handwritten: { outcome: "ok", response: { a: 2 } },
				},
			]),
		);
		writeFileSync(evidenceFile, JSON.stringify({ f1: { generator_defect: { detail: "stale" } } }));
		const { exitCode, stdout } = await run([
			"spec-divergence",
			"diagnose",
			"--fixtures",
			fixturesFile,
			"--runs",
			runsFile,
			"--evidence",
			evidenceFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.classifications[0].cause).toBe("generator_defect");
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const fixturesFile = join(workDir, "fixtures-render.json");
		const runsFile = join(workDir, "runs-render.json");
		writeFileSync(fixturesFile, JSON.stringify([]));
		writeFileSync(runsFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"spec-divergence",
			"diagnose",
			"--fixtures",
			fixturesFile,
			"--runs",
			runsFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("# Generated-SDK / Spec Divergence Report");
	});

	test("errors with a non-zero exit code when the fixtures file is missing", async () => {
		const runsFile = join(workDir, "runs-missing.json");
		writeFileSync(runsFile, JSON.stringify([]));
		const { exitCode, stdout } = await run([
			"spec-divergence",
			"diagnose",
			"--fixtures",
			join(workDir, "does-not-exist.json"),
			"--runs",
			runsFile,
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});

describe("spec-divergence reduce", () => {
	test("reduces to the minimal fixture subset witnessing the same cause", async () => {
		const fixturesFile = join(workDir, "fixtures-reduce.json");
		const runsFile = join(workDir, "runs-reduce.json");
		const evidenceFile = join(workDir, "evidence-reduce.json");
		writeFileSync(fixturesFile, JSON.stringify([{ fixture_id: "clean" }, { fixture_id: "bad" }]));
		writeFileSync(
			runsFile,
			JSON.stringify([
				{
					fixture_id: "clean",
					generated: { outcome: "ok", response: { a: 1 } },
					handwritten: { outcome: "ok", response: { a: 1 } },
				},
				{
					fixture_id: "bad",
					generated: { outcome: "ok", response: { a: 1 } },
					handwritten: { outcome: "ok", response: { a: 2 } },
				},
			]),
		);
		writeFileSync(evidenceFile, JSON.stringify({ bad: { generator_defect: { detail: "stale" } } }));
		const { exitCode, stdout } = await run([
			"spec-divergence",
			"reduce",
			"--fixtures",
			fixturesFile,
			"--runs",
			runsFile,
			"--evidence",
			evidenceFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.baseline_cause).toBe("generator_defect");
		expect(json.elements.map((e: { id: string }) => e.id)).toEqual(["bad"]);
	});
});
