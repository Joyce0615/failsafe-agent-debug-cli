import type { ParsedError } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

// ─── ESLint Parser ───────────────────────────────────────────────────────────

export const eslintParser: FailureParser = {
	name: "eslint",

	detect(stdout: string, stderr: string, command: string): boolean {
		if (/\beslint\b/.test(command)) return true;
		const combined = `${stdout}\n${stderr}`;
		// ESLint default formatter outputs problems summary
		if (/\u2716\s+\d+\s+problems?/.test(combined)) return true;
		// Or the standard line format with rule names
		if (/^\s+\d+:\d+\s+(?:error|warning)\s+.+\s+\S+$/m.test(combined)) return true;
		return false;
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];
		const lines = combined.split("\n");

		let currentFile: string | undefined;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// File path line: non-indented, typically an absolute or relative path
			// ESLint default formatter shows file path on its own line with no indent
			// Usually starts with / or ./ or a drive letter, or just a path
			if (
				!trimmed.startsWith(" ") &&
				trimmed.length > 0 &&
				!trimmed.match(/^\d+:\d+/) &&
				!trimmed.startsWith("\u2716") && // ✖
				(trimmed.includes("/") || trimmed.includes("\\")) &&
				!trimmed.includes("  ") // exclude formatted error lines
			) {
				currentFile = trimmed;
				continue;
			}

			// Error/warning line: "  line:col  error  message  rule-name"
			const errorLineMatch = trimmed.match(/^(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)$/);
			if (errorLineMatch) {
				const lineNum = Number.parseInt(errorLineMatch[1], 10);
				const col = Number.parseInt(errorLineMatch[2], 10);
				const severity = errorLineMatch[3];
				const message = errorLineMatch[4].trim();
				const ruleName = errorLineMatch[5];

				if (severity === "error") {
					errors.push({
						message: `${message} (${ruleName})`,
						error_type: ruleName,
						location: currentFile ? { file: currentFile, line: lineNum, column: col } : undefined,
					});
				}
				continue;
			}

			// Also handle: "line:col  error  message" (without rule name)
			const errorNoRule = trimmed.match(/^(\d+):(\d+)\s+(error|warning)\s+(.+)$/);
			if (errorNoRule && errorNoRule[3] === "error") {
				const lineNum = Number.parseInt(errorNoRule[1], 10);
				const col = Number.parseInt(errorNoRule[2], 10);
				const message = errorNoRule[4].trim();

				errors.push({
					message,
					location: currentFile ? { file: currentFile, line: lineNum, column: col } : undefined,
				});
			}
		}

		// Extract summary: "✖ N problems (X errors, Y warnings)"
		let test_summary: ParserResult["test_summary"] | undefined;
		const summaryMatch = combined.match(
			/\u2716\s+(\d+)\s+problems?\s+\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/,
		);
		if (summaryMatch) {
			const total = Number.parseInt(summaryMatch[1], 10);
			const errorCount = Number.parseInt(summaryMatch[2], 10);
			test_summary = {
				total,
				passed: 0,
				failed: errorCount,
				skipped: 0,
			};
		}

		// Also handle: "X errors and Y warnings found." or "X problems" without parens
		if (!test_summary) {
			const altSummary = combined.match(/(\d+)\s+errors?\s+and\s+(\d+)\s+warnings?\s+found/);
			if (altSummary) {
				const errorCount = Number.parseInt(altSummary[1], 10);
				const warnCount = Number.parseInt(altSummary[2], 10);
				test_summary = {
					total: errorCount + warnCount,
					passed: 0,
					failed: errorCount,
					skipped: 0,
				};
			}
		}

		return {
			parser: "eslint",
			failure_type: "lint_error",
			errors,
			test_summary,
		};
	},
};

// ─── Biome Parser ────────────────────────────────────────────────────────────

