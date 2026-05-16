import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { tscParser } from "../../src/parsers/typescript.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;

describe("tscParser", () => {
	test("detects tsc output", () => {
		const output = readFileSync(`${FIXTURES_DIR}/tsc-output-errors.txt`, "utf-8");
		expect(tscParser.detect(output, "", "tsc")).toBe(true);
	});

	test("parses tsc errors", () => {
		const output = readFileSync(`${FIXTURES_DIR}/tsc-output-errors.txt`, "utf-8");
		const result = tscParser.parse(output, "", "tsc --noEmit");

		expect(result.parser).toBe("tsc");
		expect(result.failure_type).toBe("type_error");
		expect(result.errors.length).toBe(3);

		const first = result.errors[0];
		expect(first.location).toBeDefined();
		expect(first.location!.file).toBe("src/auth.ts");
		expect(first.location!.line).toBe(42);
		expect(first.error_type).toBe("TS2345");
	});

	test("detects tsc from command", () => {
		expect(tscParser.detect("", "", "tsc --noEmit")).toBe(true);
		expect(tscParser.detect("", "", "npx tsc")).toBe(true);
	});
});
