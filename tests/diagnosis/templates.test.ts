import { describe, test, expect } from "bun:test";
import { TEMPLATES } from "../../src/diagnosis/templates.js";
import type { ParsedError } from "../../src/types/failure.js";

describe("diagnosis templates", () => {
	test("matches null_reference for TypeError", () => {
		const errors: ParsedError[] = [
			{ message: "TypeError: Cannot read properties of undefined (reading 'toLowerCase')" },
		];
		const template = TEMPLATES.find((t) => t.match(errors));
		expect(template).toBeDefined();
		expect(template!.category).toBe("null_reference");
	});

	test("matches key_error for KeyError", () => {
		const errors: ParsedError[] = [
			{ message: "KeyError: 'email'", error_type: "KeyError" },
		];
		const template = TEMPLATES.find((t) => t.match(errors));
		expect(template).toBeDefined();
		expect(template!.category).toBe("key_error");
	});

	test("matches import_error for ModuleNotFoundError", () => {
		const errors: ParsedError[] = [
			{ message: "ModuleNotFoundError: No module named 'flask'" },
		];
		const template = TEMPLATES.find((t) => t.match(errors));
		expect(template).toBeDefined();
		expect(template!.category).toBe("import_error");
	});

	test("matches assertion_mismatch", () => {
		const errors: ParsedError[] = [
			{
				message: "AssertionError: expected 200 but got 401",
				assertion_diff: { expected: "200", actual: "401" },
			},
		];
		const template = TEMPLATES.find((t) => t.match(errors));
		expect(template).toBeDefined();
		expect(template!.category).toBe("assertion_mismatch");
	});

	test("matches type_error for TS codes", () => {
		const errors: ParsedError[] = [
			{ message: "Type 'string' is not assignable", error_type: "TS2322" },
		];
		const template = TEMPLATES.find((t) => t.match(errors));
		expect(template).toBeDefined();
		expect(template!.category).toBe("type_error");
	});

	test("matches syntax_error", () => {
		const errors: ParsedError[] = [
			{ message: "SyntaxError: Unexpected token", error_type: "SyntaxError" },
		];
		const template = TEMPLATES.find((t) => t.match(errors));
		expect(template).toBeDefined();
		expect(template!.category).toBe("syntax_error");
	});

	test("diagnosis includes evidence", () => {
		const errors: ParsedError[] = [
			{ message: "KeyError: 'email'", error_type: "KeyError", location: { file: "src/auth.py", line: 42 } },
		];
		const template = TEMPLATES.find((t) => t.match(errors))!;
		const result = template.diagnose(errors, []);
		expect(result.evidence.length).toBeGreaterThan(0);
		expect(result.confidence).toBeGreaterThan(0);
		expect(result.summary).toContain("email");
	});
});
