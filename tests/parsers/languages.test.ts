import { describe, expect, test } from "bun:test";
import { ALL_PARSERS } from "../../src/parsers/index.js";
import {
	LANGUAGE_CAPABILITIES,
	type Language,
	assessStack,
	coverageReport,
	isForeignBoundary,
	languageOf,
	orderMixedResults,
} from "../../src/parsers/languages.js";
import type { ParserResult } from "../../src/parsers/types.js";
import type { StackFrame } from "../../src/types/failure.js";

function frame(file: string, overrides: Partial<StackFrame> = {}): StackFrame {
	return { file, line: 1, is_application: true, ...overrides };
}

function result(parser: string, frames: StackFrame[], hasLocation = true): ParserResult {
	return {
		parser,
		failure_type: "runtime_exception",
		errors: [
			{
				message: "boom",
				...(hasLocation && frames[0] ? { location: { file: frames[0].file, line: 1 } } : {}),
				...(frames.length > 0 ? { stack_frames: frames } : {}),
			},
		],
	};
}

describe("the capability matrix states its gaps", () => {
	test("every language declares at least one gap", () => {
		for (const capability of Object.values(LANGUAGE_CAPABILITIES)) {
			expect(capability.gaps.length).toBeGreaterThan(0);
		}
	});

	test("no language claims full capability on every axis", () => {
		for (const capability of Object.values(LANGUAGE_CAPABILITIES)) {
			const axes = [
				capability.stack_traces,
				capability.locations,
				capability.ast_slices,
				capability.symbol_resolution,
			];
			expect(axes.every((a) => a === "full")).toBe(false);
		}
	});

	test("every declared parser exists in the registry", () => {
		const registered = new Set(ALL_PARSERS.map((p) => p.name));
		for (const capability of Object.values(LANGUAGE_CAPABILITIES)) {
			for (const parser of capability.parsers) {
				expect(registered.has(parser)).toBe(true);
			}
		}
	});

	test("hardware honestly reports having no stack traces at all", () => {
		expect(LANGUAGE_CAPABILITIES.hdl.stack_traces).toBe("none");
		expect(LANGUAGE_CAPABILITIES.hdl.gaps[0]).toContain("hardware has no call stack");
	});

	test("the coverage report separates universal capabilities from partial ones", () => {
		const report = coverageReport();
		expect(report.languages).toBe(Object.keys(LANGUAGE_CAPABILITIES).length);
		expect(report.partial.length).toBeGreaterThan(0);
		expect(report.stated_gaps).toBeGreaterThan(10);
		expect(report.summary).toContain("rather than discovered during an incident");
	});

	test("the report names which languages lack each partial capability", () => {
		const report = coverageReport();
		const ast = report.partial.find((p) => p.capability === "ast_slices")!;
		expect(ast.missing.length + ast.partial.length).toBeGreaterThan(0);
	});
});

describe("language detection", () => {
	test("extensions map to languages", () => {
		expect(languageOf("src/app.py")).toBe("python");
		expect(languageOf("src/app.ts")).toBe("typescript");
		expect(languageOf("src/lib.rs")).toBe("rust");
		expect(languageOf("main.go")).toBe("go");
		expect(languageOf("Main.java")).toBe("java");
		expect(languageOf("widget.cpp")).toBe("cpp");
		expect(languageOf("rtl/alu.v")).toBe("hdl");
	});

	test("an unknown or extensionless file is unknown, not guessed", () => {
		expect(languageOf("Makefile")).toBe("unknown");
		expect(languageOf("data.parquet")).toBe("unknown");
	});

	test("detection is case-insensitive on the extension", () => {
		expect(languageOf("Main.JAVA")).toBe("java");
	});
});

describe("foreign-function boundaries", () => {
	test("native library files are recognized as boundaries", () => {
		for (const file of [
			"lib/_speedups.cpython-311-x86_64-linux-gnu.so",
			"native/addon.node",
			"vendor/lib.dylib",
			"C:/lib/native.dll",
			"_lib.pyd",
		]) {
			expect(isForeignBoundary(frame(file))).toBe(true);
		}
	});

	test("runtime-reported native markers are recognized", () => {
		expect(isForeignBoundary(frame("[native code]"))).toBe(true);
		expect(isForeignBoundary(frame("<native>"))).toBe(true);
	});

	test("ordinary source files are not boundaries", () => {
		expect(isForeignBoundary(frame("src/app.py"))).toBe(false);
		expect(isForeignBoundary(frame("src/notes.dllist.ts"))).toBe(false);
	});
});

