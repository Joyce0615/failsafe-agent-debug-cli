import { describe, expect, test } from "bun:test";
import {
	declaredRulesFingerprint,
	diagnosisCacheKey,
	learnedRuleFingerprint,
} from "../../src/diagnosis/cache.js";
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

function makeLearnedRule(overrides: Partial<LearnedRule> = {}): LearnedRule {
	return {
		rule_id: "learn_keyerror",
		signature_hash: "sighash",
		category: "key_error",
		explanation: "Learned: missing dict key",
		fix_summary: "Guard the key access",
		occurrence_count: 1,
		success_count: 0,
		distinct_files: 1,
		confidence: 0.9,
		lifecycle: "active",
		first_seen_at: "2026-01-01T00:00:00.000Z",
		last_seen_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
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

	test("a null learned rule keeps the key identical to the 2-arg form", () => {
		expect(learnedRuleFingerprint(null)).toBe("none");
		expect(diagnosisCacheKey("sighash", [], null)).toBe(diagnosisCacheKey("sighash", []));
	});

	test("changes when the learned-rule state changes (promotion invalidation)", () => {
		const noLearned = diagnosisCacheKey("sighash", []);
		const stale = diagnosisCacheKey(
			"sighash",
			[],
			makeLearnedRule({ lifecycle: "stale", confidence: 0.2, occurrence_count: 1 }),
		);
		const promoted = diagnosisCacheKey(
			"sighash",
			[],
			makeLearnedRule({
				lifecycle: "active",
				confidence: 0.95,
				occurrence_count: 10,
				success_count: 8,
			}),
		);
		// Appearance of a learned rule, and every promotion-relevant transition,
		// yields a distinct key.
		expect(stale).not.toBe(noLearned);
		expect(promoted).not.toBe(stale);
		expect(promoted).not.toBe(noLearned);
	});

	test("occurrence/success/confidence each move the learned fingerprint", () => {
		const base = learnedRuleFingerprint(makeLearnedRule());
		expect(learnedRuleFingerprint(makeLearnedRule({ occurrence_count: 5 }))).not.toBe(base);
		expect(learnedRuleFingerprint(makeLearnedRule({ success_count: 3 }))).not.toBe(base);
		expect(learnedRuleFingerprint(makeLearnedRule({ confidence: 0.99 }))).not.toBe(base);
		expect(learnedRuleFingerprint(makeLearnedRule({ lifecycle: "promoted" }))).not.toBe(base);
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

	test("promoting a learned rule invalidates the cache and recomputes a stronger diagnosis", async () => {
		// A mutable learned rule the store returns for the signature; it starts
		// absent so the builtin tier wins and is cached.
		let learned: LearnedRule | null = null;
		const cache = new Map<string, FailureDiagnosis>();
		let computeCalls = 0;
		const store: DiagnoseStore = {
			findSimilarFailures: () => [],
			getRawOutput: () => {
				computeCalls += 1;
				return "";
			},
			getLearnedRuleByHash: () => learned,
			saveLearnedRule: () => {},
			updateLearnedRule: () => {},
			hasRecordedLearning: () => true,
			markLearningRecorded: () => {},
			getLatestSuccessfulFix: () => null,
			countUnresolvedAfterDate: () => 0,
			getFlakySignature: () => null,
			upsertFlakySignature: () => {},
			listFlakySignatures: () => [],
			getCachedDiagnosis: (k) => cache.get(k) ?? null,
			saveCachedDiagnosis: (k, d) => {
				cache.set(k, d);
			},
		};

		// First diagnosis: no learned rule → builtin key_error template wins, cached.
		const first = await diagnose(makeFailure(), store);
		expect(first.rule_source).toBe("builtin");
		const computeAfterFirst = computeCalls;
		expect(computeAfterFirst).toBeGreaterThan(0);

		// A re-diagnosis with no state change is served from cache (no recompute).
		await diagnose(makeFailure(), store);
		expect(computeCalls).toBe(computeAfterFirst);

		// Promote a learned rule for the same signature (active, well-corroborated).
		learned = makeLearnedRule({
			lifecycle: "active",
			confidence: 0.95,
			occurrence_count: 10,
			success_count: 8,
		});

		// The learned fingerprint changed, so the stale cached (builtin) packet is
		// NOT served: the engine recomputes and the stronger learned rule wins.
		const promoted = await diagnose(makeFailure(), store);
		expect(computeCalls).toBeGreaterThan(computeAfterFirst);
		expect(promoted.rule_source).toBe("learned");
		expect(promoted.rule_id).toBe("learn_keyerror");
		expect(promoted.root_cause?.confidence).not.toBe(first.root_cause?.confidence);
	});
});
