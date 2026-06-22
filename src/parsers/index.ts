import type { SourceLocation } from "../types/common.js";
import { goTestParser } from "./go.js";
import { javaParser } from "./java.js";
import { biomeParser, eslintParser } from "./linter.js";
import { mochaParser } from "./mocha.js";
import { jestParser, jsStackParser, vitestParser } from "./node.js";
import { pytestParser, pythonTracebackParser } from "./python.js";
import { rustParser } from "./rust.js";
import type { FailureParser, ParserResult } from "./types.js";
import { tscParser } from "./typescript.js";

/**
 * All registered parsers in priority order.
 * More specific parsers (pytest, jest, vitest, tsc, eslint, biome) come before
 * generic ones (pythonTracebackParser, jsStackParser) so that when multiple
 * parsers match, the specific ones produce the most useful results first.
 */
const ALL_PARSERS: FailureParser[] = [
	pytestParser,
	jestParser,
	vitestParser,
	mochaParser,
	tscParser,
	eslintParser,
	biomeParser,
	goTestParser,
	rustParser,
	javaParser,
	pythonTracebackParser,
	jsStackParser,
];

/**
 * Run detection on all parsers and parse with every matching one.
 * Returns an array of ParserResult from all parsers that matched.
 * The array may be empty if no parser detected the output format.
 */
export function detectAndParse(stdout: string, stderr: string, command: string): ParserResult[] {
	const results: ParserResult[] = [];

	for (const parser of ALL_PARSERS) {
		try {
			if (parser.detect(stdout, stderr, command)) {
				const result = parser.parse(stdout, stderr, command);
				// Only include results that actually found errors
				if (result.errors.length > 0 || result.test_summary) {
					results.push(result);
				}
			}
		} catch {}
	}

	return results;
}

/**
 * Extract the primary source location from parser results.
 * Uses the first error's location from the first parser result,
 * or falls back to the first application stack frame.
 */
export function extractPrimaryLocation(results: ParserResult[]): SourceLocation | undefined {
	for (const result of results) {
		for (const error of result.errors) {
			// Prefer the explicit location field
			if (error.location) {
				return error.location;
			}

			// Fall back to the first application stack frame
			if (error.stack_frames) {
				const appFrame = error.stack_frames.find((f) => f.is_application);
				if (appFrame) {
					return {
						file: appFrame.file,
						line: appFrame.line,
						column: appFrame.column,
						symbol: appFrame.function,
					};
				}
			}
		}
	}

	return undefined;
}

export { ALL_PARSERS };
export type { FailureParser, ParserResult } from "./types.js";