describe("mixed-language stack assessment", () => {
	test("a single-language stack names its innermost application frame", () => {
		const assessment = assessStack([
			result("python-traceback", [frame("src/handler.py"), frame("src/app.py")]),
		]);
		expect(assessment.mixed).toBe(false);
		expect(assessment.boundary_truncated).toBe(false);
		expect(assessment.origin?.file).toBe("src/handler.py");
	});

	test("a truncated stack refuses to name an origin", () => {
		// The binding is where the evidence ends, not where the defect is.
		const assessment = assessStack([
			result("python-traceback", [
				frame("src/bindings.py"),
				frame("lib/_engine.cpython-311.so"),
			]),
		]);
		expect(assessment.boundary_truncated).toBe(true);
		expect(assessment.origin).toBeNull();
		expect(assessment.boundary_frame?.file).toContain("_engine");
	});

	test("the truncation caveat says what the innermost frame actually means", () => {
		const assessment = assessStack([
			result("python-traceback", [frame("src/bindings.py"), frame("lib/_engine.so")]),
		]);
		expect(assessment.caveats[0]).toContain("where the evidence ends rather than where the defect is");
	});

	test("two languages are detected and the inferred ordering is disclaimed", () => {
		const assessment = assessStack([
			result("python-traceback", [frame("src/app.py")]),
			result("rust", [frame("src/lib.rs")]),
		]);
		expect(assessment.mixed).toBe(true);
		expect(assessment.languages).toEqual(["python", "rust"]);
		expect(assessment.caveats.some((c) => c.includes("inferred rather than observed"))).toBe(true);
	});

	test("gaps for every language present are surfaced up front", () => {
		const assessment = assessStack([
			result("python-traceback", [frame("src/app.py")]),
			result("go-test", [frame("main.go")]),
		]);
		expect(assessment.gaps.map((g) => g.language).sort()).toEqual(["go", "python"]);
		expect(assessment.gaps.every((g) => g.gaps.length > 0)).toBe(true);
	});

	test("languages are picked up from locations as well as frames", () => {
		const assessment = assessStack([
			{
				parser: "rtl-compiler",
				failure_type: "build_error",
				errors: [{ message: "x", location: { file: "rtl/alu.v", line: 3 } }],
			},
		]);
		expect(assessment.languages).toEqual(["hdl"]);
	});

	test("unrecognized files leave the assessment empty and say so", () => {
		const assessment = assessStack([result("drain-template", [frame("Makefile")])]);
		expect(assessment.languages).toEqual([]);
		expect(assessment.caveats.some((c) => c.includes("no recognized language"))).toBe(true);
	});

	test("a non-application frame is not chosen as the origin", () => {
		const assessment = assessStack([
			result("python-traceback", [
				frame("site-packages/lib.py", { is_application: false }),
				frame("src/app.py"),
			]),
		]);
		expect(assessment.origin?.file).toBe("src/app.py");
	});

	test("no frames at all yields a null origin rather than an invented one", () => {
		const assessment = assessStack([result("drain-template", [], false)]);
		expect(assessment.origin).toBeNull();
	});
});

describe("ordering mixed results", () => {
	test("results with frames come before results with only a location", () => {
		const withFrames = result("python-traceback", [frame("src/app.py")]);
		const locationOnly: ParserResult = {
			parser: "rtl-compiler",
			failure_type: "build_error",
			errors: [{ message: "x", location: { file: "a.v", line: 1 } }],
		};
		const bare: ParserResult = {
			parser: "drain-template",
			failure_type: "unknown",
			errors: [{ message: "x" }],
		};
		const ordered = orderMixedResults([bare, locationOnly, withFrames]);
		expect(ordered.map((r) => r.parser)).toEqual([
			"python-traceback",
			"rtl-compiler",
			"drain-template",
		]);
	});

	test("ordering is deterministic when quality ties", () => {
		const a = result("aaa", [frame("a.py")]);
		const b = result("bbb", [frame("b.py")]);
		expect(orderMixedResults([b, a]).map((r) => r.parser)).toEqual(["aaa", "bbb"]);
	});

	test("the input is not mutated", () => {
		const input = [result("bbb", []), result("aaa", [frame("a.py")])];
		orderMixedResults(input);
		expect(input[0].parser).toBe("bbb");
	});

	test("an empty input orders to nothing", () => {
		expect(orderMixedResults([])).toEqual([]);
	});
});

describe("the seven headline languages are all present", () => {
	test("each is declared with parsers and extensions", () => {
		const headline: Language[] = ["python", "typescript", "rust", "go", "java", "cpp"];
		for (const language of headline) {
			const capability = LANGUAGE_CAPABILITIES[language as Exclude<Language, "unknown">];
			expect(capability.parsers.length).toBeGreaterThan(0);
			expect(capability.extensions.length).toBeGreaterThan(0);
		}
	});
});
