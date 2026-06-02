import { describe, expect, test } from "bun:test";
import { boostConfidence, recordFailureForLearning } from "../../src/rules/learned.js";
import type { FixOutcome, LearnedRule } from "../../src/rules/types.js";
import type { ParsedError } from "../../src/types/failure.js";

/** Minimal in-memory store implementing the LearnedRuleStore interface. */
function makeStore() {
	const rules = new Map<string, LearnedRule>(); // keyed by signature_hash
	const ledger = new Set<string>(); // failure_ids already counted

	return {
		rules,
		ledger,
		getLearnedRuleByHash(hash: string): LearnedRule | null {
			return rules.get(hash) ?? null;
		},
		saveLearnedRule(rule: LearnedRule): void {
			rules.set(rule.signature_hash, rule);
		},
		updateLearnedRule(ruleId: string, updates: Partial<LearnedRule>): void {
			for (const [hash, rule] of rules) {
				if (rule.rule_id === ruleId) {
					rules.set(hash, { ...rule, ...updates });
					return;
				}
			}
		},
		hasRecordedLearning(failureId: string): boolean {
			return ledger.has(failureId);
		},
		markLearningRecorded(failureId: string): void {
			ledger.add(failureId);
		},
	};
}

const errors: ParsedError[] = [
	{ message: "KeyError: 'x'", error_type: "KeyError", location: { file: "src/a.py", line: 5 } },
];

describe("recordFailureForLearning idempotency", () => {
	test("first occurrence creates a rule with count 1", () => {
		const store = makeStore();
		const recorded = recordFailureForLearning(store, "hash1", "fail_1", errors);
		expect(recorded).toBe(true);
		const rule = store.getLearnedRuleByHash("hash1");
		expect(rule!.occurrence_count).toBe(1);
	});

	test("re-diagnosing the same failure_id does NOT inflate count", () => {
		const store = makeStore();
		recordFailureForLearning(store, "hash1", "fail_1", errors);
		// Same failure_id diagnosed again
		const recorded2 = recordFailureForLearning(store, "hash1", "fail_1", errors);
		expect(recorded2).toBe(false);
		const rule = store.getLearnedRuleByHash("hash1");
		expect(rule!.occurrence_count).toBe(1); // still 1
	});

	test("distinct failure_ids with same hash increment count", () => {
		const store = makeStore();
		recordFailureForLearning(store, "hash1", "fail_1", errors);
		recordFailureForLearning(store, "hash1", "fail_2", errors);
		recordFailureForLearning(store, "hash1", "fail_3", errors);
		const rule = store.getLearnedRuleByHash("hash1");
		expect(rule!.occurrence_count).toBe(3);
	});

	test("repeated re-diagnosis across many calls stays stable", () => {
		const store = makeStore();
		for (let i = 0; i < 10; i++) {
			recordFailureForLearning(store, "hash1", "fail_same", errors);
		}
		const rule = store.getLearnedRuleByHash("hash1");
		expect(rule!.occurrence_count).toBe(1);
	});
});

describe("boostConfidence after fixes", () => {
	test("success boosts confidence and count", () => {
		const store = makeStore();
		recordFailureForLearning(store, "hash1", "fail_1", errors);
		recordFailureForLearning(store, "hash1", "fail_2", errors);

		const outcome: FixOutcome = {
			failure_id: "fail_1",
			signature_hash: "hash1",
			resolved_at: new Date().toISOString(),
			success: true,
			fix_summary: "added guard",
		};
		boostConfidence(store, "hash1", outcome);

		const rule = store.getLearnedRuleByHash("hash1");
		expect(rule!.success_count).toBe(1);
		expect(rule!.confidence).toBeGreaterThan(0);
		expect(rule!.fix_summary).toBe("added guard");
	});
});
