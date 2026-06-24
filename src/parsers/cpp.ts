import type { ParsedError } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

/**
 * Parser for C/C++ compiler (gcc/clang) and linker diagnostics.
 *
 * Recognizes:
 *  - `file:line:col: error|fatal error: message` diagnostics (warnings/notes
 *    are detected but not surfaced as errors to keep the packet actionable).
 *  - Linker errors: `undefined reference to 'symbol'` and
 *    `ld returned N exit status`.
 *  - `make` aggregation lines (`make: *** [Makefile:5: all] Error 1`) used only
 *    for detection — the underlying compiler diagnostic carries the location.
 */
export const cppParser: FailureParser = {
	name: "cpp",

	detect(stdout: string, stderr: string, command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		const hasDiag =
			/^.+:\d+:\d+:\s+(?:fatal error|error):/m.test(combined) ||
			/undefined reference to /.test(combined) ||
			/\bld returned \d+ exit status/.test(combined);
		if (/(?:^|\s)(?:gcc|g\+\+|clang\+\+|clang|c\+\+|cc|make|cmake)(?:\s|$)/.test(command)) {
			return hasDiag || /^.+:\d+:\d+:\s+warning:/m.test(combined);
		}
		return hasDiag;
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];

		// Compiler diagnostics: file:line:col: error|fatal error: message
		const diagRegex = /^(.+?):(\d+):(\d+):\s+(fatal error|error):\s+(.+)$/gm;
		let dm: RegExpExecArray | null = diagRegex.exec(combined);
		while (dm !== null) {
			errors.push({
				message: dm[5].trim(),
				error_type: dm[4] === "fatal error" ? "FatalError" : "CompileError",
				location: {
					file: dm[1],
					line: Number.parseInt(dm[2], 10),
					column: Number.parseInt(dm[3], 10),
				},
			});
			dm = diagRegex.exec(combined);
		}

		// Linker: undefined reference to `symbol'
		const refRegex = /undefined reference to ['`]([^'`]+)'/g;
		let rm: RegExpExecArray | null = refRegex.exec(combined);
		while (rm !== null) {
			const symbol = rm[1];
			if (!errors.some((e) => e.message.includes(symbol))) {
				errors.push({
					message: `undefined reference to '${symbol}'`,
					error_type: "LinkError",
				});
			}
			rm = refRegex.exec(combined);
		}

		return {
			parser: "cpp",
			failure_type: "build_error",
			errors,
		};
	},
};
