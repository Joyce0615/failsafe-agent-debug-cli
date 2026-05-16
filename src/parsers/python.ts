import type { SourceLocation } from "../types/common.js";
import type { AssertionDiff, ParsedError, StackFrame } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isApplicationFrame(filePath: string): boolean {
	return (
		!filePath.includes("site-packages") &&
		!filePath.includes("lib/python") &&
		!filePath.includes("<frozen")
	);
}

function parseTracebackFrames(block: string): StackFrame[] {
	const frameRegex = /File "(.+?)", line (\d+), in (.+)/g;
	const frames: StackFrame[] = [];
	let match: RegExpExecArray | null;
	while ((match = frameRegex.exec(block)) !== null) {
		frames.push({
			file: match[1],
			line: Number.parseInt(match[2], 10),
			function: match[3],
			is_application: isApplicationFrame(match[1]),
		});
	}
	return frames;
}

function extractExceptionFromTraceback(block: string): {
	error_type?: string;
	message: string;
} {
	// The exception line is the last non-empty line that isn't a "File" or code line
	// and typically looks like: "ValueError: some message"
	const lines = block.split("\n");
	// Walk backwards to find exception line
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		// Skip Python 3.12+ caret indicator lines (e.g., "~~~~^^^^^", "^^^^^^^")
		if (/^[~^]+$/.test(line)) continue;
		// Skip code context lines (indented source)
		if (lines[i].startsWith("    ") && !line.match(/^\w+(?:Error|Exception)/)) continue;
		// Exception lines typically match: ExceptionType: message
		const exMatch = line.match(
			/^(\w+(?:\.\w+)*(?:Error|Exception|Warning|Exit|Interrupt|Failure))\s*:\s*(.+)/,
		);
		if (exMatch) {
			return { error_type: exMatch[1], message: exMatch[2].trim() };
		}
		// Also handle bare exception names like "KeyboardInterrupt"
		const bareMatch = line.match(
			/^(\w+(?:\.\w+)*(?:Error|Exception|Warning|Exit|Interrupt|Failure))\s*$/,
		);
		if (bareMatch) {
			return { error_type: bareMatch[1], message: bareMatch[1] };
		}
		// If we hit a "File" or "Traceback" line, stop looking
		if (line.startsWith("File ") || line.startsWith("Traceback ")) break;
	}
	return { message: block.trim().split("\n").pop()?.trim() ?? "Unknown error" };
}

function firstApplicationFrame(frames: StackFrame[]): SourceLocation | undefined {
	// Prefer the topmost application frame (first in the stack)
	const appFrame = frames.find((f) => f.is_application);
	if (!appFrame) return undefined;
	return {
		file: appFrame.file,
		line: appFrame.line,
		column: appFrame.column,
		symbol: appFrame.function,
	};
}

// ─── Python Traceback Parser ─────────────────────────────────────────────────

export const pythonTracebackParser: FailureParser = {
	name: "python-traceback",

	detect(stdout: string, stderr: string, _command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		return combined.includes("Traceback (most recent call last):");
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// Split on traceback headers to handle multiple tracebacks.
		// Captures everything from "Traceback" through the exception line
		// (e.g., "KeyError: 'email'"). The exception line is a non-indented,
		// non-"File" line that follows the stack frames.
		const tracebackRegex =
			/Traceback \(most recent call last\):\n[\s\S]*?(?:\w+(?:\.\w+)*(?:Error|Exception|Warning|Exit|Interrupt|Failure)[^\n]*)/g;
		let tbMatch: RegExpExecArray | null;
		while ((tbMatch = tracebackRegex.exec(combined)) !== null) {
			const block = tbMatch[0];
			const frames = parseTracebackFrames(block);
			const { error_type, message } = extractExceptionFromTraceback(block);
			const location = firstApplicationFrame(frames);

			errors.push({
				message,
				error_type,
				location,
				stack_frames: frames.length > 0 ? frames : undefined,
			});
		}

		// Fallback: if regex didn't capture any, do a simpler split
		if (errors.length === 0) {
			const parts = combined.split("Traceback (most recent call last):");
			for (let i = 1; i < parts.length; i++) {
				const block = `Traceback (most recent call last):${parts[i]}`;
				const frames = parseTracebackFrames(block);
				const { error_type, message } = extractExceptionFromTraceback(block);
				const location = firstApplicationFrame(frames);

				errors.push({
					message,
					error_type,
					location,
					stack_frames: frames.length > 0 ? frames : undefined,
				});
			}
		}

		return {
			parser: "python-traceback",
			failure_type: "runtime_exception",
			errors,
		};
	},
};

