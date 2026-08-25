/**
 * RTL / hardware-description-language parsers (item 54).
 *
 * Hardware flows fail across artifacts that have no software analogue: an
 * elaboration error in Verilog, a lint warning that is actually a bug (a width
 * mismatch silently truncating a bus), a SystemVerilog assertion firing at a
 * simulation timestamp, a UVM scoreboard mismatch reported by a testbench that
 * is itself HDL. Failsafe already compresses software failures; these two
 * parsers put hardware output into the same `ParserResult` contract so
 * everything downstream — evidence, localization, the diagnosis packet — works
 * unchanged.
 *
 * The design constraint that matters more than the parsing is the one in the
 * item text: *do not weaken the existing software-language parser contracts*.
 * Two rules enforce it:
 *
 * 1. **Every location pattern is anchored on an HDL file extension**
 *    (`.v`, `.sv`, `.vh`, `.svh`, `.vhd`, `.vhdl`). A gcc diagnostic and an
 *    Icarus diagnostic are the same shape — `file:line: error: message` — and
 *    the only thing that distinguishes them is the file. Matching the shape
 *    alone would make this parser fire on every C build in the corpus.
 *
 * 2. **These parsers are appended after the software parsers** in the registry
 *    and never claim a result with zero errors, so precedence for mixed output
 *    is unchanged. `tests/parsers/rtl.test.ts` asserts the existing corpus
 *    parses identically with them registered.
 */
import type { ParsedError, TestSummary } from "../types/failure.js";
import type { FailureParser, ParserResult } from "./types.js";

/** HDL source extensions. Anchoring on these is what keeps C/C++ output out. */
const HDL_EXT = String.raw`\.(?:sv|svh|vh|vhdl|vhd|v)`;

/** `%Error-WIDTH: path/alu.v:23:10: message` (Verilator). */
const VERILATOR_RE = new RegExp(
	String.raw`^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s+([\w./+-]+${HDL_EXT}):(\d+):(?:(\d+):)?\s*(.*)$`,
);

/** `alu.v:23: error: message` / `alu.v:23: syntax error` (Icarus, vlog, xvlog). */
const ICARUS_RE = new RegExp(
	String.raw`^([\w./+-]+${HDL_EXT}):(\d+):\s*(?:(error|warning|fatal)\s*:\s*)?(.*)$`,
	"i",
);

/** Tool invocations that mean the output is HDL even before we look at it. */
const HDL_COMMANDS = /\b(verilator|iverilog|vvp|vlog|vsim|xvlog|xelab|xsim|vcs|yosys|ghdl)\b/;

function isBlank(value: string | undefined): boolean {
	return value === undefined || value.trim().length === 0;
}

/**
 * Verilator / Icarus / vlog compile-and-elaborate diagnostics.
 *
 * A Verilator `%Warning-WIDTH` is reported as a `lint_error` rather than being
 * dropped: in hardware a width mismatch is not style advice, it is a bus being
 * silently truncated, and it is one of the most common real defects in the
 * corpus. Only `%Error` produces `build_error`.
 */
export const rtlCompilerParser: FailureParser = {
	name: "rtl-compiler",

	detect(stdout: string, stderr: string, command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		if (HDL_COMMANDS.test(command)) return true;
		if (/^%(Error|Warning)/m.test(combined)) return true;
		// Anchored on the HDL extension: the same shape from gcc must not match.
		return new RegExp(String.raw`^[\w./+-]+${HDL_EXT}:\d+:`, "m").test(combined);
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const errors: ParsedError[] = [];
		let sawError = false;
		let sawWarningOnly = false;

		for (const line of combined.split("\n")) {
			const verilator = line.match(VERILATOR_RE);
			if (verilator) {
				const [, severity, code, file, lineNo, column, message] = verilator;
				if (severity === "Error") sawError = true;
				else sawWarningOnly = true;
				errors.push({
					message: message.trim(),
					// The Verilator sub-code (WIDTH, UNUSED, CASEINCOMPLETE, …) is the
					// most useful classifier the tool emits and is kept verbatim.
					error_type: code ? `Verilator${severity}-${code}` : `Verilator${severity}`,
					location: {
						file,
						line: Number.parseInt(lineNo, 10),
						...(column ? { column: Number.parseInt(column, 10) } : {}),
					},
				});
				continue;
			}

			const icarus = line.match(ICARUS_RE);
			if (icarus) {
				const [, file, lineNo, severity, message] = icarus;
				// A bare `file.v:23:` with nothing after it is a continuation
				// artifact, not a diagnostic. Emitting it would manufacture an
				// error with no message.
				if (isBlank(message)) continue;
				const kind = (severity ?? "error").toLowerCase();
				if (kind === "warning") sawWarningOnly = true;
				else sawError = true;
				errors.push({
					message: message.trim(),
					error_type: kind === "warning" ? "HdlWarning" : "HdlError",
					location: { file, line: Number.parseInt(lineNo, 10) },
				});
			}
		}

		return {
			parser: "rtl-compiler",
			// Errors dominate: a run with both is a build failure, and a run with
			// only warnings is still worth surfacing because in RTL a warning is
			// frequently the defect itself.
			failure_type: sawError ? "build_error" : sawWarningOnly ? "lint_error" : "unknown",
			errors,
		};
	},
};

