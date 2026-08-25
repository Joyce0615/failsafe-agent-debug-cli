import { describe, expect, test } from "bun:test";
import { ALL_PARSERS, detectAndParse } from "../../src/parsers/index.js";
import { hdlSimulationParser, rtlCompilerParser } from "../../src/parsers/rtl.js";

describe("Verilator diagnostics", () => {
	const output = [
		"%Error: rtl/top.v:12:5: syntax error, unexpected ';'",
		"%Error-WIDTH: rtl/alu.v:23:10: Operator ASSIGNW expects 8 bits on the Assign RHS, but VARREF 'x' generates 4 bits.",
		"%Warning-UNUSED: rtl/top.v:5:8: Signal is not used: 'clk'",
		"%Error: Exiting due to 2 error(s)",
	].join("\n");

	test("detects on the %Error marker alone", () => {
		expect(rtlCompilerParser.detect(output, "", "make")).toBe(true);
	});

	test("detects on the tool name even before reading output", () => {
		expect(rtlCompilerParser.detect("", "", "verilator --lint-only top.v")).toBe(true);
		expect(rtlCompilerParser.detect("", "", "iverilog -o sim top.v")).toBe(true);
	});

	test("extracts file, line, and column", () => {
		const result = rtlCompilerParser.parse(output, "", "verilator");
		const first = result.errors[0];
		expect(first.location).toEqual({ file: "rtl/top.v", line: 12, column: 5 });
		expect(first.message).toContain("syntax error");
	});

	test("keeps the Verilator sub-code, which is its most useful classifier", () => {
		const result = rtlCompilerParser.parse(output, "", "verilator");
		expect(result.errors[1].error_type).toBe("VerilatorError-WIDTH");
		expect(result.errors[2].error_type).toBe("VerilatorWarning-UNUSED");
	});

	test("a run with any error is a build_error", () => {
		expect(rtlCompilerParser.parse(output, "", "verilator").failure_type).toBe("build_error");
	});

	test("a warning-only run is a lint_error, not discarded", () => {
		// In RTL a width warning is a bus being silently truncated, not style advice.
		const warnings = "%Warning-WIDTH: rtl/alu.v:9:3: Bit extraction of x[7:0] requires 8 bits.";
		const result = rtlCompilerParser.parse(warnings, "", "verilator");
		expect(result.failure_type).toBe("lint_error");
		expect(result.errors).toHaveLength(1);
	});

	test("the summary line without a location produces no phantom error", () => {
		const result = rtlCompilerParser.parse(output, "", "verilator");
		expect(result.errors.every((e) => e.location !== undefined)).toBe(true);
		expect(result.errors).toHaveLength(3);
	});
});

describe("Icarus / vlog diagnostics", () => {
	test("parses the file:line: error: form", () => {
		const output = "rtl/alu.v:23: error: Unknown module type: adder8";
		expect(rtlCompilerParser.detect(output, "", "iverilog")).toBe(true);
		const result = rtlCompilerParser.parse(output, "", "iverilog");
		expect(result.errors[0].location).toEqual({ file: "rtl/alu.v", line: 23 });
		expect(result.errors[0].message).toBe("Unknown module type: adder8");
		expect(result.failure_type).toBe("build_error");
	});

	test("a severity-less diagnostic is treated as an error, not dropped", () => {
		const result = rtlCompilerParser.parse("rtl/alu.v:23: syntax error", "", "iverilog");
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error_type).toBe("HdlError");
	});

	test("a bare file:line: with no message is not turned into an error", () => {
		const result = rtlCompilerParser.parse("rtl/alu.v:23:   ", "", "iverilog");
		expect(result.errors).toHaveLength(0);
	});

	test("SystemVerilog and VHDL extensions are recognized", () => {
		for (const file of ["tb/env.sv", "pkg/types.svh", "rtl/fifo.vhd", "rtl/fifo.vhdl"]) {
			const result = rtlCompilerParser.parse(`${file}:7: error: boom`, "", "vlog");
			expect(result.errors[0].location?.file).toBe(file);
		}
	});
});

