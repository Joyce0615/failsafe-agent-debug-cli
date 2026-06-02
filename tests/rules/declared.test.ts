import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadDeclaredRules,
	matchDeclaredRules,
	matchesCriteria,
	validateDeclaredRules,
} from "../../src/rules/declared.js";
import type { DeclaredRule } from "../../src/rules/types.js";
import type { ParsedError } from "../../src/types/failure.js";

describe("loadDeclaredRules", () => {
	test("returns empty array for missing file", () => {
		const rules = loadDeclaredRules("/nonexistent/rules.yaml");
		expect(rules).toEqual([]);
	});

	test("loads valid YAML file", () => {
		const dir = join(tmpdir(), `failsafe-test-yaml-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "rules.yaml");
		writeFileSync(
			path,
			`
version: "1"
rules:
  - id: "test-rule-1"
    pattern:
      error_contains: "KeyError"
    diagnosis:
      category: "key_error"
      explanation: "Missing dictionary key"
      fix: "Add the key to the dict"
    confidence: 0.9
`,
		);
		const rules = loadDeclaredRules(path);
		expect(rules.length).toBe(1);
		expect(rules[0].id).toBe("test-rule-1");
		rmSync(dir, { recursive: true });
	});
});

describe("matchesCriteria", () => {
	const errors: ParsedError[] = [
		{
			message: "KeyError: 'email'",
			error_type: "KeyError",
			location: { file: "src/auth.py", line: 42 },
			test_file: "tests/test_auth.py",
		},
	];

	test("matches by error_type", () => {
		expect(matchesCriteria(errors, { error_type: "KeyError" })).toBe(true);
		expect(matchesCriteria(errors, { error_type: "ValueError" })).toBe(false);
	});

	test("matches by error_contains string", () => {
		expect(matchesCriteria(errors, { error_contains: "email" })).toBe(true);
		expect(matchesCriteria(errors, { error_contains: "password" })).toBe(false);
	});

	test("matches by error_contains array", () => {
		expect(matchesCriteria(errors, { error_contains: ["KeyError", "email"] })).toBe(true);
		expect(matchesCriteria(errors, { error_contains: ["KeyError", "password"] })).toBe(false);
	});

	test("matches by message_regex", () => {
		expect(matchesCriteria(errors, { message_regex: "KeyError.*email" })).toBe(true);
		expect(matchesCriteria(errors, { message_regex: "ValueError" })).toBe(false);
	});

	test("matches by file_matches", () => {
		expect(matchesCriteria(errors, { file_matches: ".*auth.*" })).toBe(true);
		expect(matchesCriteria(errors, { file_matches: ".*webhook.*" })).toBe(false);
	});

	test("AND logic: all criteria must match", () => {
		expect(
			matchesCriteria(errors, {
				error_type: "KeyError",
				error_contains: "email",
			}),
		).toBe(true);
		expect(
			matchesCriteria(errors, {
				error_type: "KeyError",
				error_contains: "password",
			}),
		).toBe(false);
	});

	test("empty criteria matches anything", () => {
		expect(matchesCriteria(errors, {})).toBe(true);
	});
});

describe("matchDeclaredRules", () => {
	const errors: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];

	test("returns first matching rule", () => {
		const rules: DeclaredRule[] = [
			{
				id: "rule-1",
				pattern: { error_type: "ValueError" },
				diagnosis: { category: "value_error", explanation: "Wrong value", enforcement: "suggest" },
				confidence: 0.9,
			},
			{
				id: "rule-2",
				pattern: { error_type: "KeyError" },
				diagnosis: { category: "key_error", explanation: "Missing key", enforcement: "suggest" },
				confidence: 0.95,
			},
		];
		const match = matchDeclaredRules(errors, rules);
		expect(match).not.toBeNull();
		expect(match!.rule_id).toBe("rule-2");
		expect(match!.rule_source).toBe("declared");
	});

	test("returns null when no rules match", () => {
		const rules: DeclaredRule[] = [
			{
				id: "rule-1",
				pattern: { error_type: "ValueError" },
				diagnosis: { category: "value_error", explanation: "Wrong", enforcement: "suggest" },
				confidence: 0.9,
			},
		];
		expect(matchDeclaredRules(errors, rules)).toBeNull();
	});
});

describe("validateDeclaredRules", () => {
	test("catches duplicate IDs", () => {
		const rules: DeclaredRule[] = [
			{
				id: "dup",
				pattern: {},
				diagnosis: { category: "a", explanation: "b", enforcement: "suggest" },
				confidence: 0.9,
			},
			{
				id: "dup",
				pattern: {},
				diagnosis: { category: "c", explanation: "d", enforcement: "suggest" },
				confidence: 0.9,
			},
		];
		const errors = validateDeclaredRules(rules);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("Duplicate");
	});

	test("catches invalid regex", () => {
		const rules: DeclaredRule[] = [
			{
				id: "bad-regex",
				pattern: { message_regex: "[invalid" },
				diagnosis: { category: "a", explanation: "b", enforcement: "suggest" },
				confidence: 0.9,
			},
		];
		const errors = validateDeclaredRules(rules);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("regex");
	});

	test("passes for valid rules", () => {
		const rules: DeclaredRule[] = [
			{
				id: "ok",
				pattern: { error_type: "KeyError" },
				diagnosis: { category: "a", explanation: "b", enforcement: "suggest" },
				confidence: 0.9,
			},
		];
		const errors = validateDeclaredRules(rules);
		expect(errors.length).toBe(0);
	});
});
