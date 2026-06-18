import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { javaParser } from "../../src/parsers/java.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;

describe("javaParser", () => {
	const output = readFileSync(`${FIXTURES_DIR}/java-junit-output.txt`, "utf-8");

	test("detects from java stack frames", () => {
		expect(javaParser.detect(output, "", "")).toBe(true);
	});

	test("detects mvn command with java-shaped output", () => {
		expect(javaParser.detect(output, "", "mvn test")).toBe(true);
	});

	test("does not detect unrelated output", () => {
		expect(javaParser.detect("hello world", "", "echo hi")).toBe(false);
	});

	test("parses exceptions with type and message", () => {
		const result = javaParser.parse(output, "", "mvn test");
		expect(result.parser).toBe("java");
		const npe = result.errors.find((e) => e.error_type === "java.lang.NullPointerException");
		expect(npe).toBeDefined();
		expect(npe!.message).toContain("input");
	});

	test("resolves primary location to an application frame, not a library frame", () => {
		const result = javaParser.parse(output, "", "mvn test");
		const assertion = result.errors.find((e) => e.error_type === "java.lang.AssertionError");
		expect(assertion).toBeDefined();
		// The first frames are org.junit.* (library); the location must be the
		// first com.example.* application frame.
		expect(assertion!.location?.file).toBe("Calculator.java");
		expect(assertion!.location?.line).toBe(17);
		expect(assertion!.location?.symbol).toContain("com.example");
	});

	test("classifies library vs application frames", () => {
		const result = javaParser.parse(output, "", "mvn test");
		const assertion = result.errors.find((e) => e.error_type === "java.lang.AssertionError");
		const libFrame = assertion!.stack_frames!.find((f) => f.file === "Assert.java");
		const appFrame = assertion!.stack_frames!.find((f) => f.file === "Calculator.java");
		expect(libFrame!.is_application).toBe(false);
		expect(appFrame!.is_application).toBe(true);
	});

	test("parses JUnit test summary with errors", () => {
		const result = javaParser.parse(output, "", "mvn test");
		expect(result.test_summary).toBeDefined();
		expect(result.test_summary!.total).toBe(4);
		expect(result.test_summary!.failed).toBe(2); // failures + errors
		expect(result.test_summary!.skipped).toBe(1);
		expect(result.test_summary!.errored).toBe(1);
	});
});

describe("javaParser via registry", () => {
	test("detectAndParse selects java and resolves an application primary location", async () => {
		const { detectAndParse, extractPrimaryLocation } = await import("../../src/parsers/index.js");
		const output = readFileSync(`${FIXTURES_DIR}/java-junit-output.txt`, "utf-8");
		const results = detectAndParse(output, "", "mvn test");
		expect(results.some((r) => r.parser === "java")).toBe(true);
		const loc = extractPrimaryLocation(results);
		expect(loc?.file).toBe("Calculator.java");
	});
});
