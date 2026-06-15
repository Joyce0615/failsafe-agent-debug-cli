import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { goTestParser } from "../../src/parsers/go.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;

describe("goTestParser", () => {
	const output = readFileSync(`${FIXTURES_DIR}/go-test-output.txt`, "utf-8");

	test("detects go test from command", () => {
		expect(goTestParser.detect("", "", "go test ./...")).toBe(true);
	});

	test("detects go test from output markers", () => {
		expect(goTestParser.detect(output, "", "")).toBe(true);
	});

	test("does not detect unrelated output", () => {
		expect(goTestParser.detect("hello world", "", "echo hi")).toBe(false);
	});

	test("parses failing tests with locations", () => {
		const result = goTestParser.parse(output, "", "go test ./...");
		expect(result.parser).toBe("go-test");
		expect(result.failure_type).toBe("test_failure");

		const subtract = result.errors.find((e) => e.test_name === "TestSubtract");
		expect(subtract).toBeDefined();
		expect(subtract!.location).toBeDefined();
		expect(subtract!.location!.file).toBe("math_test.go");
		expect(subtract!.location!.line).toBe(24);
		expect(subtract!.message).toContain("want 2");
	});

	test("counts pass/fail/skip in the summary", () => {
		const result = goTestParser.parse(output, "", "go test ./...");
		expect(result.test_summary).toBeDefined();
		expect(result.test_summary!.failed).toBe(2);
		expect(result.test_summary!.passed).toBe(1);
		expect(result.test_summary!.skipped).toBe(1);
		expect(result.test_summary!.total).toBe(4);
	});

	test("parses a panic with stack frames", () => {
		const panicOutput = [
			"=== RUN   TestPanic",
			"panic: runtime error: index out of range [3] with length 3",
			"",
			"goroutine 6 [running]:",
			"example.TestPanic(0xc000102000)",
			"\t/home/user/app/slice_test.go:20 +0x1d",
			"testing.tRunner(0xc000102000, 0x5a1234)",
			"\t/usr/local/go/src/testing/testing.go:1576 +0x10b",
			"FAIL\texample/app\t0.005s",
		].join("\n");
		const result = goTestParser.parse(panicOutput, "", "go test");
		const panic = result.errors.find((e) => e.error_type === "panic");
		expect(panic).toBeDefined();
		expect(panic!.message).toContain("index out of range");
		expect(panic!.location?.file).toContain("slice_test.go");
		expect(panic!.location?.line).toBe(20);
	});
});

describe("goTestParser via registry", () => {
	test("detectAndParse picks up go output", async () => {
		const { detectAndParse, extractPrimaryLocation } = await import("../../src/parsers/index.js");
		const output = readFileSync(`${FIXTURES_DIR}/go-test-output.txt`, "utf-8");
		const results = detectAndParse(output, "", "go test ./...");
		expect(results.some((r) => r.parser === "go-test")).toBe(true);
		const loc = extractPrimaryLocation(results);
		expect(loc?.file).toBe("math_test.go");
	});
});
