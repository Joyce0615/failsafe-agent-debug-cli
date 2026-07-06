import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	detectAndParse,
	extractPrimaryLocation,
	extractRelatedLocations,
} from "../../src/parsers/index.js";

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

	test("normalizes Windows-style paths to POSIX in the emitted location", () => {
		// tsc on Windows emits backslash-separated paths; the primary location an
		// agent consumes must come back canonicalized to forward slashes.
		const winOutput = [
			"src\\auth.ts(42,17): error TS2345: Argument of type 'string | undefined' is not assignable.",
			"",
			"Found 1 error in 1 file.",
			"",
		].join("\n");
		const results = detectAndParse(winOutput, "", "tsc --noEmit");
		const location = extractPrimaryLocation(results);
		expect(location?.file).toBe("src/auth.ts");
		expect(location?.line).toBe(42);
	});
});

describe("multi-language (mixed) output", () => {
	const mixed = readFileSync(`${FIXTURES_DIR}/mixed-output.txt`, "utf-8");

	test("detectAndParse matches every language present", () => {
		const results = detectAndParse(mixed, "", "tsc --noEmit && pytest");
		const parsers = results.map((r) => r.parser);
		expect(parsers).toContain("tsc");
		expect(parsers).toContain("pytest");
	});

	test("primary location comes from the highest-precedence parser (pytest)", () => {
		const results = detectAndParse(mixed, "", "tsc --noEmit && pytest");
		expect(results[0].parser).toBe("pytest");
		const primary = extractPrimaryLocation(results);
		// pytest precedes tsc in ALL_PARSERS, so the primary is a Python location.
		expect(primary?.file.endsWith(".py")).toBe(true);
	});

	test("related locations surface the other language (tsc)", () => {
		const results = detectAndParse(mixed, "", "tsc --noEmit && pytest");
		const primary = extractPrimaryLocation(results);
		const related = extractRelatedLocations(results, primary);
		expect(related.some((l) => l.file === "src/auth.ts")).toBe(true);
		// The primary location is never duplicated into related.
		expect(related.every((l) => l.file !== primary?.file || l.line !== primary?.line)).toBe(true);
	});

	test("related locations are empty for single-language output", () => {
		const tsc = readFileSync(`${FIXTURES_DIR}/tsc-output-errors.txt`, "utf-8");
		const results = detectAndParse(tsc, "", "tsc --noEmit");
		expect(extractRelatedLocations(results)).toEqual([]);
	});
});
