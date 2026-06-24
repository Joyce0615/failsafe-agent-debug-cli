import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cppParser } from "../../src/parsers/cpp.js";
import { detectAndParse, extractPrimaryLocation } from "../../src/parsers/index.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;
const gcc = readFileSync(`${FIXTURES_DIR}/gcc-output.txt`, "utf-8");

describe("cppParser detection", () => {
	test("detects gcc diagnostics", () => {
		expect(cppParser.detect(gcc, "", "make")).toBe(true);
	});
	test("detects from a g++ command with a warning only", () => {
		const warnOnly = "main.cpp:3:1: warning: unused variable 'x' [-Wunused-variable]";
		expect(cppParser.detect(warnOnly, "", "g++ main.cpp")).toBe(true);
	});
	test("does not detect unrelated output", () => {
		expect(cppParser.detect("hello world", "", "echo hi")).toBe(false);
	});
});

describe("cppParser parsing", () => {
	test("captures the compile error with file/line/column", () => {
		const result = cppParser.parse(gcc, "", "make");
		expect(result.parser).toBe("cpp");
		expect(result.failure_type).toBe("build_error");
		const compile = result.errors.find((e) => e.error_type === "CompileError");
		expect(compile).toBeDefined();
		expect(compile!.message).toContain("'foo' was not declared");
		expect(compile!.location).toEqual({ file: "src/main.cpp", line: 10, column: 5 });
	});

	test("does not surface warnings as errors", () => {
		const result = cppParser.parse(gcc, "", "make");
		expect(result.errors.every((e) => !/control reaches end/.test(e.message))).toBe(true);
	});

	test("captures the linker undefined-reference error", () => {
		const result = cppParser.parse(gcc, "", "make");
		const link = result.errors.find((e) => e.error_type === "LinkError");
		expect(link).toBeDefined();
		expect(link!.message).toContain("bar()");
	});
});

describe("cppParser via registry", () => {
	test("detectAndParse routes gcc output and extracts the primary location", () => {
		const results = detectAndParse(gcc, "", "make");
		expect(results.some((r) => r.parser === "cpp")).toBe(true);
		const loc = extractPrimaryLocation(results);
		expect(loc?.file).toBe("src/main.cpp");
		expect(loc?.line).toBe(10);
	});
});
