import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { detectAndParse } from "../../src/parsers/index.js";
import { mochaParser } from "../../src/parsers/mocha.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;
const output = readFileSync(`${FIXTURES_DIR}/mocha-test-output.txt`, "utf-8");

describe("mochaParser", () => {
	test("detects mocha from command", () => {
		expect(mochaParser.detect("", "", "npx mocha")).toBe(true);
		expect(mochaParser.detect("", "", "mocha test/**/*.js")).toBe(true);
	});

	test("detects mocha from the passing/failing footer", () => {
		expect(mochaParser.detect(output, "", "")).toBe(true);
	});

	test("defers to jest/vitest summary shapes", () => {
		const jestish = "Tests:       1 failed, 2 passed, 3 total\n  3 passing\n  1 failing";
		expect(mochaParser.detect(jestish, "", "")).toBe(false);
		const vitestish = "Test Files  1 failed (1)\n  2 passing\n  1 failing";
		expect(mochaParser.detect(vitestish, "", "")).toBe(false);
	});

	test("does not detect unrelated output", () => {
		expect(mochaParser.detect("hello world", "", "echo hi")).toBe(false);
	});

	test("parses the failing test with location and assertion diff", () => {
		const result = mochaParser.parse(output, "", "mocha");
		expect(result.parser).toBe("mocha");
		expect(result.failure_type).toBe("test_failure");

		const fail = result.errors.find((e) => e.test_name?.includes("subtracts two numbers"));
		expect(fail).toBeDefined();
		expect(fail!.test_name).toBe("Math > subtracts two numbers");
		expect(fail!.error_type).toBe("AssertionError");
		expect(fail!.message).toContain("expected 1 to equal 2");
		expect(fail!.location?.file).toBe("test/math.test.js");
		expect(fail!.location?.line).toBe(14);
		expect(fail!.assertion_diff?.actual).toBe("1");
		expect(fail!.assertion_diff?.expected).toBe("2");
	});

	test("populates the test summary (passing/pending/failing)", () => {
		const result = mochaParser.parse(output, "", "mocha");
		expect(result.test_summary).toBeDefined();
		expect(result.test_summary!.passed).toBe(2);
		expect(result.test_summary!.failed).toBe(1);
		expect(result.test_summary!.skipped).toBe(1);
		expect(result.test_summary!.total).toBe(4);
	});
});

describe("framework-runner detection selects the right parser", () => {
	test("mocha output routes to the mocha parser with a summary", () => {
		const results = detectAndParse(output, "", "mocha");
		const mocha = results.find((r) => r.parser === "mocha");
		expect(mocha).toBeDefined();
		expect(mocha!.test_summary?.total).toBe(4);
	});

	test("cargo test output routes to the rust parser with a summary", () => {
		const cargo = readFileSync(`${FIXTURES_DIR}/cargo-test-output.txt`, "utf-8");
		const results = detectAndParse(cargo, "", "cargo test");
		const rust = results.find((r) => r.parser === "rust");
		expect(rust).toBeDefined();
		expect(rust!.test_summary).toBeDefined();
		expect(rust!.test_summary!.failed).toBeGreaterThan(0);
	});

	test("go test output routes to the go-test parser with a summary", () => {
		const go = readFileSync(`${FIXTURES_DIR}/go-test-output.txt`, "utf-8");
		const results = detectAndParse(go, "", "go test ./...");
		const goRes = results.find((r) => r.parser === "go-test");
		expect(goRes).toBeDefined();
		expect(goRes!.test_summary).toBeDefined();
		expect(goRes!.test_summary!.total).toBeGreaterThan(0);
	});
});
