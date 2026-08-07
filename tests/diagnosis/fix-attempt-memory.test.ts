/**
 * Reflexion-style fix-attempt memory (item 32).
 *
 * A `verify` that does not resolve the failure is a *disproven* fix. Those
 * episodes are persisted per signature and replayed into the next diagnosis, so
 * an agent is told "already tried, did not resolve: …" instead of rediscovering
 * the same dead end — and enough failed attempts trip the item-23 loop warning
 * even when the raw recurrence count has not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../../src/diagnosis/engine.js";
import type { FixAttempt, LearnedRule } from "../../src/rules/types.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { FailureRecord } from "../../src/types/failure.js";

type DiagnoseStore = Parameters<typeof diagnose>[1];

const ERRORS = [{ message: "widget subsystem returned status 7", error_type: "WidgetError" }];

function makeFailure(id = "fail_mem"): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: id,
		created_at: new Date().toISOString(),
		workspace: process.cwd(),
		command: "pytest tests/",
		cwd: process.cwd(),
		env_fingerprint: { os: "linux", arch: "x64", cwd: process.cwd() },
		status: "failed",
		exit_code: 1,
		duration_ms: 2,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed: [{ parser: "pytest", failure_type: "test_failure", errors: ERRORS }],
		primary_location: { file: "app/widget.py", line: 10, symbol: "frob" },
		related_locations: [],
		raw_artifacts: [],
	};
}

/** Store mock whose attempt memory is controllable. */
function makeStore(attempts: FixAttempt[], recurrence = 0) {
	const cache = new Map<string, FailureDiagnosis>();
	const store: DiagnoseStore = {
		findSimilarFailures: () => [],
		getRawOutput: () => "",
		getLearnedRuleByHash: () => null as LearnedRule | null,
		saveLearnedRule: () => {},
		updateLearnedRule: () => {},
		hasRecordedLearning: () => true,
		markLearningRecorded: () => {},
		getLatestSuccessfulFix: () => null,
		countUnresolvedAfterDate: () => recurrence,
		getFlakySignature: () => null,
		upsertFlakySignature: () => {},
		listFlakySignatures: () => [],
		getFixAttempts: (_hash, limit) => attempts.slice(0, limit ?? attempts.length),
		countFailedFixAttempts: () => attempts.filter((a) => a.outcome === "unresolved").length,
		getCachedDiagnosis: (key) => cache.get(key) ?? null,
		saveCachedDiagnosis: (key, diag) => {
			cache.set(key, diag);
		},
	};
	return { store, cache };
}

function attempt(summary: string, outcome: FixAttempt["outcome"] = "unresolved"): FixAttempt {
	return {
		signature_hash: "sig",
		failure_id: "fail_mem",
		attempted_at: "2026-08-06T00:00:00.000Z",
		summary,
		outcome,
		detail: "original_command still fails",
	};
}

describe("diagnose surfaces disproven fixes", () => {
	test("two failed attempts are listed in uncertainty", async () => {
		const { store } = makeStore([attempt("edited app/widget.py"), attempt("edited app/config.py")]);
		const diagnosis = await diagnose(makeFailure(), store);
		const tried = diagnosis.uncertainty.filter((u) => u.startsWith("Already tried"));
		expect(tried.length).toBe(2);
		expect(tried[0]).toContain("edited app/widget.py");
		expect(tried[0]).toContain("original_command still fails");
		expect(tried[1]).toContain("edited app/config.py");
	});

	test("resolved attempts are not reported as dead ends", async () => {
		const { store } = makeStore([attempt("edited app/widget.py", "resolved")]);
		const diagnosis = await diagnose(makeFailure(), store);
		expect(diagnosis.uncertainty.some((u) => u.startsWith("Already tried"))).toBe(false);
	});

	test("a long attempt history is summarized rather than dumped", async () => {
		const many = Array.from({ length: 7 }, (_, i) => attempt(`edited file_${i}.py`));
		const { store } = makeStore(many);
		const diagnosis = await diagnose(makeFailure(), store);
		const tried = diagnosis.uncertainty.filter((u) => u.startsWith("Already tried"));
		expect(tried.length).toBe(3);
		expect(diagnosis.uncertainty.some((u) => u.includes("4 further attempt(s)"))).toBe(true);
	});

	test("no memory means no change to uncertainty", async () => {
		const { store } = makeStore([]);
		const diagnosis = await diagnose(makeFailure(), store);
		expect(diagnosis.uncertainty.some((u) => u.startsWith("Already tried"))).toBe(false);
	});

	test("attempt notes are overlaid on a cache hit, never baked into the cache", async () => {
		const attempts: FixAttempt[] = [];
		const cache = new Map<string, FailureDiagnosis>();
		const store: DiagnoseStore = {
			...makeStore([]).store,
			getFixAttempts: () => attempts,
			countFailedFixAttempts: () => attempts.filter((a) => a.outcome === "unresolved").length,
			getCachedDiagnosis: (key) => cache.get(key) ?? null,
			saveCachedDiagnosis: (key, diag) => {
				cache.set(key, diag);
			},
		};

		const first = await diagnose(makeFailure("fail_a"), store);
		expect(first.uncertainty.some((u) => u.startsWith("Already tried"))).toBe(false);

		// A fix is tried between the two diagnoses and fails.
		attempts.push(attempt("edited app/widget.py"));
		const second = await diagnose(makeFailure("fail_b"), store);
		expect(second.uncertainty.some((u) => u.startsWith("Already tried"))).toBe(true);
		for (const cached of cache.values()) {
			expect(cached.uncertainty.some((u) => u.startsWith("Already tried"))).toBe(false);
		}
	});
});