// ─── Pytest Parser ───────────────────────────────────────────────────────────

export const pytestParser: FailureParser = {
	name: "pytest",

	detect(stdout: string, stderr: string, command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		if (/\bpytest\b/.test(command)) return true;
		if (combined.includes("= FAILURES =") || combined.includes("=FAILURES=")) return true;
		if (combined.includes("short test summary") && combined.toLowerCase().includes("failed"))
			return true;
		return false;
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// 1. Parse the FAILURES block for detailed assertion/traceback info
		const failuresBlockMatch = combined.match(
			/={3,} FAILURES ={3,}\n([\s\S]*?)(?=={3,}(?:\s+\d+ | short test summary))/,
		);

		// Map from test identifier -> detailed error info from FAILURES block
		const failureDetails = new Map<
			string,
			{
				frames: StackFrame[];
				assertion_diff?: AssertionDiff;
				message: string;
				location?: SourceLocation;
			}
		>();

		if (failuresBlockMatch) {
			const failuresBlock = failuresBlockMatch[1];
			// Split into individual test failure sections
			const testSections = failuresBlock.split(/_{3,} (.+?) _{3,}/);
			// testSections: ["", "test_name_1", "content_1", "test_name_2", "content_2", ...]
			for (let i = 1; i < testSections.length; i += 2) {
				const testName = testSections[i].trim();
				const content = testSections[i + 1] || "";

				// Extract stack frames from the section
				const frames = parseTracebackFrames(content);

				// Extract assertion details
				let assertion_diff: AssertionDiff | undefined;
				let assertionMessage = "";

				// Look for "E       assert ..." or "E       AssertionError:" lines
				const eLines: string[] = [];
				const contentLines = content.split("\n");
				for (const line of contentLines) {
					const eMatch = line.match(/^E\s{3,}(.+)/);
					if (eMatch) {
						eLines.push(eMatch[1].trim());
					}
				}

				if (eLines.length > 0) {
					assertionMessage = eLines.join("\n");

					// Try to extract expected/actual from "assert X == Y" patterns
					const assertEqMatch = eLines.join(" ").match(/assert\s+(.+?)\s*==\s*(.+)/);
					if (assertEqMatch) {
						assertion_diff = {
							expected: assertEqMatch[2].trim(),
							actual: assertEqMatch[1].trim(),
							operator: "==",
						};
					}

					// Try "AssertionError: X != Y" or "AssertionError: message"
					const assertErrMatch = eLines
						.join(" ")
						.match(/Assertion(?:Error)?\s*:\s*(.+?)\s*!=\s*(.+)/);
					if (assertErrMatch && !assertion_diff) {
						assertion_diff = {
							expected: assertErrMatch[2].trim(),
							actual: assertErrMatch[1].trim(),
							operator: "!=",
						};
					}

					// Try "Expected X, got Y" pattern
					const expectedGotMatch = eLines
						.join(" ")
						.match(/[Ee]xpected\s+(.+?),?\s+(?:got|but got|received)\s+(.+)/);
					if (expectedGotMatch && !assertion_diff) {
						assertion_diff = {
							expected: expectedGotMatch[1].trim(),
							actual: expectedGotMatch[2].trim(),
						};
					}
				}

				// Find the failing assertion location from "> " lines
				let assertLocation: SourceLocation | undefined;
				for (let j = 0; j < contentLines.length; j++) {
					if (contentLines[j].match(/^>\s{3,}/)) {
						// Look for the file/line just above this assertion
						for (let k = j - 1; k >= 0; k--) {
							const locMatch = contentLines[k].match(/^(.+?):(\d+):\s/);
							if (locMatch) {
								assertLocation = {
									file: locMatch[1].trim(),
									line: Number.parseInt(locMatch[2], 10),
								};
								break;
							}
						}
						break;
					}
				}

				// Also try the traceback format within pytest output
				if (!assertLocation && frames.length > 0) {
					assertLocation = firstApplicationFrame(frames);
				}

				const message = assertionMessage || extractExceptionFromTraceback(content).message;

				failureDetails.set(testName, {
					frames,
					assertion_diff,
					message,
					location: assertLocation,
				});
			}
		}

		// 2. Extract FAILED test names from short summary section
		const shortSummaryMatch = combined.match(
			/={3,} short test summary info ={3,}\n([\s\S]*?)(?=={3,}|$)/,
		);

		const processedTests = new Set<string>();

		if (shortSummaryMatch) {
			const summaryBlock = shortSummaryMatch[1];
			const summaryLines = summaryBlock.split("\n");

			for (const line of summaryLines) {
				// FAILED path/to/test.py::test_name - reason
				const failedWithReason = line.match(/FAILED\s+(.+?)::(.+?)\s+-\s+(.+)/);
				if (failedWithReason) {
					const testFile = failedWithReason[1].trim();
					const testName = failedWithReason[2].trim();
					const reason = failedWithReason[3].trim();
					const fullName = `${testFile}::${testName}`;
					processedTests.add(fullName);

					const details = failureDetails.get(testName) ?? failureDetails.get(fullName);

					errors.push({
						message: details?.message ?? reason,
						error_type: "AssertionError",
						test_name: testName,
						test_file: testFile,
						location: details?.location ?? { file: testFile, line: 1 },
						stack_frames: details?.frames,
						assertion_diff: details?.assertion_diff,
					});
					continue;
				}

				// FAILED path/to/test.py::test_name (no reason)
				const failedBare = line.match(/FAILED\s+(.+?)::(.+)/);
				if (failedBare) {
					const testFile = failedBare[1].trim();
					const testName = failedBare[2].trim();
					const fullName = `${testFile}::${testName}`;
					processedTests.add(fullName);

					const details = failureDetails.get(testName) ?? failureDetails.get(fullName);

					errors.push({
						message: details?.message ?? `Test failed: ${testName}`,
						error_type: "AssertionError",
						test_name: testName,
						test_file: testFile,
						location: details?.location ?? { file: testFile, line: 1 },
						stack_frames: details?.frames,
						assertion_diff: details?.assertion_diff,
					});
					continue;
				}

				// FAILED path (fallback)
				const failedPath = line.match(/FAILED\s+(.+)/);
				if (failedPath) {
					const testPath = failedPath[1].trim();
					processedTests.add(testPath);

					errors.push({
						message: `Test failed: ${testPath}`,
						error_type: "AssertionError",
						test_name: testPath,
					});
				}
			}
		}

		// 3. If no short summary found, use details from FAILURES block directly
		if (errors.length === 0 && failureDetails.size > 0) {
			for (const [testName, details] of failureDetails) {
				errors.push({
					message: details.message,
					error_type: "AssertionError",
					test_name: testName,
					location: details.location,
					stack_frames: details.frames,
					assertion_diff: details.assertion_diff,
				});
			}
		}

		// 4. Extract collection errors
		const collectionErrorRegex = /ERROR collecting (.+?)(?:\n|$)/g;
		let collMatch: RegExpExecArray | null;
		while ((collMatch = collectionErrorRegex.exec(combined)) !== null) {
			errors.push({
				message: `Error collecting ${collMatch[1]}`,
				error_type: "CollectionError",
				test_file: collMatch[1].trim(),
			});
		}

		// Also parse ImportError/ModuleNotFoundError in collection phase
		const importErrMatch = combined.match(/ImportError[^:]*:\s*(.+?)(?:\n|$)/);
		if (importErrMatch && errors.length === 0) {
			errors.push({
				message: importErrMatch[1].trim(),
				error_type: "ImportError",
			});
		}

		// 5. Extract test summary from the final status line
		let test_summary: ParserResult["test_summary"] | undefined;
		// Match the final summary line: "= N failed, N passed in Xs ="
		// Use a specific pattern to avoid matching "test session starts"
		const summaryLineMatch = combined.match(
			/={3,}\s*(\d+\s+(?:failed|passed|error|warning|skipped).*?)\s*={3,}\s*$/m,
		);
		if (summaryLineMatch) {
			const summaryLine = summaryLineMatch[1];
			const failedMatch = summaryLine.match(/(\d+)\s+failed/);
			const passedMatch = summaryLine.match(/(\d+)\s+passed/);
			const skippedMatch = summaryLine.match(/(\d+)\s+skipped/);
			const errorMatch = summaryLine.match(/(\d+)\s+error/);
			const warningMatch = summaryLine.match(/(\d+)\s+warning/);

			const failed = failedMatch ? Number.parseInt(failedMatch[1], 10) : 0;
			const passed = passedMatch ? Number.parseInt(passedMatch[1], 10) : 0;
			const skipped = skippedMatch ? Number.parseInt(skippedMatch[1], 10) : 0;
			const errored = errorMatch ? Number.parseInt(errorMatch[1], 10) : 0;

			test_summary = {
				total: failed + passed + skipped + errored,
				passed,
				failed,
				skipped,
				errored: errored > 0 ? errored : undefined,
			};
		}

		return {
			parser: "pytest",
			failure_type: errors.some((e) => e.error_type === "CollectionError")
				? "build_error"
				: "test_failure",
			errors,
			test_summary,
		};
	},
};
