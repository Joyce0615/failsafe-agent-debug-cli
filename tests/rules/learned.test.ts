import { describe, expect, test } from "bun:test";
import {
	type LearnedRuleStore,
	computeNormalizedSignatureHash,
	computeSignatureHash,
	normalizeMessage,
	normalizeToken,
	recordFailureForLearning,
} from "../../src/rules/learned.js";
import type { LearnedRule } from "../../src/rules/types.js";
import type { ParsedError } from "../../src/types/failure.js";

/** Minimal in-memory learned-rule store implementing the fuzzy fallback. */
function makeStore() {
	const rules = new Map<string, LearnedRule>();
	const recorded = new Set<string>();
	const store: LearnedRuleStore = {
		getLearnedRuleByHash: (h) => [...rules.values()].find((r) => r.signature_hash === h) ?? null,
		getLearnedRuleByNormalizedHash: (h) =>
			[...rules.values()]
				.filter((r) => r.normalized_hash === h)
				.sort((a, b) => b.occurrence_count - a.occurrence_count)[0] ?? null,
		saveLearnedRule: (r) => {
			rules.set(r.rule_id, r);
		},
		updateLearnedRule: (id, u) => {
			const r = rules.get(id);
			if (r) rules.set(id, { ...r, ...u });
		},
		hasRecordedLearning: (fid) => recorded.has(fid),
		markLearningRecorded: (fid) => {
			recorded.add(fid);
		},
	};
	return { store, rules };
}

describe("computeSignatureHash", () => {
	test("produces consistent hash for same errors", () => {
		const errors: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];
		const hash1 = computeSignatureHash(errors);
		const hash2 = computeSignatureHash(errors);
		expect(hash1).toBe(hash2);
	});

	test("produces 16-character hex hash", () => {
		const errors: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];
		const hash = computeSignatureHash(errors);
		expect(hash.length).toBe(16);
		expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
	});

	test("different error types produce different hashes", () => {
		const errorsA: ParsedError[] = [{ message: "KeyError", error_type: "KeyError" }];
		const errorsB: ParsedError[] = [{ message: "TypeError", error_type: "TypeError" }];
		expect(computeSignatureHash(errorsA)).not.toBe(computeSignatureHash(errorsB));
	});

	test("same error type with different messages produces same hash", () => {
		const errorsA: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];
		const errorsB: ParsedError[] = [{ message: "KeyError: 'user_id'", error_type: "KeyError" }];
		// Same error type, no stack frames — hashes should match since message is not part of hash
		expect(computeSignatureHash(errorsA)).toBe(computeSignatureHash(errorsB));
	});

	test("includes file in hash when available", () => {
		const errorsA: ParsedError[] = [
			{
				message: "KeyError",
				error_type: "KeyError",
				stack_frames: [{ file: "src/auth.py", line: 42, is_application: true }],
			},
		];
		const errorsB: ParsedError[] = [
			{
				message: "KeyError",
				error_type: "KeyError",
				stack_frames: [{ file: "src/user.py", line: 42, is_application: true }],
			},
		];
		expect(computeSignatureHash(errorsA)).not.toBe(computeSignatureHash(errorsB));
	});
});

describe("normalizeToken / normalizeMessage", () => {
	test("replaces numbers, quoted strings, hex, and UUIDs with placeholders", () => {
		expect(normalizeToken("host-12")).toBe("host-<NUM>");
		expect(normalizeToken("KeyError: 'user_42'")).toBe("KeyError: '<STR>'");
		expect(normalizeToken("addr 0xDEADBEEF")).toBe("addr <HEX>");
		expect(normalizeToken("id 550e8400-e29b-41d4-a716-446655440000")).toBe("id <UUID>");
	});

	test("collapses whitespace in message templates", () => {
		expect(normalizeMessage("failed   after 3000ms")).toBe("failed after <NUM>ms");
	});
});

describe("computeNormalizedSignatureHash", () => {
	test("coalesces test names differing only by a number", () => {
		const a: ParsedError[] = [
			{ message: "case 1 failed", error_type: "AssertionError", test_name: "test_case_1" },
		];
		const b: ParsedError[] = [
			{ message: "case 2 failed", error_type: "AssertionError", test_name: "test_case_2" },
		];
		// Exact hashes differ (test_name differs) but normalized hashes match.
		expect(computeSignatureHash(a)).not.toBe(computeSignatureHash(b));
		expect(computeNormalizedSignatureHash(a)).toBe(computeNormalizedSignatureHash(b));
	});

	test("keeps distinct error classes apart", () => {
		const a: ParsedError[] = [{ message: "boom 1", error_type: "KeyError" }];
		const b: ParsedError[] = [{ message: "boom 1", error_type: "TypeError" }];
		expect(computeNormalizedSignatureHash(a)).not.toBe(computeNormalizedSignatureHash(b));
	});
});

describe("recordFailureForLearning fuzzy grouping (item 26)", () => {
	test("two failures differing only by an embedded id coalesce to one rule (occurrence 2)", () => {
		const { store, rules } = makeStore();
		const errA: ParsedError[] = [
			{ message: "login failed for user 1", error_type: "AuthError", test_name: "test_login_1" },
		];
		const errB: ParsedError[] = [
			{ message: "login failed for user 2", error_type: "AuthError", test_name: "test_login_2" },
		];

		expect(recordFailureForLearning(store, computeSignatureHash(errA), "fail_a", errA)).toBe(true);
		expect(recordFailureForLearning(store, computeSignatureHash(errB), "fail_b", errB)).toBe(true);

		// One rule, grouped via the normalized fallback, occurrence_count == 2.
		expect(rules.size).toBe(1);
		const [rule] = [...rules.values()];
		expect(rule.occurrence_count).toBe(2);
		expect(rule.normalized_hash).toBeDefined();
	});

	test("genuinely different signatures stay separate", () => {
		const { store, rules } = makeStore();
		const keyErr: ParsedError[] = [{ message: "boom", error_type: "KeyError", test_name: "t_a" }];
		const typeErr: ParsedError[] = [{ message: "boom", error_type: "TypeError", test_name: "t_b" }];
		recordFailureForLearning(store, computeSignatureHash(keyErr), "fa", keyErr);
		recordFailureForLearning(store, computeSignatureHash(typeErr), "fb", typeErr);
		expect(rules.size).toBe(2);
	});
});