describe("the software parser contracts are not weakened", () => {
	test("a gcc diagnostic of the identical shape does not match the RTL parser", () => {
		const gcc = "src/main.c:23: error: expected ';' before '}' token";
		expect(rtlCompilerParser.detect(gcc, "", "make")).toBe(false);
	});

	test("a C++ template error is not claimed by the RTL parser", () => {
		const cpp = [
			"src/widget.cpp:14:22: error: no matching function for call to 'foo'",
			"src/widget.cpp:14:22: note: candidate expects 2 arguments",
		].join("\n");
		expect(rtlCompilerParser.detect(cpp, "", "g++ -c widget.cpp")).toBe(false);
	});

	test("a Python traceback still yields exactly its own parser", () => {
		const traceback = [
			"Traceback (most recent call last):",
			'  File "app/handler.py", line 42, in process',
			"    return payload['email']",
			"KeyError: 'email'",
		].join("\n");
		const results = detectAndParse(traceback, "", "python app.py");
		expect(results.map((r) => r.parser)).not.toContain("rtl-compiler");
		expect(results.map((r) => r.parser)).not.toContain("hdl-simulation");
		expect(results.length).toBeGreaterThan(0);
	});

	test("a jest failure is unaffected by the new parsers", () => {
		const jest = [
			"  ● renders › shows the title",
			"    expect(received).toBe(expected)",
			"      at Object.<anonymous> (src/App.test.js:12:20)",
			"Tests:       1 failed, 2 passed, 3 total",
		].join("\n");
		const results = detectAndParse(jest, "", "npx jest");
		expect(results.every((r) => !r.parser.startsWith("rtl") && r.parser !== "hdl-simulation")).toBe(
			true,
		);
	});

	test("the HDL parsers are registered last so existing precedence is unchanged", () => {
		const names = ALL_PARSERS.map((p) => p.name);
		expect(names.slice(-2)).toEqual(["hdl-simulation", "rtl-compiler"]);
		expect(names.indexOf("pytest")).toBeLessThan(names.indexOf("rtl-compiler"));
	});

	test("a .v path inside otherwise-software output does not hijack the primary result", () => {
		const mixed = [
			"Traceback (most recent call last):",
			'  File "gen.py", line 3, in <module>',
			"RuntimeError: generation failed",
			"rtl/out.v:1: error: empty module",
		].join("\n");
		const results = detectAndParse(mixed, "", "python gen.py");
		expect(results[0].parser).not.toBe("rtl-compiler");
		// The RTL error is still surfaced, just not as the primary.
		expect(results.some((r) => r.parser === "rtl-compiler")).toBe(true);
	});
});

