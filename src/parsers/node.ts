import type { SourceLocation } from "../types/common.js";
import type { AssertionDiff, ParsedError, StackFrame } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isApplicationJsFrame(filePath: string): boolean {
	return (
		!filePath.includes("node_modules") &&
		!filePath.includes("node:internal") &&
		!filePath.includes("<anonymous>")
	);
}

function parseJsStackFrames(text: string): StackFrame[] {
	const frames: StackFrame[] = [];
	const lines = text.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();

		// Pattern 1: at functionName (file:line:col)
		const match1 = trimmed.match(/^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/);
		if (match1) {
			frames.push({
				file: match1[2],
				line: Number.parseInt(match1[3], 10),
				column: Number.parseInt(match1[4], 10),
				function: match1[1],
				is_application: isApplicationJsFrame(match1[2]),
			});
			continue;
		}

		// Pattern 2: at file:line:col (no function name)
		const match2 = trimmed.match(/^at\s+(.+?):(\d+):(\d+)$/);
		if (match2) {
			frames.push({
				file: match2[1],
				line: Number.parseInt(match2[2], 10),
				column: Number.parseInt(match2[3], 10),
				is_application: isApplicationJsFrame(match2[1]),
			});
			continue;
		}

		// Pattern 3: at functionName (file:line) - no column
		const match3 = trimmed.match(/^at\s+(.+?)\s+\((.+?):(\d+)\)$/);
		if (match3) {
			frames.push({
				file: match3[2],
				line: Number.parseInt(match3[3], 10),
				function: match3[1],
				is_application: isApplicationJsFrame(match3[2]),
			});
		}
	}

	return frames;
}

function firstApplicationJsFrame(frames: StackFrame[]): SourceLocation | undefined {
	const appFrame = frames.find((f) => f.is_application);
	if (!appFrame) return undefined;
	return {
		file: appFrame.file,
		line: appFrame.line,
		column: appFrame.column,
		symbol: appFrame.function,
	};
}

// ─── JS Stack Trace Parser ──────────────────────────────────────────────────

export const jsStackParser: FailureParser = {
	name: "js-stack",

	detect(stdout: string, stderr: string, _command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		// Look for Node/JS style stack frames
		return /^\s*at\s+.+\(.+:\d+:\d+\)/m.test(combined) || /^\s*at\s+.+:\d+:\d+$/m.test(combined);
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// Find error message + stack blocks
		// Typical pattern: "ErrorType: message\n    at ..."
		const errorBlockRegex =
			/^(\w+(?:Error|Exception|TypeError|RangeError|ReferenceError|SyntaxError))\s*:\s*(.+)\n((?:\s+at\s+.+\n?)+)/gm;
		let blockMatch: RegExpExecArray | null;

		while ((blockMatch = errorBlockRegex.exec(combined)) !== null) {
			const errorType = blockMatch[1];
			const message = blockMatch[2].trim();
			const stackBlock = blockMatch[3];
			const frames = parseJsStackFrames(stackBlock);
			const location = firstApplicationJsFrame(frames);

			errors.push({
				message,
				error_type: errorType,
				location,
				stack_frames: frames.length > 0 ? frames : undefined,
			});
		}

		// Fallback: if we didn't match the error+stack block pattern,
		// look for standalone stack traces
		if (errors.length === 0) {
			const frames = parseJsStackFrames(combined);
			if (frames.length > 0) {
				// Try to find an error message before the stack
				const errLineMatch = combined.match(/^(.+(?:Error|Exception)):\s*(.+)$/m);
				const message = errLineMatch ? errLineMatch[2].trim() : "Runtime error";
				const errorType = errLineMatch ? errLineMatch[1] : undefined;
				const location = firstApplicationJsFrame(frames);

				errors.push({
					message,
					error_type: errorType,
					location,
					stack_frames: frames,
				});
			}
		}

		return {
			parser: "js-stack",
			failure_type: "runtime_exception",
			errors,
		};
	},
};

// ─── Jest Parser ─────────────────────────────────────────────────────────────

