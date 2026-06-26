import type { SourceLocation } from "../types/common.js";
import { cppParser } from "./cpp.js";
import { goTestParser } from "./go.js";
import { javaParser } from "./java.js";
import { biomeParser, eslintParser } from "./linter.js";
import { mochaParser } from "./mocha.js";
import { jestParser, jsStackParser, vitestParser } from "./node.js";
import { pytestParser, pythonTracebackParser } from "./python.js";
import { rubyParser } from "./ruby.js";
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
	rubyParser,
	cppParser,
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
 * Find the first usable source location within a single parser result,
 * preferring an explicit `location` and falling back to the first application
 * stack frame.
 */
function locationFromResult(result: ParserResult): SourceLocation | undefined {
	for (const error of result.errors) {
		if (error.location) {
			return error.location;
		}
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
	return undefined;
}

function sameLocation(a: SourceLocation, b: SourceLocation): boolean {
	return a.file === b.file && a.line === b.line && a.column === b.column;
}

/**
 * Extract the primary source location from parser results.
 *
 * `detectAndParse` returns results in `ALL_PARSERS` precedence (most specific
 * parser first), so the primary location is the first usable location from the
 * highest-precedence parser that matched. For genuinely mixed-language output
 * (e.g. a monorepo command emitting both a tsc error and a pytest failure) this
 * is the clearly-ranked primary; the other languages are surfaced via
 * {@link extractRelatedLocations}.
 */
export function extractPrimaryLocation(results: ParserResult[]): SourceLocation | undefined {
	for (const result of results) {
		const loc = locationFromResult(result);
		if (loc) {
			return loc;
		}
	}
	return undefined;
}

/**
 * Collect one representative location per *additional* parser result beyond the
 * one that produced the primary location. This surfaces every language present
 * in mixed output. Locations duplicating the primary or an already-collected
 * related location are skipped so the list stays compact.
 */
export function extractRelatedLocations(
	results: ParserResult[],
	primary?: SourceLocation,
): SourceLocation[] {
	const primaryLoc = primary ?? extractPrimaryLocation(results);
	const related: SourceLocation[] = [];
	for (const result of results) {
		const loc = locationFromResult(result);
		if (!loc) continue;
		if (primaryLoc && sameLocation(loc, primaryLoc)) continue;
		if (related.some((r) => sameLocation(r, loc))) continue;
		related.push(loc);
	}
	return related;
}

export { ALL_PARSERS };
export type { FailureParser, ParserResult } from "./types.js";
