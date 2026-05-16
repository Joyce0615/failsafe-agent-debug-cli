import type { ParsedError } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

export const tscParser: FailureParser = {
	name: "tsc",

	detect(stdout: string, stderr: string, command: string): boolean {
		if (/\btsc\b/.test(command)) return true;
		const combined = `${stdout}\n${stderr}`;
		// TypeScript error format: file(line,col): error TSxxxx: message
		return /\.tsx?\(\d+,\d+\):\s*error\s+TS\d+:/.test(combined);
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// Match: src/file.ts(10,5): error TS2345: Argument of type ...
		const errorRegex = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
		let match: RegExpExecArray | null;

		while ((match = errorRegex.exec(combined)) !== null) {
			const file = match[1].trim();
			const line = Number.parseInt(match[2], 10);
			const column = Number.parseInt(match[3], 10);
			const tsCode = match[4];
			const message = match[5].trim();

			errors.push({
				message: `${tsCode}: ${message}`,
				error_type: tsCode,
				location: { file, line, column },
			});
		}

		// Also handle the colon-separated format used by some configs:
		// src/file.ts:10:5 - error TS2345: message
		const altRegex = /^(.+?):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)$/gm;
		let altMatch: RegExpExecArray | null;

		while ((altMatch = altRegex.exec(combined)) !== null) {
			const file = altMatch[1].trim();
			const line = Number.parseInt(altMatch[2], 10);
			const column = Number.parseInt(altMatch[3], 10);
			const tsCode = altMatch[4];
			const message = altMatch[5].trim();

			// Avoid duplicates if both formats somehow appear
			const isDuplicate = errors.some(
				(e) => e.location?.file === file && e.location?.line === line && e.error_type === tsCode,
			);
			if (!isDuplicate) {
				errors.push({
					message: `${tsCode}: ${message}`,
					error_type: tsCode,
					location: { file, line, column },
				});
			}
		}

		// Extract total error count from "Found X error(s) in Y file(s)."
		let test_summary: ParserResult["test_summary"] | undefined;
		const totalMatch = combined.match(/Found\s+(\d+)\s+errors?\s*(?:in\s+\d+\s+files?)?/);
		if (totalMatch) {
			const total = Number.parseInt(totalMatch[1], 10);
			test_summary = {
				total,
				passed: 0,
				failed: total,
				skipped: 0,
			};
		}

		return {
			parser: "tsc",
			failure_type: "type_error",
			errors,
			test_summary,
		};
	},
};