export const jestParser: FailureParser = {
	name: "jest",

	detect(stdout: string, stderr: string, command: string): boolean {
		if (/\bjest\b/.test(command)) return true;
		const combined = `${stdout}\n${stderr}`;
		if (combined.includes("Tests:") && /\bfail/i.test(combined)) return true;
		if (/^FAIL\s+/m.test(combined)) return true;
		return false;
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// 1. Extract FAIL file markers
		const failFileRegex = /^FAIL\s+(.+)$/gm;
		const failFiles: string[] = [];
		let failFileMatch: RegExpExecArray | null;
		while ((failFileMatch = failFileRegex.exec(combined)) !== null) {
			failFiles.push(failFileMatch[1].trim());
		}

		// 2. Extract individual test failures with their details
		// Jest output structure:
		//   ● TestSuite > test name
		//     expect(received).toBe(expected)
		//     Expected: value
		//     Received: value
		//       at Object.<anonymous> (file:line:col)
		const testFailureRegex =
			/●\s+(.+?)(?:\n\n|\n)([\s\S]*?)(?=\n\s*●|\n\s*Test Suites:|\n\s*Tests:|$)/g;
		let testMatch: RegExpExecArray | null;

		while ((testMatch = testFailureRegex.exec(combined)) !== null) {
			const testName = testMatch[1].trim();
			const body = testMatch[2];

			// Extract expected/received
			let assertion_diff: AssertionDiff | undefined;
			const expectedMatch = body.match(/Expected:\s*(.+)/);
			const receivedMatch = body.match(/Received:\s*(.+)/);
			if (expectedMatch && receivedMatch) {
				assertion_diff = {
					expected: expectedMatch[1].trim(),
					actual: receivedMatch[1].trim(),
				};
			}

			// Try toBe/toEqual patterns
			if (!assertion_diff) {
				const toBeMatch = body.match(/expect\((.+?)\)\.toBe\((.+?)\)/);
				if (toBeMatch) {
					assertion_diff = {
						actual: toBeMatch[1].trim(),
						expected: toBeMatch[2].trim(),
						operator: "toBe",
					};
				}
			}
			if (!assertion_diff) {
				const toEqualMatch = body.match(/expect\((.+?)\)\.toEqual\((.+?)\)/);
				if (toEqualMatch) {
					assertion_diff = {
						actual: toEqualMatch[1].trim(),
						expected: toEqualMatch[2].trim(),
						operator: "toEqual",
					};
				}
			}

			// Extract error message (first non-empty line of body, or matcher line)
			const bodyLines = body
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			const message = bodyLines[0] ?? `Test failed: ${testName}`;

			// Extract stack frames
			const frames = parseJsStackFrames(body);
			const location = firstApplicationJsFrame(frames);

			// Determine test file from FAIL markers or stack frames
			const testFile =
				failFiles.length > 0 ? failFiles[0] : frames.find((f) => f.is_application)?.file;

			errors.push({
				message,
				error_type: "AssertionError",
				test_name: testName,
				test_file: testFile,
				location,
				stack_frames: frames.length > 0 ? frames : undefined,
				assertion_diff,
			});
		}

		// 3. Fallback: extract failed test names from checkmark lines
		if (errors.length === 0) {
			const failLineRegex = /(?:✕|×|✗)\s+(.+)/g;
			let failLine: RegExpExecArray | null;
			while ((failLine = failLineRegex.exec(combined)) !== null) {
				errors.push({
					message: `Test failed: ${failLine[1].trim()}`,
					error_type: "AssertionError",
					test_name: failLine[1].trim(),
					test_file: failFiles.length > 0 ? failFiles[0] : undefined,
				});
			}
		}

		// 4. Extract test summary
		let test_summary: ParserResult["test_summary"] | undefined;
		// Match the Tests: summary line specifically
		{
			const testsLine = combined.match(/^Tests:\s+(.+)$/m);
			if (testsLine) {
				const line = testsLine[1];
				const failedMatch = line.match(/(\d+)\s+failed/);
				const passedMatch = line.match(/(\d+)\s+passed/);
				const skippedMatch = line.match(/(\d+)\s+skipped/);
				const totalMatch = line.match(/(\d+)\s+total/);
				if (totalMatch) {
					const failed = failedMatch ? Number.parseInt(failedMatch[1], 10) : 0;
					const passed = passedMatch ? Number.parseInt(passedMatch[1], 10) : 0;
					const skipped = skippedMatch ? Number.parseInt(skippedMatch[1], 10) : 0;
					const total = Number.parseInt(totalMatch[1], 10);
					test_summary = { total, passed, failed, skipped };
				}
			}
		}
		if (!test_summary) {
			// Try a more relaxed pattern
			const failedMatch = combined.match(/(\d+)\s+failed/);
			const passedMatch = combined.match(/(\d+)\s+passed/);
			const totalMatch = combined.match(/(\d+)\s+total/);
			if (failedMatch && totalMatch) {
				test_summary = {
					total: Number.parseInt(totalMatch[1], 10),
					passed: passedMatch ? Number.parseInt(passedMatch[1], 10) : 0,
					failed: Number.parseInt(failedMatch[1], 10),
					skipped: 0,
				};
			}
		}

		return {
			parser: "jest",
			failure_type: "test_failure",
			errors,
			test_summary,
		};
	},
};

