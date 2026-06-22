import type { SourceLocation } from "../types/common.js";
import type { AssertionDiff, ParsedError, StackFrame, TestSummary } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

/**
 * Parser for Mocha test-runner output (the default `spec` reporter).
 *
 * Mocha prints a footer summary (`N passing`, `N failing`, `N pending`) and,
 * for each failure, a numbered block:
 *
 *   1) Suite name
 *        test name:
 *
 *      AssertionError: expected 1 to equal 2
 *      + expected - actual
 *      -1
 *      +2
 *        at Context.<anonymous> (test/math.test.js:14:23)
 *
 * This is distinct from Jest/Vitest (which use `Tests:` / `Test Files` summary
 * lines and `●`/`FAIL file >` markers), so detection keys on the Mocha-specific
 * `N passing`/`N failing` footer or an explicit `mocha` command.
 */

function isApplicationJsFrame(filePath: string): boolean {
	return (
		!filePath.includes("node_modules") &&
		!filePath.includes("node:internal") &&
		!filePath.startsWith("node:") &&
		!filePath.includes("<anonymous>")
	);
}

function parseFrames(text: string): StackFrame[] {
	const frames: StackFrame[] = [];
	for (const raw of text.split("\n")) {
		const trimmed = raw.trim();
		const withFn = trimmed.match(/^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/);
		if (withFn) {
			frames.push({
				file: withFn[2],
				line: Number.parseInt(withFn[3], 10),
				column: Number.parseInt(withFn[4], 10),
				function: withFn[1],
				is_application: isApplicationJsFrame(withFn[2]),
			});
			continue;
		}
		const bare = trimmed.match(/^at\s+(.+?):(\d+):(\d+)$/);
		if (bare) {
			frames.push({
				file: bare[1],
				line: Number.parseInt(bare[2], 10),
				column: Number.parseInt(bare[3], 10),
				is_application: isApplicationJsFrame(bare[1]),
			});
		}
	}
	return frames;
}

function firstAppFrame(frames: StackFrame[]): SourceLocation | undefined {
	const f = frames.find((fr) => fr.is_application);
	if (!f) return undefined;
	return { file: f.file, line: f.line, column: f.column, symbol: f.function };
}

export const mochaParser: FailureParser = {
	name: "mocha",

	detect(stdout: string, stderr: string, command: string): boolean {
		if (/\bmocha\b/.test(command)) return true;
		const combined = `${stdout}\n${stderr}`;
		// Jest/Vitest own these summary shapes; defer to them.
		if (/^Tests:\s/m.test(combined) || /Test Files\s+\d/.test(combined)) return false;
		// Mocha footer: "N passing" almost always present; failures add "N failing".
		return /^\s*\d+\s+passing\b/m.test(combined) && /^\s*\d+\s+(failing|pending)\b/m.test(combined);
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// The detailed numbered failure blocks appear AFTER the summary counts
		// (`N passing` / `N failing`). The spec-list above the summary also uses
		// `N)` markers for failing tests, so restrict block parsing to the region
		// after the summary to avoid matching those single-line list entries.
		const summaryEnd = combined.search(/^\s*\d+\s+(?:failing|pending|passing)\b/m);
		const footer = summaryEnd >= 0 ? combined.slice(summaryEnd) : combined;

		// Numbered failure blocks in the footer. Each begins with "  N) ..." and
		// runs until the next numbered block or the end of output.
		const blockRegex = /^\s*\d+\)\s+([\s\S]*?)(?=^\s*\d+\)\s|$(?![\s\S]))/gm;
		let bm: RegExpExecArray | null = blockRegex.exec(footer);
		while (bm !== null) {
			const block = bm[1];
			const blockLines = block.split("\n");

			// First two meaningful lines are "Suite name" then "test name:".
			const titleParts: string[] = [];
			let idx = 0;
			for (; idx < blockLines.length && titleParts.length < 2; idx++) {
				const t = blockLines[idx].trim();
				if (!t) continue;
				// The error message line (ErrorType: ...) ends the title section.
				if (/(?:Error|Exception|AssertionError)\b.*:/.test(t) && titleParts.length > 0) break;
				titleParts.push(t.replace(/:$/, ""));
			}
			const testName = titleParts.join(" > ");

			// Error message: first line that looks like "SomethingError: message".
			let message = `Test failed: ${testName}`;
			let errorType = "AssertionError";
			const errLine = blockLines.find((l) =>
				/^\s*[\w.]*(?:Error|Exception|AssertionError):\s/.test(l),
			);
			if (errLine) {
				const m = errLine.trim().match(/^([\w.]*(?:Error|Exception|AssertionError)):\s*(.*)$/);
				if (m) {
					errorType = m[1];
					message = m[2].trim() || message;
				}
			}

			// Assertion diff: Mocha prints "+ expected - actual" then -actual/+expected.
			let assertion_diff: AssertionDiff | undefined;
			const expectedLines: string[] = [];
			const actualLines: string[] = [];
			for (const l of blockLines) {
				const t = l.trim();
				if (/^expected /.test(t)) {
					const cmp = t.match(/^expected\s+(.+?)\s+to\s+(?:equal|be|deeply equal)\s+(.+)$/);
					if (cmp && !assertion_diff) {
						assertion_diff = { actual: cmp[1], expected: cmp[2] };
					}
				}
				if (/^\+/.test(t) && !/expected/.test(t)) expectedLines.push(t.slice(1).trim());
				if (/^-/.test(t) && !/actual/.test(t)) actualLines.push(t.slice(1).trim());
			}
			if (!assertion_diff && (expectedLines.length > 0 || actualLines.length > 0)) {
				assertion_diff = {
					expected: expectedLines.join("\n"),
					actual: actualLines.join("\n"),
				};
			}

			const frames = parseFrames(block);
			const location = firstAppFrame(frames);

			errors.push({
				message,
				error_type: errorType,
				test_name: testName,
				test_file: location?.file,
				location,
				stack_frames: frames.length > 0 ? frames : undefined,
				assertion_diff,
			});

			bm = blockRegex.exec(footer);
		}

		// Footer summary counts.
		let test_summary: TestSummary | undefined;
		const passingMatch = combined.match(/^\s*(\d+)\s+passing\b/m);
		const failingMatch = combined.match(/^\s*(\d+)\s+failing\b/m);
		const pendingMatch = combined.match(/^\s*(\d+)\s+pending\b/m);
		if (passingMatch || failingMatch || pendingMatch) {
			const passed = passingMatch ? Number.parseInt(passingMatch[1], 10) : 0;
			const failed = failingMatch ? Number.parseInt(failingMatch[1], 10) : 0;
			const skipped = pendingMatch ? Number.parseInt(pendingMatch[1], 10) : 0;
			test_summary = { total: passed + failed + skipped, passed, failed, skipped };
		}

		return {
			parser: "mocha",
			failure_type: "test_failure",
			errors,
			test_summary,
		};
	},
};