describe("UVM reports", () => {
	const output = [
		"UVM_ERROR tb/env/scoreboard.sv(120) @ 1500: uvm_test_top.env.scb [SCB] Mismatch: expected 8'hA5 got 8'h5A",
		"UVM_FATAL tb/env/driver.sv(88) @ 1600: uvm_test_top.env.drv [DRV] Reset asserted mid-transaction",
		"UVM_ERROR :    2",
	].join("\n");

	test("detects and extracts scope, file, line, and time", () => {
		expect(hdlSimulationParser.detect(output, "", "vsim")).toBe(true);
		const result = hdlSimulationParser.parse(output, "", "vsim");
		expect(result.errors[0].location).toEqual({
			file: "tb/env/scoreboard.sv",
			line: 120,
			symbol: "uvm_test_top.env.scb",
		});
		expect(result.errors[0].error_type).toBe("UVM_ERROR");
		expect(result.errors[0].test_name).toBe("SCB");
	});

	test("the simulation timestamp is preserved, because when is often the diagnosis", () => {
		const result = hdlSimulationParser.parse(output, "", "vsim");
		expect(result.errors[0].message).toContain("1500");
		expect(result.errors[1].message).toContain("1600");
	});

	test("an expected/got scoreboard message becomes an assertion diff", () => {
		const result = hdlSimulationParser.parse(output, "", "vsim");
		expect(result.errors[0].assertion_diff).toEqual({
			expected: "8'hA5",
			actual: "8'h5A",
			operator: "===",
		});
	});

	test("prose that merely mentions a value is not turned into a diff", () => {
		const prose =
			"UVM_ERROR tb/env.sv(1) @ 0: uvm_test_top [X] the expected behaviour never occurred";
		const result = hdlSimulationParser.parse(prose, "", "vsim");
		expect(result.errors[0].assertion_diff).toBeUndefined();
	});

	test("the simulator's own tally supersedes our count", () => {
		const underCounted = ["UVM_ERROR tb/a.sv(1) @ 0: top [T] boom", "UVM_ERROR :    9"].join("\n");
		expect(hdlSimulationParser.parse(underCounted, "", "vsim").test_summary?.failed).toBe(9);
	});

	test("UVM_WARNING does not count as a failure", () => {
		const warn = "UVM_WARNING tb/a.sv(1) @ 0: top [T] slow response";
		const result = hdlSimulationParser.parse(warn, "", "vsim");
		expect(result.test_summary).toBeUndefined();
		expect(result.errors).toHaveLength(1);
	});
});

describe("SystemVerilog assertions", () => {
	const output = [
		'"tb/top.sv", 88: tb.top.check_reset: started at 120ns failed at 120ns',
		"\tOffending '(rst_n == 1'b1)'",
	].join("\n");

	test("detects and extracts the assertion name and location", () => {
		expect(hdlSimulationParser.detect(output, "", "xsim")).toBe(true);
		const result = hdlSimulationParser.parse(output, "", "xsim");
		expect(result.errors[0].location).toEqual({
			file: "tb/top.sv",
			line: 88,
			symbol: "tb.top.check_reset",
		});
		expect(result.errors[0].test_name).toBe("tb.top.check_reset");
	});

	test("the offending expression is folded into the message when printed", () => {
		expect(hdlSimulationParser.parse(output, "", "xsim").errors[0].message).toContain(
			"(rst_n == 1'b1)",
		);
	});

	test("an assertion with no offending line still yields a usable message", () => {
		const bare = '"tb/top.sv", 88: tb.top.check_reset: started at 0ns failed at 40ns';
		const result = hdlSimulationParser.parse(bare, "", "xsim");
		expect(result.errors[0].message).toContain("failed at 40ns");
		expect(result.test_summary?.failed).toBe(1);
	});

	test("the failure type is a test failure, not a build error", () => {
		expect(hdlSimulationParser.parse(output, "", "xsim").failure_type).toBe("test_failure");
	});
});

describe("registry integration", () => {
	test("a Verilator run flows through detectAndParse with a location", () => {
		const results = detectAndParse(
			"%Error-WIDTH: rtl/alu.v:23:10: RHS generates 4 bits, LHS expects 8",
			"",
			"verilator --lint-only rtl/alu.v",
		);
		const rtl = results.find((r) => r.parser === "rtl-compiler");
		expect(rtl?.errors[0].location?.file).toBe("rtl/alu.v");
	});

	test("a simulation run is preferred over the compiler parser for UVM output", () => {
		const results = detectAndParse(
			"UVM_ERROR tb/env.sv(120) @ 1500: uvm_test_top.env.scb [SCB] mismatch",
			"",
			"vsim -c top",
		);
		expect(results[0].parser).toBe("hdl-simulation");
	});

	test("output with no HDL content produces no HDL result", () => {
		const results = detectAndParse("all good", "", "echo hi");
		expect(results.filter((r) => r.parser.includes("hdl") || r.parser.includes("rtl"))).toEqual(
			[],
		);
	});
});
