import type { AssertionDiff, ParsedError, StackFrame, TestSummary } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

/**
 * Parser for Ruby runtime exceptions and RSpec / Minitest output.
 *
 * Recognizes:
 *  - Uncaught exceptions: `file:line:in 'method': message (ErrorClass)` with a
 *    `\tfrom file:line:in 'method'` backtrace (handles both the modern `'m'`
 *    and legacy backtick `` `m' `` quoting).
 *  - RSpec failure blocks: `N) <example>` + `Failure/Error: <expr>` +
 *    `expected:`/`got:` diff + a `# ./spec/foo_spec.rb:NN` location line.
 *  - Summaries: RSpec `N examples, M failures[, K pending]` and Minitest
 *    `N runs, A assertions, F failures, E errors, S skips`.
 */

function isApplicationFrame(file: string): boolean {
	return !/\/gems\/|\/lib\/ruby\/|\/ruby\/gems\//.test(file);
}

export const rubyParser: FailureParser = {
	name: "ruby",

	detect(stdout: string, stderr: string, command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		const hasRubyShape =
			/:\d+:in ['`][^'`]*'/.test(combined) ||
			/\(\w*(?:Error|Exception)\)\s*$/m.test(combined) ||
			/^\d+ examples?, \d+ failures?/m.test(combined) ||
			/^\d+ runs?, \d+ assertions?/m.test(combined);
		if (/\b(ruby|rspec|rake|bundle)\b/.test(command)) {
			return hasRubyShape;
		}
		return hasRubyShape;
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// 1. Uncaught exceptions with a backtrace. The originating line is
		// `file:line:in 'm': message (ErrorClass)`; consecutive `\tfrom ...`
		// lines that follow are additional backtrace frames.
		const lines = combined.split("\n");
		const excLine = /^(.+?):(\d+):in ['`]([^'`]*)'?: (.+?) \(([\w:]+)\)\s*$/;
		const fromLine = /^\s*from (.+?):(\d+):in ['`]([^'`]*)'?/;
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(excLine);
			if (!m) continue;
			const frames: StackFrame[] = [
				{
					file: m[1],
					line: Number.parseInt(m[2], 10),
					function: m[3],
					is_application: isApplicationFrame(m[1]),
				},
			];
			for (let j = i + 1; j < lines.length; j++) {
				const f = lines[j].match(fromLine);
				if (!f) break;
				frames.push({
					file: f[1],
					line: Number.parseInt(f[2], 10),
					function: f[3],
					is_application: isApplicationFrame(f[1]),
				});
			}
			const appFrame = frames.find((f) => f.is_application) ?? frames[0];
			errors.push({
				message: m[4].trim(),
				error_type: m[5],
				location: { file: appFrame.file, line: appFrame.line, symbol: appFrame.function },
				stack_frames: frames,
			});
		}

		// 2. RSpec failure blocks.
		const rspecRegex =
			/^\s*\d+\)\s+(.+)\n\s*Failure\/Error:\s*(.+)([\s\S]*?)(?=^\s*\d+\)\s|\n\s*Finished in|$(?![\s\S]))/gm;
		let rm: RegExpExecArray | null = rspecRegex.exec(combined);
		while (rm !== null) {
			const example = rm[1].trim();
			const failExpr = rm[2].trim();
			const body = rm[3] ?? "";

			let assertion_diff: AssertionDiff | undefined;
			const expected = body.match(/^\s*expected:\s*(.+)$/m);
			const got = body.match(/^\s*got:\s*(.+)$/m);
			if (expected && got) {
				assertion_diff = { expected: expected[1].trim(), actual: got[1].trim() };
			}

			// Location: first `# ./path:NN` line in the block.
			const locMatch = body.match(/^\s*#\s*(\.{0,2}\/?[\w./-]+):(\d+)/m);
			const location = locMatch
				? { file: locMatch[1], line: Number.parseInt(locMatch[2], 10) }
				: undefined;

			if (!errors.some((e) => e.test_name === example)) {
				errors.push({
					message: failExpr,
					error_type: "RSpecFailure",
					test_name: example,
					location,
					assertion_diff,
				});
			}
			rm = rspecRegex.exec(combined);
		}

		// 3. Summaries.
		let test_summary: TestSummary | undefined;
		const rspecSummary = combined.match(/^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/m);
		const minitestSummary = combined.match(
			/^(\d+) runs?, \d+ assertions?, (\d+) failures?, (\d+) errors?, (\d+) skips?/m,
		);
		if (minitestSummary) {
			const total = Number.parseInt(minitestSummary[1], 10);
			const failures = Number.parseInt(minitestSummary[2], 10);
			const errs = Number.parseInt(minitestSummary[3], 10);
			const skipped = Number.parseInt(minitestSummary[4], 10);
			const failed = failures + errs;
			test_summary = {
				total,
				passed: Math.max(0, total - failed - skipped),
				failed,
				skipped,
				errored: errs,
			};
		} else if (rspecSummary) {
			const total = Number.parseInt(rspecSummary[1], 10);
			const failed = Number.parseInt(rspecSummary[2], 10);
			const skipped = rspecSummary[3] ? Number.parseInt(rspecSummary[3], 10) : 0;
			test_summary = { total, passed: Math.max(0, total - failed - skipped), failed, skipped };
		}

		const failureType =
			errors.some((e) => e.test_name) || test_summary ? "test_failure" : "runtime_exception";

		return {
			parser: "ruby",
			failure_type: failureType,
			errors,
			test_summary,
		};
	},
};
