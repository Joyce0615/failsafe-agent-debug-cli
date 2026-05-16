import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { detectAndParse, extractPrimaryLocation } from "../../src/parsers/index.js";

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;

describe("detectAndParse", () => {
	test("detects and parses pytest output", () => {
		const output = readFileSync(`${FIXTURES_DIR}/pytest-output-simple.txt`, "utf-8");
		const results = detectAndParse(output, "", "pytest");

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].parser).toBe("pytest");
	});

	test("detects and parses tsc output", () => {
		const output = readFileSync(`${FIXTURES_DIR}/tsc-output-errors.txt`, "utf-8");
		const results = detectAndParse(output, "", "tsc --noEmit");

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].parser).toBe("tsc");
	});

	test("returns empty array for unrecognized output", () => {
		const results = detectAndParse("everything is fine", "", "echo hello");
		expect(results.length).toBe(0);
	});
});

describe("extractPrimaryLocation", () => {
	test("extracts location from pytest output", () => {
		const output = readFileSync(`${FIXTURES_DIR}/pytest-output-simple.txt`, "utf-8");
		const results = detectAndParse(output, "", "pytest");
		const location = extractPrimaryLocation(results);

		expect(location).toBeDefined();
		expect(location!.file).toContain("auth");
	});

	test("extracts location from tsc output", () => {
		const output = readFileSync(`${FIXTURES_DIR}/tsc-output-errors.txt`, "utf-8");
		const results = detectAndParse(output, "", "tsc");
		const location = extractPrimaryLocation(results);

		expect(location).toBeDefined();
		expect(location!.file).toBe("src/auth.ts");
		expect(location!.line).toBe(42);
	});

	test("returns undefined for no results", () => {
		const location = extractPrimaryLocation([]);
		expect(location).toBeUndefined();
	});
});