// ─── Vitest Parser ───────────────────────────────────────────────────────────

export const vitestParser: FailureParser = {
	name: "vitest",

	detect(stdout: string, stderr: string, command: string): boolean {
		if (/\bvitest\b/.test(command)) return true;
		const combined = `${stdout}\n${stderr}`;
		if (combined.includes("vitest") && /FAIL/i.test(combined)) return true;
		if (/Test Files\s+/.test(combined) && /FAIL/i.test(combined)) return true;
		return false;
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// 1. Extract FAIL blocks with nested describe/test path
		// Vitest format: "FAIL  src/file.test.ts > describe > test name"
		// or: " FAIL  src/file.test.ts > test name"
		const failBlockRegex =
			/FAIL\s+(.+?\.(?:test|spec)\.\w+)\s*>\s*(.+?)(?:\n)([\s\S]*?)(?=\n\s*(?:FAIL|PASS|Test Files|Tests\s+\d)|$)/g;
		let blockMatch: RegExpExecArray | null;

		while ((blockMatch = failBlockRegex.exec(combined)) !== null) {
			const testFile = blockMatch[1].trim();
			const testPath = blockMatch[2].trim();
			const body = blockMatch[3];

			// Extract assertion details
			let assertion_diff: AssertionDiff | undefined;

			// Vitest uses: "expected '...' to be '...'" or "expected ... to equal ..."
			const toBeMatch = body.match(
				/expected\s+'(.+?)'\s+to\s+(?:be|equal|strictly equal)\s+'(.+?)'/,
			);
			if (toBeMatch) {
				assertion_diff = {
					actual: toBeMatch[1],
					expected: toBeMatch[2],
					operator: "toBe",
				};
			}

			// Also try: "expected X to deeply equal Y"
			if (!assertion_diff) {
				const deepMatch = body.match(/expected\s+(.+?)\s+to\s+deeply\s+equal\s+(.+)/);
				if (deepMatch) {
					assertion_diff = {
						actual: deepMatch[1].trim(),
						expected: deepMatch[2].trim(),
						operator: "toEqual",
					};
				}
			}

			// Try Expected/Received blocks (Vitest also uses these)
			if (!assertion_diff) {
				const expectedMatch = body.match(/Expected:\s*(.+)/);
				const receivedMatch = body.match(/Received:\s*(.+)/);
				if (expectedMatch && receivedMatch) {
					assertion_diff = {
						expected: expectedMatch[1].trim(),
						actual: receivedMatch[1].trim(),
					};
				}
			}

			// Try - Expected / + Received format
			if (!assertion_diff) {
				const diffExpected = body.match(/^-\s*Expected\s*-\s*$/m);
				const diffReceived = body.match(/^\+\s*Received\s*\+\s*$/m);
				if (diffExpected && diffReceived) {
					const expLines: string[] = [];
					const recLines: string[] = [];
					for (const line of body.split("\n")) {
						if (line.startsWith("-") && !line.includes("Expected")) {
							expLines.push(line.slice(1).trim());
						}
						if (line.startsWith("+") && !line.includes("Received")) {
							recLines.push(line.slice(1).trim());
						}
					}
					if (expLines.length > 0 || recLines.length > 0) {
						assertion_diff = {
							expected: expLines.join("\n"),
							actual: recLines.join("\n"),
						};
					}
				}
			}

			// Extract error message
			const bodyLines = body
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			const errorLine = bodyLines.find(
				(l) =>
					l.startsWith("AssertionError:") || l.startsWith("Error:") || l.startsWith("expected"),
			);
			const message = errorLine ?? bodyLines[0] ?? `Test failed: ${testPath}`;

			// Extract stack frames
			const frames = parseJsStackFrames(body);
			const location =
				firstApplicationJsFrame(frames) ?? (testFile ? { file: testFile, line: 1 } : undefined);

			errors.push({
				message,
				error_type: "AssertionError",
				test_name: testPath,
				test_file: testFile,
				location,
				stack_frames: frames.length > 0 ? frames : undefined,
				assertion_diff,
			});
		}

		// 2. Fallback: look for "AssertionError" blocks without the FAIL prefix
		if (errors.length === 0) {
			const assertBlockRegex =
				/AssertionError:\s*(.+?)(?:\n)([\s\S]*?)(?=\n\s*(?:AssertionError|Test Files|Tests\s+\d)|$)/g;
			let assertMatch: RegExpExecArray | null;

			while ((assertMatch = assertBlockRegex.exec(combined)) !== null) {
				const message = assertMatch[1].trim();
				const body = assertMatch[2];
				const frames = parseJsStackFrames(body);
				const location = firstApplicationJsFrame(frames);

				errors.push({
					message,
					error_type: "AssertionError",
					location,
					stack_frames: frames.length > 0 ? frames : undefined,
				});
			}
		}

		// 3. Another fallback: Extract individual failed test names from "x" markers
		if (errors.length === 0) {
			const failLineRegex = /(?:✕|×|✗)\s+(.+)/g;
			let failLine: RegExpExecArray | null;
			while ((failLine = failLineRegex.exec(combined)) !== null) {
				errors.push({
					message: `Test failed: ${failLine[1].trim()}`,
					error_type: "AssertionError",
					test_name: failLine[1].trim(),
				});
			}
		}

		// 4. Extract test summary
		let test_summary: ParserResult["test_summary"] | undefined;

		// Vitest format: "Test Files  2 failed | 5 passed (7)"
		// and: "Tests  3 failed | 10 passed | 2 skipped (15)"
		const testsLineMatch = combined.match(
			/Tests\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/,
		);
		if (testsLineMatch) {
			test_summary = {
				total: Number.parseInt(testsLineMatch[4], 10),
				passed: testsLineMatch[2] ? Number.parseInt(testsLineMatch[2], 10) : 0,
				failed: Number.parseInt(testsLineMatch[1], 10),
				skipped: testsLineMatch[3] ? Number.parseInt(testsLineMatch[3], 10) : 0,
			};
		}

		// Also check for "Test Files" line for file-level summary
		if (!test_summary) {
			const fileLineMatch = combined.match(
				/Test Files\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?\s*\((\d+)\)/,
			);
			if (fileLineMatch) {
				test_summary = {
					total: Number.parseInt(fileLineMatch[3], 10),
					passed: fileLineMatch[2] ? Number.parseInt(fileLineMatch[2], 10) : 0,
					failed: Number.parseInt(fileLineMatch[1], 10),
					skipped: 0,
				};
			}
		}

		return {
			parser: "vitest",
			failure_type: "test_failure",
			errors,
			test_summary,
		};
	},
};
