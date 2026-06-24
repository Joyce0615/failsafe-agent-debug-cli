import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { detectAndParse } from "../../src/parsers/index.js";
import { rubyParser } from "../../src/parsers/ruby.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;
const rspec = readFileSync(`${FIXTURES_DIR}/rspec-output.txt`, "utf-8");
const exception = readFileSync(`${FIXTURES_DIR}/ruby-exception-output.txt`, "utf-8");

describe("rubyParser detection", () => {
	test("detects an uncaught exception backtrace", () => {
		expect(rubyParser.detect(exception, "", "ruby bin/main.rb")).toBe(true);
	});
	test("detects an rspec summary", () => {
		expect(rubyParser.detect(rspec, "", "rspec")).toBe(true);
	});
	test("does not detect unrelated output", () => {
		expect(rubyParser.detect("hello world", "", "echo hi")).toBe(false);
	});
});

describe("rubyParser: uncaught exceptions", () => {
	test("parses the exception class, message, and backtrace", () => {
		const result = rubyParser.parse(exception, "", "ruby bin/main.rb");
		expect(result.parser).toBe("ruby");
		expect(result.failure_type).toBe("runtime_exception");
		const err = result.errors[0];
		expect(err.error_type).toBe("ZeroDivisionError");
		expect(err.message).toBe("divided by 0");
		expect(err.location?.file).toBe("app/calculator.rb");
		expect(err.location?.line).toBe(7);
		expect(err.stack_frames?.length).toBe(3);
	});
});

describe("rubyParser: rspec", () => {
	test("parses the failing example, location, and diff", () => {
		const result = rubyParser.parse(rspec, "", "rspec");
		expect(result.failure_type).toBe("test_failure");
		const fail = result.errors.find((e) => e.test_name?.includes("divide"));
		expect(fail).toBeDefined();
		expect(fail!.error_type).toBe("RSpecFailure");
		expect(fail!.location?.file).toBe("./spec/calculator_spec.rb");
		expect(fail!.location?.line).toBe(14);
		expect(fail!.assertion_diff?.expected).toBe("3");
		expect(fail!.assertion_diff?.actual).toBe("2");
	});

	test("populates the test summary", () => {
		const result = rubyParser.parse(rspec, "", "rspec");
		expect(result.test_summary).toEqual({ total: 3, passed: 2, failed: 1, skipped: 0 });
	});
});

describe("rubyParser: minitest summary", () => {
	test("folds errors into failed and surfaces errored", () => {
		const out = "5 runs, 12 assertions, 1 failures, 2 errors, 1 skips";
		const result = rubyParser.parse(out, "", "rake test");
		expect(result.test_summary).toEqual({
			total: 5,
			passed: 1,
			failed: 3,
			skipped: 1,
			errored: 2,
		});
	});
});

describe("rubyParser via registry", () => {
	test("detectAndParse routes ruby output to the ruby parser", () => {
		const results = detectAndParse(rspec, "", "rspec");
		expect(results.some((r) => r.parser === "ruby")).toBe(true);
	});
});
