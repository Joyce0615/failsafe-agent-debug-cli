import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rustParser } from "../../src/parsers/rust.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;

describe("rustParser", () => {
	const output = readFileSync(`${FIXTURES_DIR}/cargo-test-output.txt`, "utf-8");

	test("detects cargo test from command", () => {
		expect(rustParser.detect("", "", "cargo test")).toBe(true);
	});

	test("detects from panic / test result markers", () => {
		expect(rustParser.detect(output, "", "")).toBe(true);
	});

	test("does not detect unrelated output", () => {
		expect(rustParser.detect("hello", "", "echo hi")).toBe(false);
	});

	test("parses panic locations", () => {
		const result = rustParser.parse(output, "", "cargo test");
		expect(result.parser).toBe("rust");
		expect(result.failure_type).toBe("test_failure");
		const panic = result.errors.find(
			(e) => e.location?.file === "src/math.rs" && e.location?.line === 42,
		);
		expect(panic).toBeDefined();
		expect(panic!.message).toContain("divide by zero");
		expect(panic!.error_type).toBe("panic");
	});

	test("parses the assertion panic", () => {
		const result = rustParser.parse(output, "", "cargo test");
		const assertion = result.errors.find((e) => e.location?.line === 58);
		expect(assertion).toBeDefined();
		expect(assertion!.message).toContain("assertion");
	});

	test("counts the test result summary", () => {
		const result = rustParser.parse(output, "", "cargo test");
		expect(result.test_summary).toBeDefined();
		expect(result.test_summary!.passed).toBe(1);
		expect(result.test_summary!.failed).toBe(2);
		expect(result.test_summary!.skipped).toBe(1);
		expect(result.test_summary!.total).toBe(4);
	});

	test("parses rustc compiler diagnostics as build errors", () => {
		const buildOutput = [
			"error[E0382]: borrow of moved value: `s`",
			"  --> src/main.rs:5:20",
			"   |",
			"5  |     let len = calculate_length(s);",
			"   |                                - value moved here",
			"",
			"error: aborting due to 1 previous error",
		].join("\n");
		const result = rustParser.parse(buildOutput, "", "cargo build");
		expect(result.failure_type).toBe("build_error");
		const err = result.errors.find((e) => e.error_type === "E0382");
		expect(err).toBeDefined();
		expect(err!.location?.file).toBe("src/main.rs");
		expect(err!.location?.line).toBe(5);
	});
});

describe("rustParser via registry", () => {
	test("detectAndParse selects rust and resolves primary location", async () => {
		const { detectAndParse, extractPrimaryLocation } = await import("../../src/parsers/index.js");
		const output = readFileSync(`${FIXTURES_DIR}/cargo-test-output.txt`, "utf-8");
		const results = detectAndParse(output, "", "cargo test");
		expect(results.some((r) => r.parser === "rust")).toBe(true);
		const loc = extractPrimaryLocation(results);
		expect(loc?.file).toBe("src/math.rs");
	});
});
