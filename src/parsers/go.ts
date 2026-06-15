import type { ParsedError, StackFrame, TestSummary } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

/**
 * Parser for `go test` output.
 *
 * Recognizes failing tests (`--- FAIL: TestName`), indented failure detail
 * lines with `file_test.go:NN:` locations, panics, and the test summary
 * (counts of PASS/FAIL/SKIP plus the package `FAIL`/`ok` line).
 */
export const goTestParser: FailureParser = {
	name: "go-test",

	detect(stdout: string, stderr: string, command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		if (/\bgo\s+test\b/.test(command)) return true;
		return (
			/^--- FAIL: /m.test(combined) || (/^=== RUN /m.test(combined) && /^FAIL/m.test(combined))
		);
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const lines = combined.split("\n");
		const errors: ParsedError[] = [];

		let failed = 0;
		let passed = 0;
		let skipped = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			const passMatch = line.match(/^\s*--- PASS: \S+/);
			if (passMatch) {
				passed++;
				continue;
			}
			const skipMatch = line.match(/^\s*--- SKIP: \S+/);
			if (skipMatch) {
				skipped++;
				continue;
			}

			const failMatch = line.match(/^\s*--- FAIL: (\S+)/);
			if (failMatch) {
				failed++;
				const testName = failMatch[1];
				// In `go test` output, the `t.Errorf`/`t.Fatalf` detail lines are
				// printed DURING the run, i.e. on the indented lines immediately
				// BEFORE the `--- FAIL:` marker. Scan backward to find the first
				// `file.go:line:` location and its message.
				let location: ParsedError["location"];
				let message = `Test failed: ${testName}`;
				for (let j = i - 1; j >= 0 && /^\s/.test(lines[j]); j--) {
					const detail = lines[j].trim();
					const locMatch = detail.match(/^([\w./-]+\.go):(\d+):\s*(.*)$/);
					if (locMatch) {
						location = { file: locMatch[1], line: Number.parseInt(locMatch[2], 10) };
						if (locMatch[3]) message = `${testName}: ${locMatch[3]}`;
						// Keep scanning to the earliest detail line (closest to === RUN).
					}
					// Stop if we reach a non-detail marker line.
					if (/^\s*(=== RUN|--- )/.test(lines[j])) break;
				}
				errors.push({
					message,
					error_type: "GoTestFailure",
					test_name: testName,
					location,
				});
			}
		}

		// Panics (with goroutine stack frames pointing to .go files).
		const panicMatch = combined.match(/^panic: (.+)$/m);
		if (panicMatch) {
			const stackFrames: StackFrame[] = [];
			const frameRegex = /\n\t([\w./-]+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?/g;
			let fm: RegExpExecArray | null;
			fm = frameRegex.exec(combined);
			while (fm !== null) {
				stackFrames.push({
					file: fm[1],
					line: Number.parseInt(fm[2], 10),
					is_application: !fm[1].includes("/usr/") && !fm[1].startsWith("runtime/"),
				});
				fm = frameRegex.exec(combined);
			}
			errors.push({
				message: panicMatch[1].trim(),
				error_type: "panic",
				location: stackFrames.find((f) => f.is_application)
					? {
							file: stackFrames.find((f) => f.is_application)!.file,
							line: stackFrames.find((f) => f.is_application)!.line,
						}
					: undefined,
				stack_frames: stackFrames.length > 0 ? stackFrames : undefined,
			});
		}

		let test_summary: TestSummary | undefined;
		if (failed + passed + skipped > 0) {
			test_summary = {
				total: failed + passed + skipped,
				passed,
				failed,
				skipped,
			};
		}

		return {
			parser: "go-test",
			failure_type: "test_failure",
			errors,
			test_summary,
		};
	},
};
