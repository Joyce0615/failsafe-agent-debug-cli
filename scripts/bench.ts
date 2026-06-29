#!/usr/bin/env bun
// Parse + diagnose latency benchmark.
//
// Parsing large logs and running the tiered rule engine is on the hot path for
// every `run`/`diagnose`. This harness measures both on a representative large
// synthetic log and reports per-operation latency against a recorded budget so
// a performance regression surfaces (the companion `tests/perf/latency.test.ts`
// asserts a generous ceiling in CI; this script prints actuals for humans).
//
// Usage: `bun scripts/bench.ts [--iterations N] [--check]`
//   --check  exit non-zero if any measurement exceeds BUDGETS.
import { diagnose } from "../src/diagnosis/engine.js";
import { detectAndParse, extractPrimaryLocation } from "../src/parsers/index.js";
import type { LearnedRule } from "../src/rules/types.js";
import { SCHEMA_VERSION } from "../src/types/common.js";
import type { FailureRecord } from "../src/types/failure.js";

/**
 * Per-operation latency budgets (ms) used by `--check`. `parse` is pure CPU and
 * tightly bounded; `diagnose` also spawns `git` for recent-diff evidence, so its
 * budget carries headroom for subprocess/IO jitter on shared runners. The
 * companion perf test uses even more generous ceilings to stay non-flaky.
 */
export const BUDGETS = {
	parse_ms: 30,
	diagnose_ms: 200,
};

/**
 * Build a large, realistic pytest log: many passing collection lines plus a
 * trailing failure block, sized to ~`approxKb` kilobytes.
 */
export function makeLargePytestLog(approxKb = 200): string {
	const header = [
		"============================= test session starts ==============================",
		"platform linux -- Python 3.12.0, pytest-8.1.0, pluggy-1.4.0",
		"rootdir: /project",
		"collected 5000 items",
		"",
	];
	const noise: string[] = [];
	let bytes = 0;
	let i = 0;
	const target = approxKb * 1024;
	while (bytes < target) {
		const line = `tests/test_module_${i % 200}.py::test_case_${i} PASSED                       [ ${(i % 100).toString().padStart(2, "0")}%]`;
		noise.push(line);
		bytes += line.length + 1;
		i += 1;
	}
	const failure = [
		"",
		"=================================== FAILURES ===================================",
		"________________________________ test_missing_email ____________________________",
		"",
		"    def create_user_from_oauth(payload):",
		'>       email = payload["email"]',
		"E       KeyError: 'email'",
		"",
		"src/auth.py:42: KeyError",
		"=========================== short test summary info ============================",
		"FAILED tests/test_auth.py::test_missing_email - KeyError: 'email'",
		"======================= 1 failed, 4999 passed in 12.34s ========================",
	];
	return [...header, ...noise, ...failure].join("\n");
}

export type Measurement = {
	label: string;
	iterations: number;
	total_ms: number;
	per_op_ms: number;
};

/** Run `fn` `iterations` times and report total + per-op latency. */
export function measure(label: string, iterations: number, fn: () => void): Measurement {
	// Warm up the JIT so we measure steady-state cost.
	for (let w = 0; w < Math.min(5, iterations); w++) fn();
	const start = performance.now();
	for (let n = 0; n < iterations; n++) fn();
	const total = performance.now() - start;
	return { label, iterations, total_ms: total, per_op_ms: total / iterations };
}

function makeBenchStore(): Parameters<typeof diagnose>[1] {
	return {
		findSimilarFailures: () => [],
		getRawOutput: () => "",
		getLearnedRuleByHash: () => null as LearnedRule | null,
		saveLearnedRule: () => {},
		updateLearnedRule: () => {},
		hasRecordedLearning: () => true,
		markLearningRecorded: () => {},
		getLatestSuccessfulFix: () => null,
		countUnresolvedAfterDate: () => 0,
		getFlakySignature: () => null,
		upsertFlakySignature: () => {},
		listFlakySignatures: () => [],
	};
}

function makeFailureRecord(log: string): FailureRecord {
	const parsed = detectAndParse(log, "", "pytest tests/");
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: "bench_fail",
		created_at: new Date().toISOString(),
		workspace: process.cwd(),
		command: "pytest tests/",
		cwd: process.cwd(),
		env_fingerprint: { os: "linux", arch: "x64", cwd: process.cwd() },
		status: "failed",
		exit_code: 1,
		duration_ms: 1,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed,
		primary_location: extractPrimaryLocation(parsed),
		related_locations: [],
		raw_artifacts: [],
	};
}

export async function runBenchmarks(iterations = 200): Promise<Measurement[]> {
	const log = makeLargePytestLog(200);
	const record = makeFailureRecord(log);
	const store = makeBenchStore();

	const results: Measurement[] = [];
	results.push(measure("parse", iterations, () => void detectAndParse(log, "", "pytest tests/")));

	// diagnose is async; measure it separately with its own timing loop.
	for (let w = 0; w < 5; w++) await diagnose(record, store);
	const dStart = performance.now();
	for (let n = 0; n < iterations; n++) await diagnose(record, store);
	const dTotal = performance.now() - dStart;
	results.push({
		label: "diagnose",
		iterations,
		total_ms: dTotal,
		per_op_ms: dTotal / iterations,
	});

	return results;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const check = args.includes("--check");
	const iterIdx = args.indexOf("--iterations");
	const iterations = iterIdx >= 0 ? Number.parseInt(args[iterIdx + 1] ?? "200", 10) : 200;

	const log = makeLargePytestLog(200);
	console.log(
		`Benchmark: pytest log ≈ ${(log.length / 1024).toFixed(1)} KiB, ${iterations} iters\n`,
	);

	const results = await runBenchmarks(iterations);
	let overBudget = false;
	for (const r of results) {
		const budget = r.label === "parse" ? BUDGETS.parse_ms : BUDGETS.diagnose_ms;
		const flag = r.per_op_ms > budget ? " OVER BUDGET" : "";
		if (r.per_op_ms > budget) overBudget = true;
		console.log(
			`  ${r.label.padEnd(10)} ${r.per_op_ms.toFixed(3)} ms/op (budget ${budget} ms)${flag}`,
		);
	}

	if (check && overBudget) {
		console.error("\nLatency budget exceeded.");
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
