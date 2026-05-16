import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { pytestParser, pythonTracebackParser } from "../../src/parsers/python.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;

describe("pythonTracebackParser", () => {
	test("detects Python traceback", () => {
		const output = readFileSync(`${FIXTURES_DIR}/python-traceback-simple.txt`, "utf-8");
		expect(pythonTracebackParser.detect(output, "", "python script.py")).toBe(true);
	});

	test("parses simple traceback", () => {
		const output = readFileSync(`${FIXTURES_DIR}/python-traceback-simple.txt`, "utf-8");
		const result = pythonTracebackParser.parse(output, "", "python script.py");

		expect(result.parser).toBe("python-traceback");
		expect(result.failure_type).toBe("runtime_exception");
		expect(result.errors.length).toBeGreaterThan(0);

		const err = result.errors[0];
		expect(err.stack_frames).toBeDefined();
		expect(err.location).toBeDefined();
		expect(err.location!.file).toContain("auth.py");
		expect(err.stack_frames!.length).toBeGreaterThan(0);
	});

	test("does not detect non-traceback output", () => {
		expect(pythonTracebackParser.detect("hello world", "", "echo hi")).toBe(false);
	});
});

describe("pytestParser", () => {
	test("detects pytest output", () => {
		const output = readFileSync(`${FIXTURES_DIR}/pytest-output-simple.txt`, "utf-8");
		expect(pytestParser.detect(output, "", "pytest")).toBe(true);
	});

	test("parses pytest failures", () => {
		const output = readFileSync(`${FIXTURES_DIR}/pytest-output-simple.txt`, "utf-8");
		const result = pytestParser.parse(output, "", "pytest");

		expect(result.parser).toBe("pytest");
		expect(result.failure_type).toBe("test_failure");
		expect(result.errors.length).toBeGreaterThan(0);

		// Check the FAILED test was extracted
		const failedTest = result.errors.find(
			(e) => e.test_name?.includes("test_missing_email"),
		);
		expect(failedTest).toBeDefined();
		expect(failedTest!.message).toContain("KeyError");
	});

	test("parses test summary", () => {
		const output = readFileSync(`${FIXTURES_DIR}/pytest-output-simple.txt`, "utf-8");
		const result = pytestParser.parse(output, "", "pytest");

		expect(result.test_summary).toBeDefined();
		expect(result.test_summary!.failed).toBe(1);
		expect(result.test_summary!.passed).toBe(11);
	});

	test("detects pytest from command name", () => {
		expect(pytestParser.detect("", "", "pytest tests/")).toBe(true);
		expect(pytestParser.detect("", "", "python -m pytest")).toBe(true);
	});
});
