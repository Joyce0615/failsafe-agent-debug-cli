import { describe, expect, test } from "bun:test";
import { diagnose } from "../../src/diagnosis/engine.js";
import { type FlakyStore, checkFlaky, confirmFlakyByRerun } from "../../src/rules/flaky.js";
import type { FlakyRecord, LearnedRule } from "../../src/rules/types.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureRecord } from "../../src/types/failure.js";

// ─── checkFlaky threshold edge cases ─────────────────────────────────────────

function makeFlakyStore(opts: {
	latestFix?: { resolved_at: string } | null;
	unresolvedCount?: number;
	existing?: FlakyRecord | null;
}): { store: FlakyStore; upserts: FlakyRecord[] } {
	const upserts: FlakyRecord[] = [];
	const store: FlakyStore = {
		getLatestSuccessfulFix: () => opts.latestFix ?? null,
		countUnresolvedAfterDate: () => opts.unresolvedCount ?? 0,
		getFlakySignature: () => opts.existing ?? null,
		upsertFlakySignature: (r) => upserts.push(r),
		listFlakySignatures: () => upserts,
	};
	return { store, upserts };
}

describe("checkFlaky threshold semantics", () => {
	test("a signature with no prior fix can never be flaky", () => {
		const { store, upserts } = makeFlakyStore({ latestFix: null, unresolvedCount: 99 });
		expect(checkFlaky(store, "sig", 3)).toBe(false);
		expect(upserts).toHaveLength(0);
	});

	test("recurrences below the threshold are not flaky", () => {
		const { store } = makeFlakyStore({
			latestFix: { resolved_at: "2026-01-01" },
			unresolvedCount: 2,
		});
		expect(checkFlaky(store, "sig", 3)).toBe(false);
	});

	test("recurrences exactly at the threshold are flaky (boundary)", () => {
		const { store, upserts } = makeFlakyStore({
			latestFix: { resolved_at: "2026-01-01" },
			unresolvedCount: 3,
		});
		expect(checkFlaky(store, "sig", 3)).toBe(true);
		expect(upserts).toHaveLength(1);
		expect(upserts[0].failure_count_after_fix).toBe(3);
	});

	test("recurrences above the threshold are flaky", () => {
		const { store } = makeFlakyStore({
			latestFix: { resolved_at: "2026-01-01" },
			unresolvedCount: 5,
		});
		expect(checkFlaky(store, "sig", 3)).toBe(true);
	});

	test("preserves first_recurrence_at / marked_flaky_at from an existing record", () => {
		const existing: FlakyRecord = {
			signature_hash: "sig",
			failure_count_after_fix: 3,
			first_recurrence_at: "2026-02-02T00:00:00.000Z",
			last_recurrence_at: "2026-02-02T00:00:00.000Z",
			marked_flaky_at: "2026-02-02T00:00:00.000Z",
		};
		const { store, upserts } = makeFlakyStore({
			latestFix: { resolved_at: "2026-01-01" },
			unresolvedCount: 4,
			existing,
		});
		expect(checkFlaky(store, "sig", 3)).toBe(true);
		expect(upserts[0].first_recurrence_at).toBe(existing.first_recurrence_at);
		expect(upserts[0].marked_flaky_at).toBe(existing.marked_flaky_at);
		// last_recurrence_at and count are refreshed.
		expect(upserts[0].failure_count_after_fix).toBe(4);
		expect(upserts[0].last_recurrence_at).not.toBe(existing.last_recurrence_at);
	});
});

// ─── Rerun-based confirmation (item 33) ──────────────────────────────────────
//
// History alone only *infers* flakiness. Actually re-running the minimal repro
// N times and looking for a verdict change is the empirical definition
// (pytest-rerunfailures / CANNIER), and that evidence overrides the heuristic
// in BOTH directions.

/** A store whose flaky record is mutated by upserts, like the real one. */
function makeEvidenceStore(initial: FlakyRecord | null = null): {
	store: FlakyStore;
	current: () => FlakyRecord | null;
} {
	let record = initial;
	const store: FlakyStore = {
		getLatestSuccessfulFix: () => ({ resolved_at: "2026-01-01" }),
		countUnresolvedAfterDate: () => 99, // heuristic would scream "flaky"
		getFlakySignature: () => record,
		upsertFlakySignature: (r) => {
			record = r;
		},
		listFlakySignatures: () => (record ? [record] : []),
	};
	return { store, current: () => record };
}

