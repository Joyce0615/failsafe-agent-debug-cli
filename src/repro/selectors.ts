import type { ParsedError } from "../types/failure.js";

export type TestSelector = {
	framework: "pytest" | "jest" | "vitest" | "bun-test";
	command: string;
	test_file: string;
	test_name?: string;
	confidence: number;
};

export function extractPytestSelector(
	errors: ParsedError[],
	originalCommand: string,
): TestSelector | null {
	// Look for test selectors from pytest FAILED markers
	// Format: "FAILED tests/test_auth.py::TestAuth::test_missing_email"
	for (const err of errors) {
		if (err.test_file && err.test_name) {
			// Full pytest selector: file::class::method or file::function
			const selector = err.test_name.includes("::")
				? err.test_name
				: `${err.test_file}::${err.test_name}`;
			return {
				framework: "pytest",
				command: `pytest ${selector} -x`,
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
				command: `pytest ${err.location.file} -x`,
				test_file: err.location.file,
				confidence: 0.6,
			};
		}
	}

	return null;
}

export function extractJestSelector(
	errors: ParsedError[],
	originalCommand: string,
): TestSelector | null {
	for (const err of errors) {
		if (err.test_file && err.test_name) {
			const escapedName = err.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			// Determine runner from original command
			const runner = originalCommand.includes("npx") ? "npx jest" : "jest";
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
			const runner = originalCommand.includes("npx") ? "npx jest" : "jest";
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
