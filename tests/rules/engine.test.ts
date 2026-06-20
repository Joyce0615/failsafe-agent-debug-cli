import { describe, expect, test } from "bun:test";
import { evaluateRules } from "../../src/rules/engine.js";
import type { DeclaredRule, LearnedRule } from "../../src/rules/types.js";
import type { ParsedError } from "../../src/types/failure.js";

function makeLearnedRule(overrides?: Partial<LearnedRule>): LearnedRule {
	return {
		rule_id: "lrule_test",
		signature_hash: "abc123",
		category: "key_error",
		explanation: "Learned: missing key",
		occurrence_count: 10,
		success_count: 8,
		distinct_files: 3,
		confidence: 0.8,
		lifecycle: "active",
		first_seen_at: "2026-01-01",
		last_seen_at: "2026-05-01",
		...overrides,
	};
}

const errors: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];

describe("evaluateRules", () => {
	test("declared rule takes priority over learned rule", () => {
		const declared: DeclaredRule[] = [
			{
				id: "team-rule",
				pattern: { error_type: "KeyError" },
				diagnosis: {
					category: "team_key_error",
					explanation: "Team knows this",
					enforcement: "suggest",
				},
				confidence: 0.95,
			},
		];
		const store = {
			getLearnedRuleByHash: () => makeLearnedRule(),
		};

		const result = evaluateRules(errors, [], "abc123", store, declared);
		expect(result).not.toBeNull();
		expect(result!.rule_source).toBe("declared");
		expect(result!.rule_id).toBe("team-rule");
	});

	test("learned rule takes priority over builtin", () => {
		const store = {
			getLearnedRuleByHash: () => makeLearnedRule(),
		};

		const result = evaluateRules(errors, [], "abc123", store, []);
		expect(result).not.toBeNull();
		expect(result!.rule_source).toBe("learned");
	});

	test("builtin matches when no declared or learned rules", () => {
		const store = {
			getLearnedRuleByHash: () => null,
		};

		const result = evaluateRules(errors, [], "xyz", store, []);
		expect(result).not.toBeNull();
		expect(result!.rule_source).toBe("builtin");
		expect(result!.category).toBe("key_error");
	});

	test("skips learned rule with low confidence", () => {
		const store = {
			getLearnedRuleByHash: () => makeLearnedRule({ confidence: 0.3 }),
		};

		const result = evaluateRules(errors, [], "abc123", store, []);
		// Should fall through to builtin
		expect(result).not.toBeNull();
		expect(result!.rule_source).toBe("builtin");
	});

	test("skips disabled learned rule", () => {
		const store = {
			getLearnedRuleByHash: () => makeLearnedRule({ lifecycle: "disabled" }),
		};

		const result = evaluateRules(errors, [], "abc123", store, []);
		expect(result!.rule_source).toBe("builtin");
	});

	test("returns null for unrecognized errors", () => {
		const unknownErrors: ParsedError[] = [{ message: "Something completely unknown happened" }];
		const store = { getLearnedRuleByHash: () => null };

		const result = evaluateRules(unknownErrors, [], "xyz", store, []);
		expect(result).toBeNull();
	});
});

describe("evaluateRules conflict awareness", () => {
	const declared: DeclaredRule[] = [
		{
			id: "team-rule",
			pattern: { error_type: "KeyError" },
			diagnosis: { category: "team_key_error", explanation: "Team rule", enforcement: "suggest" },
			confidence: 0.95,
		},
	];

	test("declared winner records learned + builtin as shadowed", () => {
		const store = { getLearnedRuleByHash: () => makeLearnedRule() };
		const result = evaluateRules(errors, [], "abc123", store, declared);
		expect(result!.rule_source).toBe("declared");
		expect(result!.shadowed_matches).toBeDefined();
		const sources = result!.shadowed_matches!.map((s) => s.rule_source).sort();
		// Both the learned rule and the builtin key_error template also matched.
		expect(sources).toContain("learned");
		expect(sources).toContain("builtin");
	});

	test("learned winner records builtin as shadowed", () => {
		const store = { getLearnedRuleByHash: () => makeLearnedRule() };
		const result = evaluateRules(errors, [], "abc123", store, []);
		expect(result!.rule_source).toBe("learned");
		expect(result!.shadowed_matches).toBeDefined();
		expect(result!.shadowed_matches!.some((s) => s.rule_source === "builtin")).toBe(true);
	});

	test("builtin winner has no shadowed matches", () => {
		const store = { getLearnedRuleByHash: () => null };
		const result = evaluateRules(errors, [], "xyz", store, []);
		expect(result!.rule_source).toBe("builtin");
		expect(result!.shadowed_matches).toBeUndefined();
	});

	test("declared winner with no lower matches has no shadowed list", () => {
		const store = { getLearnedRuleByHash: () => null };
		const unknownErrors: ParsedError[] = [{ message: "totally novel thing" }];
		const onlyDeclared: DeclaredRule[] = [
			{
				id: "catch-all",
				pattern: { error_contains: "novel" },
				diagnosis: { category: "custom", explanation: "x", enforcement: "suggest" },
				confidence: 0.9,
			},
		];
		const result = evaluateRules(unknownErrors, [], "zzz", store, onlyDeclared);
		expect(result!.rule_source).toBe("declared");
		expect(result!.shadowed_matches).toBeUndefined();
	});
});
