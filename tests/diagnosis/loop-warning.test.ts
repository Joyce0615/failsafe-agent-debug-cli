/**
 * loop_warning tests (item 23).
 *
 * When one failure signature keeps recurring unresolved past the threshold, the
 * diagnosis packet gains a `loop_warning` steering the agent to confirm the root
 * cause at runtime (debug/step) instead of patching blind. The warning reflects
 * the CURRENT recurrence count and is overlaid even on a cache hit.
 */
import { describe, expect, test } from "bun:test";
import { diagnose } from "../../src/diagnosis/engine.js";
import type { LearnedRule } from "../../src/rules/types.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { FailureRecord } from "../../src/types/failure.js";

type DiagnoseStore = Parameters<typeof diagnose>[1];

/** A store whose unresolved-recurrence count is controllable at test time. */
function makeStore(recurrence: () => number) {
	const cache = new Map<string, FailureDiagnosis>();
	const store: DiagnoseStore = {
		findSimilarFailures: () => [],
		getRawOutput: () => "",
		getLearnedRuleByHash: () => null as LearnedRule | null,
		saveLearnedRule: () => {},
		updateLearnedRule: () => {},
		hasRecordedLearning: () => true,
		markLearningRecorded: () => {},
		getLatestSuccessfulFix: () => null, // never flaky
		countUnresolvedAfterDate: () => recurrence(),
		getFlakySignature: () => null,
		upsertFlakySignature: () => {},
		listFlakySignatures: () => [],
		getCachedDiagnosis: (key) => cache.get(key) ?? null,
		saveCachedDiagnosis: (key, diag) => {
			cache.set(key, diag);
		},
	};
	return { store, cache };
}

function makeFailure(): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: "fail_loop",
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
		parsed: [
			{
				parser: "pytest",
				failure_type: "test_failure",
				errors: [{ message: "KeyError: 'email'", error_type: "KeyError" }],
			},
		],
		primary_location: { file: "src/auth.py", line: 42 },
		related_locations: [],
		raw_artifacts: [],
	};
}

describe("loop_warning", () => {
	test("fires once unresolved recurrences reach the threshold", async () => {
		const { store } = makeStore(() => 4); // threshold defaults to 3
		const diag = await diagnose(makeFailure(), store);
		expect(diag.loop_warning).toBeDefined();
		expect(diag.loop_warning?.detected).toBe(true);
		expect(diag.loop_warning?.occurrences).toBe(4);
		expect(diag.loop_warning?.recommendation).toContain("failsafe debug fail_loop");
		expect(diag.loop_warning?.reason).toContain("recurred unresolved 4 times");
	});

	test("does not fire below the threshold", async () => {
		const { store } = makeStore(() => 1);
		const diag = await diagnose(makeFailure(), store);
		expect(diag.loop_warning).toBeUndefined();
	});

	test("is overlaid on a cache hit and reflects the current recurrence", async () => {
		let recurrence = 1;
		const { store, cache } = makeStore(() => recurrence);

		// First diagnosis below threshold: cached, no warning.
		const first = await diagnose(makeFailure(), store);
		expect(first.loop_warning).toBeUndefined();
		// The cached packet is loop_warning-free (recurrence is time-varying).
		expect([...cache.values()][0].loop_warning).toBeUndefined();

		// The signature keeps recurring; a re-diagnosis (cache hit) must now warn.
		recurrence = 5;
		const second = await diagnose(makeFailure(), store);
		expect(second.loop_warning?.detected).toBe(true);
		expect(second.loop_warning?.occurrences).toBe(5);
		// The cache entry itself stays clean.
		expect([...cache.values()][0].loop_warning).toBeUndefined();
	});
});
