import type { ParsedError, TestSummary } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

/**
 * Parser for `cargo test` / Rust runtime output.
 *
 * Recognizes:
 *  - `thread '...' panicked at FILE:LINE:COL:` panic locations with the
 *    following message line (assertion failures, unwraps, etc.).
 *  - `error[E####]: message` rustc compiler diagnostics with `--> file:line:col`.
 *  - `test result: FAILED. N passed; M failed; ...` summaries and
 *    `---- test_name stdout ----` failing-test markers.
 */
export const rustParser: FailureParser = {
	name: "rust",

	detect(stdout: string, stderr: string, command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		if (/\bcargo\s+(test|build|run|check)\b/.test(command)) return true;
		return (
			/thread '.*' panicked at/.test(combined) ||
			/^error\[E\d+\]:/m.test(combined) ||
			/^test result: (FAILED|ok)\./m.test(combined)
		);
	},

	parse(stdout: string, stderr: string, command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];
		const isBuild = /^error\[E\d+\]:/m.test(combined) && !/test result:/.test(combined);

		// rustc compiler diagnostics: error[E####]: msg  +  --> file:line:col
		const compilerRegex = /error(\[E\d+\])?:\s*(.+?)\n(?:\s*-->\s*([^\s:]+):(\d+):(\d+))?/g;
		let cm: RegExpExecArray | null = compilerRegex.exec(combined);
		while (cm !== null) {
			// Skip the generic "aborting due to N previous errors" trailer.
			if (!/aborting due to/.test(cm[2])) {
				errors.push({
					message: cm[2].trim(),
					error_type: cm[1] ? cm[1].slice(1, -1) : "CompileError",
					location:
						cm[3] && cm[4]
							? {
									file: cm[3],
									line: Number.parseInt(cm[4], 10),
									column: cm[5] ? Number.parseInt(cm[5], 10) : undefined,
								}
							: undefined,
				});
			}
			cm = compilerRegex.exec(combined);
		}

		// Panic locations: thread '...' panicked at FILE:LINE:COL:\n<message>
		const panicRegex = /thread '([^']*)' panicked at ([^\s:]+):(\d+):(\d+):\s*\n\s*(.+)/g;
		let pm: RegExpExecArray | null = panicRegex.exec(combined);
		while (pm !== null) {
			errors.push({
				message: pm[5].trim(),
				error_type: "panic",
				location: {
					file: pm[2],
					line: Number.parseInt(pm[3], 10),
					column: Number.parseInt(pm[4], 10),
				},
			});
			pm = panicRegex.exec(combined);
		}

		// Failing test names: `---- test_name stdout ----`
		const failNameRegex = /^---- (\S+) stdout ----/gm;
		let fnm: RegExpExecArray | null = failNameRegex.exec(combined);
		while (fnm !== null) {
			const name = fnm[1];
			if (!errors.some((e) => e.test_name === name)) {
				errors.push({
					message: `Test failed: ${name}`,
					error_type: "TestFailure",
					test_name: name,
				});
			}
			fnm = failNameRegex.exec(combined);
		}

		// Test summary: `test result: FAILED. 3 passed; 2 failed; 1 ignored; ...`
		let test_summary: TestSummary | undefined;
		const summaryRegex =
			/test result: (?:FAILED|ok)\.\s*(\d+) passed;\s*(\d+) failed;(?:\s*(\d+) ignored;)?/;
		const sm = combined.match(summaryRegex);
		if (sm) {
			const passed = Number.parseInt(sm[1], 10);
			const failed = Number.parseInt(sm[2], 10);
			const skipped = sm[3] ? Number.parseInt(sm[3], 10) : 0;
			test_summary = { total: passed + failed + skipped, passed, failed, skipped };
		}

		return {
			parser: "rust",
			failure_type: isBuild ? "build_error" : "test_failure",
			errors,
			test_summary,
		};
	},
};
