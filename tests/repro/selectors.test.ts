import { describe, expect, test } from "bun:test";
import {
	extractJestSelector,
	extractPytestSelector,
	extractSelector,
	extractVitestSelector,
} from "../../src/repro/selectors.js";
import type { ParsedError } from "../../src/types/failure.js";

describe("extractPytestSelector", () => {
	test("builds full node ID with file prefix for class-scoped test", () => {
		const errors: ParsedError[] = [
			{
				message: "KeyError",
				test_file: "tests/test_auth.py",
				test_name: "TestCreateUserFromOAuth::test_gitlab_login",
			},
		];
		const sel = extractPytestSelector(errors, "pytest tests/ -v");
		expect(sel).not.toBeNull();
		expect(sel!.command).toBe(
			"pytest tests/test_auth.py::TestCreateUserFromOAuth::test_gitlab_login -x",
		);
		expect(sel!.test_file).toBe("tests/test_auth.py");
	});

	test("builds full node ID for module-level test", () => {
		const errors: ParsedError[] = [
			{
				message: "AssertionError",
				test_file: "tests/test_calc.py",
				test_name: "test_divide_by_zero",
			},
		];
		const sel = extractPytestSelector(errors, "pytest");
		expect(sel).not.toBeNull();
		expect(sel!.command).toBe("pytest tests/test_calc.py::test_divide_by_zero -x");
	});

	test("does not double-prefix when test_name already includes file", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "tests/test_auth.py",
				test_name: "tests/test_auth.py::test_login",
			},
		];
		const sel = extractPytestSelector(errors, "pytest");
		expect(sel).not.toBeNull();
		expect(sel!.command).toBe("pytest tests/test_auth.py::test_login -x");
	});

	test("preserves python -m pytest runner", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "tests/test_auth.py",
				test_name: "test_login",
			},
		];
		const sel = extractPytestSelector(errors, "python -m pytest tests/ -v");
		expect(sel).not.toBeNull();
		expect(sel!.command).toStartWith("python -m pytest ");
	});

	test("preserves python3 -m pytest runner", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "tests/test_auth.py",
				test_name: "test_login",
			},
		];
		const sel = extractPytestSelector(errors, "python3 -m pytest tests/");
		expect(sel).not.toBeNull();
		expect(sel!.command).toStartWith("python3 -m pytest ");
	});

	test("falls back to file-level selector from location", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				location: { file: "tests/test_auth.py", line: 10 },
			},
		];
		const sel = extractPytestSelector(errors, "pytest");
		expect(sel).not.toBeNull();
		expect(sel!.command).toBe("pytest tests/test_auth.py -x");
		expect(sel!.confidence).toBe(0.6);
	});

	test("returns null when no test info available", () => {
		const errors: ParsedError[] = [{ message: "something broke" }];
		expect(extractPytestSelector(errors, "pytest")).toBeNull();
	});
});

describe("extractJestSelector", () => {
	test("builds selector with test name", () => {
		const errors: ParsedError[] = [
			{
				message: "TypeError",
				test_file: "src/auth.test.ts",
				test_name: "validateUser handles missing email",
			},
		];
		const sel = extractJestSelector(errors, "npx jest");
		expect(sel).not.toBeNull();
		expect(sel!.command).toContain("npx jest");
		expect(sel!.command).toContain("src/auth.test.ts");
		expect(sel!.command).toContain('-t "validateUser handles missing email"');
	});

	test("preserves ./node_modules/.bin/jest runner", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "auth.test.js",
				test_name: "some test",
			},
		];
		const sel = extractJestSelector(errors, "./node_modules/.bin/jest --config='{}'");
		expect(sel).not.toBeNull();
		expect(sel!.command).toStartWith("./node_modules/.bin/jest ");
	});

	test("escapes special regex characters in test name", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "test.js",
				test_name: "handles (special) chars [1]",
			},
		];
		const sel = extractJestSelector(errors, "jest");
		expect(sel).not.toBeNull();
		expect(sel!.command).toContain("handles \\(special\\) chars \\[1\\]");
	});

	test("falls back to file-level selector", () => {
		const errors: ParsedError[] = [{ message: "Error", test_file: "auth.test.ts" }];
		const sel = extractJestSelector(errors, "jest");
		expect(sel).not.toBeNull();
		expect(sel!.command).toBe("jest auth.test.ts --no-coverage");
		expect(sel!.confidence).toBe(0.6);
	});
});

describe("extractVitestSelector", () => {
	test("builds selector with nested test name", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "src/auth.test.ts",
				test_name: "Auth > validateUser > handles missing email",
			},
		];
		const sel = extractVitestSelector(errors, "vitest run");
		expect(sel).not.toBeNull();
		expect(sel!.command).toContain("vitest run");
		expect(sel!.command).toContain("src/auth.test.ts");
		expect(sel!.command).toContain("-t");
	});

	test("preserves npx vitest runner", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "test.ts",
				test_name: "some test",
			},
		];
		const sel = extractVitestSelector(errors, "npx vitest run tests/");
		expect(sel).not.toBeNull();
		expect(sel!.command).toStartWith("npx vitest ");
	});
});

describe("extractSelector (auto-detect)", () => {
	test("detects pytest from command", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "tests/test_auth.py",
				test_name: "test_login",
			},
		];
		const sel = extractSelector(errors, "pytest tests/ -v");
		expect(sel).not.toBeNull();
		expect(sel!.framework).toBe("pytest");
	});

	test("detects jest from command", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "auth.test.ts",
				test_name: "test name",
			},
		];
		const sel = extractSelector(errors, "npx jest");
		expect(sel).not.toBeNull();
		expect(sel!.framework).toBe("jest");
	});

	test("detects vitest from command", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "test.ts",
				test_name: "test name",
			},
		];
		const sel = extractSelector(errors, "vitest run");
		expect(sel).not.toBeNull();
		expect(sel!.framework).toBe("vitest");
	});

	test("detects bun test from command", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "test.ts",
				test_name: "test name",
			},
		];
		const sel = extractSelector(errors, "bun test tests/");
		expect(sel).not.toBeNull();
		expect(sel!.framework).toBe("bun-test");
	});

	test("explicit framework overrides auto-detect", () => {
		const errors: ParsedError[] = [
			{
				message: "Error",
				test_file: "test.ts",
				test_name: "test name",
			},
		];
		// Command looks like jest, but framework override says vitest
		const sel = extractSelector(errors, "npx jest", "vitest");
		expect(sel).not.toBeNull();
		expect(sel!.framework).toBe("vitest");
	});
});