export const biomeParser: FailureParser = {
	name: "biome",

	detect(stdout: string, stderr: string, command: string): boolean {
		if (/\bbiome\b/.test(command)) return true;
		const combined = `${stdout}\n${stderr}`;
		// Biome diagnostic header format
		if (/^\s*(?:×|✖)\s+.+$/m.test(combined) && /\.(?:ts|js|tsx|jsx):\d+:\d+/.test(combined))
			return true;
		// Biome lint rule format: lint/category/ruleName
		if (/lint\/\w+\/\w+/.test(combined)) return true;
		return false;
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// Biome diagnostic format (modern):
		// file.ts:line:col lint/category/rule ━━━━━━━━━━━━━━━━━━━━
		//   × message
		//
		//   > line | code
		//
		// Or Biome diagnostic format (with file location on separate line):
		// file.ts:line:col
		//   × message
		//     lint/category/rule

		// Pattern 1: "file:line:col lint/category/rule ━━"
		const diagnosticRegex = /^(.+?):(\d+):(\d+)\s+(lint\/\w+\/\w+)\s*(?:━+)?/gm;
		let diagMatch: RegExpExecArray | null;

		while ((diagMatch = diagnosticRegex.exec(combined)) !== null) {
			const file = diagMatch[1].trim();
			const line = Number.parseInt(diagMatch[2], 10);
			const col = Number.parseInt(diagMatch[3], 10);
			const ruleName = diagMatch[4];

			// Find the diagnostic message on the next line(s)
			const afterDiag = combined.slice(diagMatch.index + diagMatch[0].length);
			const msgMatch = afterDiag.match(/\n\s*(?:×|✖)\s+(.+)/);
			const message = msgMatch ? msgMatch[1].trim() : ruleName;

			errors.push({
				message: `${message} (${ruleName})`,
				error_type: ruleName,
				location: { file, line, column: col },
			});
		}

		// Pattern 2: Lines like "× message" followed by file info
		// Used when the format puts file info on a different line
		if (errors.length === 0) {
			const msgBlockRegex = /(?:×|✖)\s+(.+?)(?:\n[\s\S]*?)?(\S+?):(\d+):(\d+)/g;
			let msgBlock: RegExpExecArray | null;

			while ((msgBlock = msgBlockRegex.exec(combined)) !== null) {
				const message = msgBlock[1].trim();
				const file = msgBlock[2].trim();
				const line = Number.parseInt(msgBlock[3], 10);
				const col = Number.parseInt(msgBlock[4], 10);

				// Try to find the rule name nearby
				const nearbyText = combined.slice(
					Math.max(0, msgBlock.index - 200),
					msgBlock.index + msgBlock[0].length + 200,
				);
				const ruleMatch = nearbyText.match(/(lint\/\w+\/\w+)/);
				const ruleName = ruleMatch ? ruleMatch[1] : undefined;

				errors.push({
					message: ruleName ? `${message} (${ruleName})` : message,
					error_type: ruleName,
					location: { file, line, column: col },
				});
			}
		}

		// Pattern 3: Simple "file:line:col diagnostic" patterns
		if (errors.length === 0) {
			const simpleRegex = /^(.+?):(\d+):(\d+)\s+(?:×|✖|error)\s+(.+)/gm;
			let simpleMatch: RegExpExecArray | null;

			while ((simpleMatch = simpleRegex.exec(combined)) !== null) {
				errors.push({
					message: simpleMatch[4].trim(),
					location: {
						file: simpleMatch[1].trim(),
						line: Number.parseInt(simpleMatch[2], 10),
						column: Number.parseInt(simpleMatch[3], 10),
					},
				});
			}
		}

		// Extract summary
		let test_summary: ParserResult["test_summary"] | undefined;

		// Biome summary: "Found N errors."
		const foundMatch = combined.match(/Found\s+(\d+)\s+errors?/);
		if (foundMatch) {
			const total = Number.parseInt(foundMatch[1], 10);
			test_summary = {
				total,
				passed: 0,
				failed: total,
				skipped: 0,
			};
		}

		// Biome may also show: "Checked N file(s)"
		if (!test_summary) {
			const checkedMatch = combined.match(/Checked\s+(\d+)\s+files?/);
			if (checkedMatch && errors.length > 0) {
				test_summary = {
					total: errors.length,
					passed: 0,
					failed: errors.length,
					skipped: 0,
				};
			}
		}

		return {
			parser: "biome",
			failure_type: "lint_error",
			errors,
			test_summary,
		};
	},
};
