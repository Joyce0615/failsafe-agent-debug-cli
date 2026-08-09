/**
 * Benchmark-matrix adapter (item 39).
 *
 * The load-bearing property: an interrupted run resumes without duplicating
 * completed instances. Also covers dataset adapters, pinning validation,
 * force-failed re-runs, and aggregate/comparison metrics.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BENCH_MANIFEST_VERSION,
	type BenchmarkManifest,
	BenchmarkManifestSchema,
	fromR2eGym,
	fromSweBench,
	fromSweSmith,
	parseManifest,
	validateManifest,
} from "../../src/bench/manifest.js";
import {
	aggregate,
	compactResults,
	compareRuns,
	latestResults,
	loadResults,
	runMatrix,
} from "../../src/bench/runner.js";

let dir: string;
let resultsPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "failsafe-bench-"));
	resultsPath = join(dir, "results", "run.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function manifest(count = 5): BenchmarkManifest {
	return BenchmarkManifestSchema.parse({
		schema_version: BENCH_MANIFEST_VERSION,
		benchmark: "swe-bench-debug",
		dataset_version: "swe-bench-lite@2024-10-01",
		created_at: new Date().toISOString(),
		budget: { max_steps: 20, max_tokens: 50_000 },
		instances: Array.from({ length: count }, (_, i) => ({
			instance_id: `inst_${i}`,
			repo: "acme/widget",
			base_commit: "abc1234",
			command: "pytest tests/",
			expected_pass: [`tests/test_${i}.py::test_it`],
		})),
	});
}

describe("dataset adapters", () => {
	test("SWE-bench rows normalize, including JSON-encoded FAIL_TO_PASS", () => {
		const m = fromSweBench(
			[
				{
					instance_id: "django__django-11099",
					repo: "django/django",
					base_commit: "d26b2424437dabeeca94d7900b37d2df4410da0c",
					problem_statement: "UsernameValidator allows trailing newline",
					FAIL_TO_PASS: '["tests/auth_tests/test_validators.py::test_ascii"]',
				},
			],
			"princeton-nlp/SWE-bench_Lite@main",
		);
		expect(m.benchmark).toBe("swe-bench-debug");
		expect(m.instances[0].instance_id).toBe("django__django-11099");
		expect(m.instances[0].expected_pass).toEqual([
			"tests/auth_tests/test_validators.py::test_ascii",
		]);
		// No explicit command in the dataset: derived from FAIL_TO_PASS.
		expect(m.instances[0].command).toContain("pytest tests/auth_tests");
		expect(m.instances[0].task).toContain("trailing newline");
	});

	test("SWE-smith and R2E-Gym rows normalize to the same shape", () => {
		const smith = fromSweSmith(
			[
				{
					instance_id: "smith_1",
					repo: "acme/lib",
					base_commit: "deadbee",
					test_command: "pytest -x",
					fail_to_pass: ["tests/test_a.py::test_b"],
				},
			],
			"swe-smith@v1",
		);
		expect(smith.benchmark).toBe("swe-smith");
		expect(smith.instances[0].command).toBe("pytest -x");

		const r2e = fromR2eGym(
			[
				{
					docker_image: "r2e/repo@sha256:aaaa",
					repo_name: "acme/lib",
					commit: "0123456",
					test_command: "python -m pytest",
				},
			],
			"r2e-gym@v2",
		);
		expect(r2e.benchmark).toBe("r2e-gym");
		expect(r2e.instances[0].image).toBe("r2e/repo@sha256:aaaa");
		expect(r2e.instances[0].instance_id).toBe("r2e/repo@sha256:aaaa");
		// All three adapters produce the same canonical keys.
		expect(Object.keys(smith.instances[0]).sort()).toEqual(Object.keys(r2e.instances[0]).sort());
	});
});

describe("validateManifest", () => {
	test("accepts pinned instances", () => {
		expect(validateManifest(manifest(2))).toEqual([]);
	});

	test("flags duplicates, unpinned revisions, and floating images", () => {
		const m = BenchmarkManifestSchema.parse({
			...manifest(0),
			instances: [
				{
					instance_id: "dup",
					repo: "r",
					base_commit: "abc1234",
					command: "pytest",
					image: "acme/img:1.2.3",
				},
				{
					instance_id: "dup",
					repo: "r",
					base_commit: "main",
					command: "pytest",
					image: "acme/img:latest",
				},
			],
		});
		const issues = validateManifest(m);
		expect(issues.some((i) => i.problem === "duplicate instance_id")).toBe(true);
		expect(issues.some((i) => i.problem.includes("not a pinned revision"))).toBe(true);
		expect(issues.some((i) => i.problem.includes("image is not pinned"))).toBe(true);
	});

	test("round-trips through JSON", () => {
		const m = manifest(2);
		expect(parseManifest(JSON.stringify(m)).instances.length).toBe(2);
		expect(() => parseManifest('{"schema_version":"9.9"}')).toThrow();
	});
});

describe("runMatrix resume semantics", () => {
	test("an interrupted run resumes without duplicating completed instances", async () => {
		const m = manifest(5);
		const firstPass: string[] = [];

		// A throwing instance is recorded as `error` rather than aborting the
		// sweep — one bad instance must not lose the rest of the run.
		const first = await runMatrix({
			manifest: m,
			resultsPath,
			execute: (instance) => {
				if (instance.instance_id === "inst_3") throw new Error("__boom__");
				firstPass.push(instance.instance_id);
				return { status: "resolved", steps: 4, tokens: 1000, duration_ms: 10 };
			},
		});
		expect(firstPass).toEqual(["inst_0", "inst_1", "inst_2", "inst_4"]);
		expect(first.metrics.errored).toBe(1);
		let recorded = loadResults(resultsPath);
		expect(recorded.length).toBe(5);

		// Now simulate a genuine interruption (process killed mid-sweep): only
		// the first three lines were flushed.
		const lines = readFileSync(resultsPath, "utf-8").trim().split("\n").slice(0, 3);
		writeFileSync(resultsPath, `${lines.join("\n")}\n`);
		expect(loadResults(resultsPath).length).toBe(3);

		const secondPass: string[] = [];
		const report = await runMatrix({
			manifest: m,
			resultsPath,
			execute: (instance) => {
				secondPass.push(instance.instance_id);
				return { status: "resolved", steps: 2, tokens: 500, duration_ms: 5 };
			},
		});

		// Only the missing instances ran; the completed three were skipped.
		expect(secondPass).toEqual(["inst_3", "inst_4"]);
		expect(report.skipped).toEqual(["inst_0", "inst_1", "inst_2"]);

		// Exactly one record per instance — no duplicates.
		recorded = loadResults(resultsPath);
		expect(recorded.length).toBe(5);
		expect(new Set(recorded.map((r) => r.instance_id)).size).toBe(5);
		expect(report.metrics.total).toBe(5);
		expect(report.metrics.resolved).toBe(5);
	});

	test("a truncated final line is dropped rather than crashing the resume", () => {
		mkdirSync(join(dir, "results"), { recursive: true });
		const good = {
			instance_id: "inst_0",
			benchmark: "swe-bench-debug",
			dataset_version: "v",
			status: "resolved",
			steps: 1,
			tokens: 1,
			duration_ms: 1,
			completed_at: new Date().toISOString(),
		};
		writeFileSync(resultsPath, `${JSON.stringify(good)}\n{"instance_id":"inst_1","st`);
		const results = loadResults(resultsPath);
		expect(results.length).toBe(1);
		expect(results[0].instance_id).toBe("inst_0");
	});

	test("resume:false re-executes everything", async () => {
		const m = manifest(3);
		await runMatrix({ manifest: m, resultsPath, execute: () => ({ status: "resolved" }) });
		const executed: string[] = [];
		const report = await runMatrix({
			manifest: m,
			resultsPath,
			resume: false,
			execute: (i) => {
				executed.push(i.instance_id);
				return { status: "resolved" };
			},
		});
		expect(executed.length).toBe(3);
		expect(report.skipped).toEqual([]);
		// The latest record per instance still collapses to 3.
		expect(latestResults(loadResults(resultsPath)).size).toBe(3);
	});

	test("onlyFailed re-runs failures and supersedes their record", async () => {
		const m = manifest(3);
		await runMatrix({
			manifest: m,
			resultsPath,
			execute: (i) => ({ status: i.instance_id === "inst_1" ? "unresolved" : "resolved" }),
		});

		const executed: string[] = [];
		const report = await runMatrix({
			manifest: m,
			resultsPath,
			onlyFailed: true,
			execute: (i) => {
				executed.push(i.instance_id);
				return { status: "resolved", steps: 7 };
			},
		});
		expect(executed).toEqual(["inst_1"]);
		expect(report.metrics.resolved).toBe(3);
		expect(report.metrics.unresolved).toBe(0);

		// The superseding line wins; compaction leaves one record per instance.
		expect(latestResults(loadResults(resultsPath)).get("inst_1")!.steps).toBe(7);
		expect(compactResults(resultsPath)).toBe(3);
		expect(loadResults(resultsPath).length).toBe(3);
	});

	test("limit caps executions in one invocation", async () => {
		const report = await runMatrix({
			manifest: manifest(5),
			resultsPath,
			limit: 2,
			execute: () => ({ status: "resolved" }),
		});
		expect(report.executed.length).toBe(2);
		expect(report.skipped.length).toBe(3);
	});

	test("the injected executor receives the manifest budget", async () => {
		let seen: unknown;
		await runMatrix({
			manifest: manifest(1),
			resultsPath,
			execute: (_i, budget) => {
				seen = budget;
				return { status: "resolved" };
			},
		});
		expect(seen).toEqual({ max_steps: 20, max_tokens: 50_000 });
	});
});

describe("metrics", () => {
	test("aggregate reports resolution rate and cost", async () => {
		await runMatrix({
			manifest: manifest(4),
			resultsPath,
			execute: (i) => ({
				status: i.instance_id === "inst_0" ? "resolved" : "unresolved",
				steps: 5,
				tokens: 200,
				duration_ms: 100,
			}),
		});
		const metrics = aggregate([...latestResults(loadResults(resultsPath)).values()]);
		expect(metrics.total).toBe(4);
		expect(metrics.resolution_rate).toBe(0.25);
		expect(metrics.avg_steps).toBe(5);
		expect(metrics.total_tokens).toBe(800);
		expect(metrics.total_ms).toBe(400);
		expect(aggregate([]).resolution_rate).toBe(0);
	});

	test("compareRuns surfaces cross-backend disagreements", async () => {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		await runMatrix({
			manifest: manifest(2),
			resultsPath: a,
			execute: () => ({ status: "resolved" }),
		});
		await runMatrix({
			manifest: manifest(2),
			resultsPath: b,
			execute: (i) => ({ status: i.instance_id === "inst_1" ? "unresolved" : "resolved" }),
		});
		const comparison = compareRuns(
			{ label: "backend_a", results: loadResults(a) },
			{ label: "backend_b", results: loadResults(b) },
		);
		expect(comparison.disagreements.length).toBe(1);
		expect(comparison.disagreements[0].instance_id).toBe("inst_1");
		expect((comparison.backend_a as { resolution_rate: number }).resolution_rate).toBe(1);
		expect((comparison.backend_b as { resolution_rate: number }).resolution_rate).toBe(0.5);
	});
});