describe("failed attempts feed the loop warning", () => {
	test("three failed attempts trip the warning even with no recurrence", async () => {
		const { store } = makeStore(
			[attempt("edit A"), attempt("edit B"), attempt("edit C")],
			0, // recurrence count below the threshold
		);
		const diagnosis = await diagnose(makeFailure(), store);
		expect(diagnosis.loop_warning).toBeDefined();
		expect(diagnosis.loop_warning!.failed_fix_attempts).toBe(3);
		expect(diagnosis.loop_warning!.reason).toContain("3 recorded fix attempt(s)");
		expect(diagnosis.loop_warning!.recommendation).toContain("failsafe debug fail_mem");
	});

	test("two failed attempts and no recurrence stay silent", async () => {
		const { store } = makeStore([attempt("edit A"), attempt("edit B")], 0);
		const diagnosis = await diagnose(makeFailure(), store);
		expect(diagnosis.loop_warning).toBeUndefined();
	});
});

describe("FixAttempt persistence", () => {
	let dir: string;
	let store: FailsafeStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "failsafe-attempts-"));
		store = new FailsafeStore(DEFAULT_CONFIG, dir);
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("attempts round-trip, newest first, with files_changed", () => {
		store.recordFixAttempt({
			signature_hash: "sig_1",
			failure_id: "fail_1",
			attempted_at: "2026-08-01T00:00:00.000Z",
			summary: "edited a.py",
			outcome: "unresolved",
			detail: "minimal repro still fails",
			files_changed: ["a.py"],
		});
		store.recordFixAttempt({
			signature_hash: "sig_1",
			failure_id: "fail_2",
			attempted_at: "2026-08-02T00:00:00.000Z",
			summary: "edited b.py",
			outcome: "resolved",
		});

		const attempts = store.getFixAttempts("sig_1");
		expect(attempts.length).toBe(2);
		expect(attempts[0].summary).toBe("edited b.py");
		expect(attempts[0].outcome).toBe("resolved");
		expect(attempts[1].files_changed).toEqual(["a.py"]);
		expect(store.countFailedFixAttempts("sig_1")).toBe(1);
		expect(store.getFixAttempts("sig_other")).toEqual([]);
	});

	test("re-verifying the same edit does not inflate the history", () => {
		const a: FixAttempt = {
			signature_hash: "sig_2",
			failure_id: "fail_1",
			attempted_at: "2026-08-01T00:00:00.000Z",
			summary: "edited a.py",
			outcome: "unresolved",
		};
		store.recordFixAttempt(a);
		store.recordFixAttempt({ ...a, attempted_at: "2026-08-01T00:05:00.000Z" });
		expect(store.getFixAttempts("sig_2").length).toBe(1);

		// A genuinely different edit IS a new attempt.
		store.recordFixAttempt({ ...a, summary: "edited b.py" });
		expect(store.getFixAttempts("sig_2").length).toBe(2);
		expect(store.countFailedFixAttempts("sig_2")).toBe(2);
	});

	test("the limit bounds how much history is loaded", () => {
		for (let i = 0; i < 8; i++) {
			store.recordFixAttempt({
				signature_hash: "sig_3",
				failure_id: `fail_${i}`,
				attempted_at: `2026-08-0${i + 1}T00:00:00.000Z`,
				summary: `edit ${i}`,
				outcome: "unresolved",
			});
		}
		expect(store.getFixAttempts("sig_3", 3).length).toBe(3);
		expect(store.countFailedFixAttempts("sig_3")).toBe(8);
	});
});