describe("confirmFlakyByRerun", () => {
	test("alternating pass/fail across reruns confirms flakiness", async () => {
		const { store, current } = makeEvidenceStore();
		const result = await confirmFlakyByRerun(store, "sig", 4, async (attempt) => ({
			passed: attempt % 2 === 0,
		}));
		expect(result.verdict).toBe("flaky");
		expect(result.confirmed_flaky).toBe(true);
		expect(result.runs).toBe(4);
		expect(result.passed).toBe(2);
		expect(result.failed).toBe(2);
		expect(result.note).toContain("confirmed flaky");

		const record = current()!;
		expect(record.rerun_confirmed).toBe(true);
		expect(record.rerun_total).toBe(4);
		expect(record.marked_flaky_at).toBeDefined();
	});

	test("a consistently failing repro is refuted, not confirmed", async () => {
		const { store, current } = makeEvidenceStore();
		const result = await confirmFlakyByRerun(store, "sig", 5, async () => ({ passed: false }));
		expect(result.verdict).toBe("deterministic_failure");
		expect(result.confirmed_flaky).toBe(false);
		expect(result.failed).toBe(5);
		expect(result.note).toContain("NOT flaky");
		expect(current()!.rerun_confirmed).toBe(false);
	});

	test("a consistently passing repro records counts without asserting a verdict", async () => {
		const { store, current } = makeEvidenceStore();
		const result = await confirmFlakyByRerun(store, "sig", 3, async () => ({ passed: true }));
		expect(result.verdict).toBe("deterministic_pass");
		expect(result.confirmed_flaky).toBe(false);
		expect(result.note).toContain("no longer reproduces");
		// Ambiguous between "fix worked" and "flaky pass": no verdict stored.
		expect(current()!.rerun_confirmed).toBeUndefined();
		expect(current()!.rerun_passed).toBe(3);
	});

	test("runs is clamped to at least one execution", async () => {
		const { store } = makeEvidenceStore();
		let calls = 0;
		const result = await confirmFlakyByRerun(store, "sig", 0, async () => {
			calls++;
			return { passed: false };
		});
		expect(calls).toBe(1);
		expect(result.runs).toBe(1);
	});
});

describe("checkFlaky prefers rerun evidence over history", () => {
	const base = {
		signature_hash: "sig",
		failure_count_after_fix: 99,
		first_recurrence_at: "2026-01-01T00:00:00.000Z",
		last_recurrence_at: "2026-01-02T00:00:00.000Z",
	};

	test("a refuted signature is NOT flaky despite many recurrences", () => {
		const { store } = makeEvidenceStore({ ...base, rerun_confirmed: false, rerun_total: 5 });
		expect(checkFlaky(store, "sig", 3)).toBe(false);
	});

	test("a confirmed signature IS flaky even with no prior successful fix", () => {
		const store: FlakyStore = {
			getLatestSuccessfulFix: () => null, // heuristic would say "cannot be flaky"
			countUnresolvedAfterDate: () => 0,
			getFlakySignature: () => ({ ...base, rerun_confirmed: true, rerun_total: 4 }),
			upsertFlakySignature: () => {},
			listFlakySignatures: () => [],
		};
		expect(checkFlaky(store, "sig", 3)).toBe(true);
	});

	test("with no rerun evidence the history heuristic still applies", () => {
		const { store } = makeEvidenceStore({ ...base });
		expect(checkFlaky(store, "sig", 3)).toBe(true);
	});
});

// ─── Diagnosis integration: flaky downgrades confidence + severity + note ────

type DiagnoseStore = Parameters<typeof diagnose>[1];

function makeDiagnoseStore(flaky: boolean): DiagnoseStore {
	return {
		findSimilarFailures: () => [],
		getRawOutput: () => "",
		getLearnedRuleByHash: () => null as LearnedRule | null,
		saveLearnedRule: () => {},
		updateLearnedRule: () => {},
		hasRecordedLearning: () => true, // skip learning side-effects
		markLearningRecorded: () => {},
		getLatestSuccessfulFix: () => (flaky ? { resolved_at: "2026-01-01" } : null),
		countUnresolvedAfterDate: () => (flaky ? 3 : 0),
		getFlakySignature: () => null,
		upsertFlakySignature: () => {},
		listFlakySignatures: () => [],
	};
}

function makeKeyErrorFailure(): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: "fail_flaky",
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
		primary_location: undefined,
		related_locations: [],
		raw_artifacts: [],
	};
}

describe("diagnose flaky integration", () => {
	test("non-flaky baseline keeps a confident builtin root cause and normal severity", async () => {
		const diag = await diagnose(makeKeyErrorFailure(), makeDiagnoseStore(false));
		expect(diag.severity).not.toBe("flaky");
		expect(diag.root_cause).toBeDefined();
		// The builtin key_error template matched with a meaningful confidence.
		expect(diag.root_cause!.confidence).toBeGreaterThan(0.3);
	});

	test("flaky failure sets severity, caps confidence, and adds a rerun note", async () => {
		const diag = await diagnose(makeKeyErrorFailure(), makeDiagnoseStore(true));
		expect(diag.severity).toBe("flaky");
		expect(diag.root_cause).toBeDefined();
		// Confidence capped into the low band (<= 0.3 ceiling).
		expect(diag.root_cause!.confidence).toBeLessThanOrEqual(0.3);
		// First uncertainty note steers the agent to re-run before trusting it.
		expect(diag.uncertainty[0]).toContain("flaky");
		expect(diag.uncertainty[0].toLowerCase()).toContain("re-run");
	});
});
