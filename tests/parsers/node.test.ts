import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { jestParser } from "../../src/parsers/node.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;

describe("jestParser", () => {
	test("detects Jest output", () => {
		const output = readFileSync(`${FIXTURES_DIR}/jest-output-simple.txt`, "utf-8");
		expect(jestParser.detect(output, "", "jest")).toBe(true);
	});

	test("parses Jest failures", () => {
		const output = readFileSync(`${FIXTURES_DIR}/jest-output-simple.txt`, "utf-8");
		const result = jestParser.parse(output, "", "jest");

		expect(result.parser).toBe("jest");
		expect(result.failure_type).toBe("test_failure");
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("parses Jest test summary", () => {
		const output = readFileSync(`${FIXTURES_DIR}/jest-output-simple.txt`, "utf-8");
		const result = jestParser.parse(output, "", "jest");

		expect(result.test_summary).toBeDefined();
		expect(result.test_summary!.failed).toBe(2);
		expect(result.test_summary!.passed).toBe(14);
		expect(result.test_summary!.total).toBe(16);
	});

	test("detects Jest from command name", () => {
		expect(jestParser.detect("", "", "npx jest")).toBe(true);
		expect(jestParser.detect("", "", "jest --watch")).toBe(true);
	});
});
