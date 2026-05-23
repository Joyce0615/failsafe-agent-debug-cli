import type { ParsedError } from "../types/failure.js";

export type TestSelector = {
	framework: "pytest" | "jest" | "vitest" | "bun-test";
	command: string;
	test_file: string;
	test_name?: string;
	confidence: number;
};

/**
 * Derive the pytest runner prefix from the original command.
 * Preserves `python -m pytest` or `python3 -m pytest` if that's how it was invoked.
 */
function pytestRunner(originalCommand: string): string {
	const moduleMatch = originalCommand.match(/(python3?\s+-m\s+pytest)/);
	if (moduleMatch) return moduleMatch[1];
	return "pytest";
}

/**
 * Build a full pytest node ID: `file::test_name`.
 * If test_name already starts with the file path, return it as-is.
 */
function buildPytestNodeId(testFile: string, testName: string): string {
	if (testName.startsWith(testFile)) return testName;
	// test_name may be "TestClass::test_method" — always prepend file
	return `${testFile}::${testName}`;
}

export function extractPytestSelector(
	errors: ParsedError[],
	originalCommand: string,
): TestSelector | null {
	const runner = pytestRunner(originalCommand);

	// Look for test selectors from pytest FAILED markers
	for (const err of errors) {
		if (err.test_file && err.test_name) {
			const nodeId = buildPytestNodeId(err.test_file, err.test_name);
			return {
				framework: "pytest",
				command: `${runner} ${nodeId} -x`,
				test_file: err.test_file,
				test_name: err.test_name,
				confidence: 0.95,
			};
		}
	}

	// Fallback: look for test file from error locations
	for (const err of errors) {
		if (err.location?.file?.includes("test")) {
			return {
				framework: "pytest",
				command: `${runner} ${err.location.file} -x`,
				test_file: err.location.file,
				confidence: 0.6,
			};
		}
	}

	return null;
}

/**
 * Derive the Jest runner from the original command.
 * Preserves ./node_modules/.bin/jest, npx jest, etc.
 */
function jestRunner(originalCommand: string): string {
	const binMatch = originalCommand.match(/(\.\/node_modules\/\.bin\/jest)/);
	if (binMatch) return binMatch[1];
	if (originalCommand.includes("npx")) return "npx jest";
	return "jest";
}

export function extractJestSelector(
	errors: ParsedError[],
	originalCommand: string,
): TestSelector | null {
	const runner = jestRunner(originalCommand);

	for (const err of errors) {
		if (err.test_file && err.test_name) {
			const escapedName = err.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return {
				framework: "jest",
				command: `${runner} ${err.test_file} -t "${escapedName}" --no-coverage`,
				test_file: err.test_file,
				test_name: err.test_name,
				confidence: 0.9,
			};
		}
	}

	// Fallback: file-level
	for (const err of errors) {
		if (err.test_file) {
			return {
				framework: "jest",
				command: `${runner} ${err.test_file} --no-coverage`,
				test_file: err.test_file,
				confidence: 0.6,
			};
		}
	}

	return null;
}

export function extractVitestSelector(
	errors: ParsedError[],
	originalCommand: string,
): TestSelector | null {
	for (const err of errors) {
		if (err.test_file && err.test_name) {
			const escapedName = err.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const runner = originalCommand.includes("npx") ? "npx vitest" : "vitest";
			return {
				framework: "vitest",
				command: `${runner} run ${err.test_file} -t "${escapedName}"`,
				test_file: err.test_file,
				test_name: err.test_name,
				confidence: 0.9,
			};
		}
	}

	for (const err of errors) {
		if (err.test_file) {
			const runner = originalCommand.includes("npx") ? "npx vitest" : "vitest";
			return {
				framework: "vitest",
				command: `${runner} run ${err.test_file}`,
				test_file: err.test_file,
				confidence: 0.6,
			};
		}
	}

	return null;
}

export function extractBunTestSelector(
	errors: ParsedError[],
	originalCommand: string,
): TestSelector | null {
	for (const err of errors) {
		if (err.test_file && err.test_name) {
			const escapedName = err.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return {
				framework: "bun-test",
				command: `bun test ${err.test_file} -t "${escapedName}"`,
				test_file: err.test_file,
				test_name: err.test_name,
				confidence: 0.85,
			};
		}
	}

	for (const err of errors) {
		if (err.test_file) {
			return {
				framework: "bun-test",
				command: `bun test ${err.test_file}`,
				test_file: err.test_file,
				confidence: 0.6,
			};
		}
	}

	return null;
}

export function extractSelector(
	errors: ParsedError[],
	originalCommand: string,
	framework?: string,
): TestSelector | null {
	// If framework is explicitly specified, use that
	if (framework) {
		switch (framework) {
			case "pytest":
				return extractPytestSelector(errors, originalCommand);
			case "jest":
				return extractJestSelector(errors, originalCommand);
			case "vitest":
				return extractVitestSelector(errors, originalCommand);
			case "bun-test":
				return extractBunTestSelector(errors, originalCommand);
		}
	}

	// Auto-detect from command
	if (/pytest|python.*-m\s+pytest/.test(originalCommand)) {
		return extractPytestSelector(errors, originalCommand);
	}
	if (/jest/.test(originalCommand)) {
		return extractJestSelector(errors, originalCommand);
	}
	if (/vitest/.test(originalCommand)) {
		return extractVitestSelector(errors, originalCommand);
	}
	if (/bun\s+test/.test(originalCommand)) {
		return extractBunTestSelector(errors, originalCommand);
	}

	// Try all and pick highest confidence
	const candidates = [
		extractPytestSelector(errors, originalCommand),
		extractJestSelector(errors, originalCommand),
		extractVitestSelector(errors, originalCommand),
		extractBunTestSelector(errors, originalCommand),
	].filter((s): s is TestSelector => s !== null);

	candidates.sort((a, b) => b.confidence - a.confidence);
	return candidates[0] ?? null;
}