/** `UVM_ERROR tb/env.sv(120) @ 1500: uvm_test_top.env.scb [SCB] message`. */
const UVM_RE = new RegExp(
	String.raw`^UVM_(ERROR|FATAL|WARNING)\s+([\w./+-]+${HDL_EXT})\((\d+)\)\s*@\s*(\d+)\s*:\s*(\S+)\s*(?:\[([^\]]*)\])?\s*(.*)$`,
);

/** `"tb/top.sv", 88: tb.top.check_reset: started at 120ns failed at 120ns`. */
const SVA_RE = new RegExp(
	String.raw`^"([\w./+-]+${HDL_EXT})",\s*(\d+):\s*([\w.$]+):\s*started at (\S+?) failed at (\S+)$`,
);

/** UVM's own end-of-run tally: `UVM_ERROR : 3`. */
const UVM_TALLY_RE = /^UVM_(ERROR|FATAL|WARNING)\s*:\s*(\d+)$/;

/**
 * Simulation-time failures: SystemVerilog assertions and UVM reports.
 *
 * The simulation timestamp is preserved in the message rather than discarded,
 * because in a hardware failure "when" is frequently the whole diagnosis — the
 * same assertion firing at time 0 and at time 120ns are a reset-polarity bug
 * and a protocol bug respectively.
 */
export const hdlSimulationParser: FailureParser = {
	name: "hdl-simulation",

	detect(stdout: string, stderr: string, _command: string): boolean {
		const combined = `${stdout}\n${stderr}`;
		return /^UVM_(ERROR|FATAL)/m.test(combined) || SVA_RE.test(combined) || hasSva(combined);
	},

	parse(stdout: string, stderr: string, _command: string): ParserResult {
		const combined = `${stdout}\n${stderr}`;
		const lines = combined.split("\n");
		const errors: ParsedError[] = [];
		let failed = 0;
		let tallied = false;

		for (const [i, line] of lines.entries()) {
			const uvm = line.match(UVM_RE);
			if (uvm) {
				const [, severity, file, lineNo, time, scope, tag, message] = uvm;
				if (severity !== "WARNING") failed++;
				errors.push({
					message: `${message.trim()} (at ${time})`,
					error_type: `UVM_${severity}`,
					location: { file, line: Number.parseInt(lineNo, 10), symbol: scope },
					test_name: tag && tag.length > 0 ? tag : scope,
					...assertionDiff(message),
				});
				continue;
			}

			const sva = line.match(SVA_RE);
			if (sva) {
				const [, file, lineNo, name, started, failedAt] = sva;
				failed++;
				// The offending expression is printed on the following line by
				// every simulator that prints it at all.
				const offending = lines[i + 1]?.match(/^\s*Offending\s+'(.+)'\s*$/);
				errors.push({
					message: offending
						? `assertion ${name} failed at ${failedAt}: ${offending[1]}`
						: `assertion ${name} started at ${started}, failed at ${failedAt}`,
					error_type: "SVAssertionFailure",
					location: { file, line: Number.parseInt(lineNo, 10), symbol: name },
					test_name: name,
				});
				continue;
			}

			const tally = line.match(UVM_TALLY_RE);
			if (tally && tally[1] !== "WARNING") {
				// The simulator's own count is authoritative and supersedes ours:
				// a run can print more report lines than it counts as failures.
				failed = Math.max(failed, Number.parseInt(tally[2], 10));
				tallied = true;
			}
		}

		const test_summary: TestSummary | undefined =
			failed > 0 || tallied ? { total: failed, passed: 0, failed, skipped: 0 } : undefined;

		return {
			parser: "hdl-simulation",
			failure_type: "test_failure",
			errors,
			...(test_summary ? { test_summary } : {}),
		};
	},
};

function hasSva(combined: string): boolean {
	return combined.split("\n").some((line) => SVA_RE.test(line));
}

/**
 * Pull `expected X got Y` out of a scoreboard message.
 *
 * Deliberately narrow: only the two explicit spellings simulators actually
 * print. Guessing at a diff from arbitrary prose would put fabricated values
 * into the assertion-diff field, which agents read as ground truth.
 */
function assertionDiff(message: string): { assertion_diff?: ParsedError["assertion_diff"] } {
	const match =
		message.match(/expected\s+(\S+)\s*,?\s*(?:but\s+)?(?:got|actual|received)\s+(\S+)/i) ??
		message.match(/exp(?:ected)?\s*=\s*(\S+)\s+act(?:ual)?\s*=\s*(\S+)/i);
	if (!match) return {};
	return { assertion_diff: { expected: match[1], actual: match[2], operator: "===" } };
}
