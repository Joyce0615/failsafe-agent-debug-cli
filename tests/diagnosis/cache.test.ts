import { describe, expect, test } from "bun:test";
import { declaredRulesFingerprint, diagnosisCacheKey } from "../../src/diagnosis/cache.js";
import { diagnose } from "../../src/diagnosis/engine.js";
import type { DeclaredRule, LearnedRule } from "../../src/rules/types.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { FailureRecord } from "../../src/types/failure.js";

// ─── Cache key construction + invalidation ──────────────────────────────────

function rule(id: string): DeclaredRule {
	return {
		id,
		pattern: { error_contains: "KeyError" },
		diagnosis: { category: "key_error", explanation: `Rule ${id}` },
		confidence: 0.9,
	} as DeclaredRule;
}

describe("diagnosisCacheKey", () => {
	test("embeds the schema version so a schema bump invalidates", () => {
		expect(diagnosisCacheKey("sighash", [])).toContain(SCHEMA_VERSION);
	});

	test("is stable for the same signature + rule set", () => {
		expect(diagnosisCacheKey("sighash", [rule("a")])).toBe(
			diagnosisCacheKey("sighash", [rule("a")]),
		);
	});

	test("changes when the declared rule set changes (rule invalidation)", () => {
		const before = diagnosisCacheKey("sighash", [rule("a")]);
		const after = diagnosisCacheKey("sighash", [rule("a"), rule("b")]);
		expect(after).not.toBe(before);
	});

	test("changes when the signature hash changes", () => {
		expect(diagnosisCacheKey("sig-1", [])).not.toBe(diagnosisCacheKey("sig-2", []));
	});

	test("empty rule set has a stable 'none' fingerprint", () => {
		expect(declaredRulesFingerprint([])).toBe("none");
	});
});

// ─── Engine integration: cache hit returns an identical packet ──────────────

type DiagnoseStore = Parameters<typeof diagnose>[1];

function makeCachingStore(opts: { flaky?: boolean } = {}): {
	store: DiagnoseStore;
	computeCounts: () => number;
	cacheSize: () => number;
} {
	const cache = new Map<string, FailureDiagnosis>();
	// getRawOutput is only reached on the full compute path (token budget), so it
	// is a faithful proxy for "did we re-run the expensive diagnosis?".
	let computeCalls = 0;
	const store: DiagnoseStore = {
		findSimilarFailures: () => [],
		getRawOutput: () => {
			computeCalls += 1;
			return "";
		},
		getLearnedRuleByHash: () => null as LearnedRule | null,
		saveLearnedRule: () => {},
		updateLearnedRule: () => {},
		hasRecordedLearning: () => true,
		markLearningRecorded: () => {},
		getLatestSuccessfulFix: () => (opts.flaky ? { resolved_at: "2026-01-01" } : null),
		countUnresolvedAfterDate: () => (opts.flaky ? 3 : 0),
		getFlakySignature: () => null,
		upsertFlakySignature: () => {},
		listFlakySignatures: () => [],
		getCachedDiagnosis: (key) => cache.get(key) ?? null,
		saveCachedDiagnosis: (key, diag) => {
			cache.set(key, diag);
		},
	};
	return { store, computeCounts: () => computeCalls, cacheSize: () => cache.size };
}

function makeFailure(): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: "fail_cache",
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

describe("diagnose cache integration", () => {
	test("a second diagnosis of the same signature is served from cache, identically", async () => {
		const { store, computeCounts, cacheSize } = makeCachingStore();

		const first = await diagnose(makeFailure(), store);
		expect(cacheSize()).toBe(1);
		const computeAfterFirst = computeCounts();
		expect(computeAfterFirst).toBeGreaterThan(0);

		const second = await diagnose(makeFailure(), store);
		// No additional compute-path work happened on the hit.
		expect(computeCounts()).toBe(computeAfterFirst);
		// The packet is identical (same failure_id here, so byte-for-byte equal).
		expect(second).toEqual(first);
	});

	test("re-stamps failure_id for a different failure sharing the signature", async () => {
		const { store } = makeCachingStore();

		const first = await diagnose(makeFailure(), store);
		const other = makeFailure();
		other.failure_id = "fail_other";
		const second = await diagnose(other, store);

		expect(second.failure_id).toBe("fail_other");
		// Diagnosis identity + content are otherwise reused from the cache.
		expect(second.diagnosis_id).toBe(first.diagnosis_id);
		expect(second.root_cause).toEqual(first.root_cause);
	});

	test("flaky signatures are never cached", async () => {
		const { store, cacheSize } = makeCachingStore({ flaky: true });
		const diag = await diagnose(makeFailure(), store);
		expect(diag.severity).toBe("flaky");
		expect(cacheSize()).toBe(0);
	});

	test("works without cache methods (optional store capability)", async () => {
		const { store } = makeCachingStore();
		const bare = { ...store };
		bare.getCachedDiagnosis = undefined;
		bare.saveCachedDiagnosis = undefined;
		const diag = await diagnose(makeFailure(), bare);
		expect(diag.root_cause).toBeDefined();
	});
});
