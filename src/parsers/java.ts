import type { ParsedError, StackFrame, TestSummary } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

/** Library/framework package prefixes that are not "application" frames. */
const LIBRARY_PREFIXES = [
	"java.",
	"javax.",
	"jdk.",
	"sun.",
	"org.junit",
	"org.gradle",
	"org.apache.maven",
	"org.testng",
	"org.mockito",
	"org.springframework",
	"kotlin.",
	"scala.",
];

function isApplicationFrame(qualifiedMethod: string): boolean {
	return !LIBRARY_PREFIXES.some((p) => qualifiedMethod.startsWith(p));
}

/**
 * Parser for Java stack traces and JUnit / Maven / Gradle test output.
 *
 * Recognizes `Exception in thread "..."` and bare `pkg.ExceptionType: message`
 * headers, `at pkg.Class.method(File.java:NN)` frames (classifying application
 * vs library frames by package prefix), `Caused by:` chains, and
 * `Tests run: N, Failures: F, Errors: E, Skipped: S` summaries.
 */
export const javaParser: FailureParser = {
	name: "java",

	detect(stdout: string, stderr: string, command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		if (/\b(mvn|gradle|java|junit)\b/.test(command)) {
			// Only claim if there is Java-shaped output, to avoid false positives.
			if (/\bat \S+\(\S+\.java:\d+\)/.test(combined) || /Tests run:/.test(combined)) return true;
		}
		return (
			/\bat [\w$.]+\([\w$]+\.java:\d+\)/.test(combined) ||
			/^Exception in thread/m.test(combined) ||
			/Tests run: \d+, Failures: \d+/.test(combined)
		);
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;

		const errors: ParsedError[] = [];

		// Exception headers: optional "Exception in thread "x" " prefix, then
		// "pkg.ExceptionType: message".
		const headerRegex =
			/(?:Exception in thread "[^"]*" )?([\w$.]+(?:Exception|Error|Throwable))(?::\s*(.+))?\n((?:\s*at [\w$.<>]+\([^)]*\)\n?)+)/g;
		let hm: RegExpExecArray | null = headerRegex.exec(combined);
		while (hm !== null) {
			const errorType = hm[1];
			const message = hm[2]?.trim() ?? errorType;
			const framesBlock = hm[3] ?? "";
			const stackFrames = parseFrames(framesBlock);
			const appFrame = stackFrames.find((f) => f.is_application);
			errors.push({
				message,
				error_type: errorType,
				location: appFrame
					? { file: appFrame.file, line: appFrame.line, symbol: appFrame.function }
					: undefined,
				stack_frames: stackFrames.length > 0 ? stackFrames : undefined,
			});
			hm = headerRegex.exec(combined);
		}

		// Test summary: Tests run: 5, Failures: 1, Errors: 1, Skipped: 1
		let test_summary: TestSummary | undefined;
		const sm = combined.match(
			/Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?/,
		);
		if (sm) {
			const total = Number.parseInt(sm[1], 10);
			const failures = Number.parseInt(sm[2], 10);
			const errs = Number.parseInt(sm[3], 10);
			const skipped = sm[4] ? Number.parseInt(sm[4], 10) : 0;
			const failed = failures + errs;
			test_summary = {
				total,
				passed: Math.max(0, total - failed - skipped),
				failed,
				skipped,
				errored: errs,
			};
		}

		return {
			parser: "java",
			failure_type: "test_failure",
			errors,
			test_summary,
		};
	},
};

function parseFrames(block: string): StackFrame[] {
	const frames: StackFrame[] = [];
	const frameRegex = /at ([\w$.<>]+)\(([\w$]+\.java):(\d+)\)/g;
	let m: RegExpExecArray | null = frameRegex.exec(block);
	while (m !== null) {
		const qualified = m[1];
		const fnMatch = qualified.match(/^(.*)\.([\w$<>]+)$/);
		frames.push({
			file: m[2],
			line: Number.parseInt(m[3], 10),
			function: fnMatch ? `${fnMatch[1]}.${fnMatch[2]}` : qualified,
			is_application: isApplicationFrame(qualified),
		});
		m = frameRegex.exec(block);
	}
	return frames;
}
