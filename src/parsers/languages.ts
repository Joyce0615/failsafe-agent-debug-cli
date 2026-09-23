/**
 * Language coverage and mixed-language stack handling (item 83).
 *
 * Failsafe has parsers for seven languages. "Supports seven languages" is the
 * kind of claim that is technically true and operationally misleading, because
 * support is not one thing: extracting a file and line from a Go panic is
 * routine, resolving a symbol through a C++ template instantiation is not, and
 * a user who discovers the difference during an incident has been misled by the
 * word "supported".
 *
 * This module therefore does two things.
 *
 * 1. **States the capability matrix, including the gaps.** Each language
 *    declares, per capability, what actually works, and `gaps` is a
 *    non-empty list for every entry — there is no language where everything
 *    works, and an entry claiming otherwise would be the first thing to
 *    disbelieve.
 *
 * 2. **Handles the mixed-language stack honestly.** A Python process calling a
 *    Rust extension produces a Python traceback that *stops at the boundary*
 *    and, separately, a native backtrace with no link to it. The innermost
 *    Python frame is not the origin; it is where the evidence ran out.
 *    `assessStack` detects the boundary, reports `boundary_truncated`, and
 *    refuses to name an origin it cannot see — which is the difference between
 *    "the bug is in `bindings.py:42`" and "the bug is somewhere past
 *    `bindings.py:42`, in code this trace does not cover".
 *
 * Pure: analysis over already-parsed results.
 */
import type { ParsedError, StackFrame } from "../types/failure.js";
import type { ParserResult } from "./types.js";

export const LANGUAGES = [
	"python",
	"typescript",
	"javascript",
	"rust",
	"go",
	"java",
	"cpp",
	"ruby",
	"hdl",
	"unknown",
] as const;
export type Language = (typeof LANGUAGES)[number];

export type CapabilityLevel = "full" | "partial" | "none";

export type LanguageCapability = {
	language: Language;
	extensions: string[];
	/** Parser names in the registry that handle this language. */
	parsers: string[];
	/** Can a stack trace be recovered from the output? */
	stack_traces: CapabilityLevel;
	/** Can a file/line be extracted for the failing frame? */
	locations: CapabilityLevel;
	/** Can an AST-aware source slice be produced (item 29)? */
	ast_slices: CapabilityLevel;
	/** Can a symbol be resolved to a definition? */
	symbol_resolution: CapabilityLevel;
	/**
	 * What does not work. Never empty: a language with no stated gaps is a
	 * language nobody has looked at closely.
	 */
	gaps: string[];
};

export const LANGUAGE_CAPABILITIES: Record<Exclude<Language, "unknown">, LanguageCapability> = {
	python: {
		language: "python",
		extensions: [".py", ".pyi", ".pyx"],
		parsers: ["pytest", "python-traceback"],
		stack_traces: "full",
		locations: "full",
		ast_slices: "partial",
		symbol_resolution: "partial",
		gaps: [
			"a traceback stops at a C-extension boundary; frames beyond it are absent, not empty",
			"decorators and metaclasses can make the reported function differ from the source symbol",
			"`exec`/`eval` frames have no resolvable file",
		],
	},
	typescript: {
		language: "typescript",
		extensions: [".ts", ".tsx", ".mts", ".cts"],
		parsers: ["tsc", "jest", "vitest", "mocha", "eslint", "biome"],
		stack_traces: "partial",
		locations: "full",
		ast_slices: "partial",
		symbol_resolution: "partial",
		gaps: [
			"stack frames point at emitted JavaScript unless a source map is present and readable",
			"a `.d.ts` location has no runtime counterpart to inspect",
			"type errors report the position of the assignment, not of the incompatible definition",
		],
	},
	javascript: {
		language: "javascript",
		extensions: [".js", ".mjs", ".cjs", ".jsx"],
		parsers: ["jest", "vitest", "mocha", "js-stack", "eslint", "biome"],
		stack_traces: "full",
		locations: "full",
		ast_slices: "partial",
		symbol_resolution: "none",
		gaps: [
			"bundled and minified frames resolve to the bundle, not the source",
			"async stack traces are truncated at the await boundary in older runtimes",
			"no symbol resolution: dynamic property access cannot be followed statically",
		],
	},
	rust: {
		language: "rust",
		extensions: [".rs"],
		parsers: ["rust"],
		stack_traces: "partial",
		locations: "full",
		ast_slices: "none",
		symbol_resolution: "none",
		gaps: [
			"a backtrace requires `RUST_BACKTRACE`; without it a panic reports one location and no chain",
			"macro-expanded code reports the macro's location, not the invocation's",
			"no AST slicing: the source of an inlined generic is not recoverable from the trace",
		],
	},
	go: {
		language: "go",
		extensions: [".go"],
		parsers: ["go-test"],
		stack_traces: "full",
		locations: "full",
		ast_slices: "none",
		symbol_resolution: "none",
		gaps: [
			"a panic in one goroutine prints every goroutine; the failing one is not always first",
			"cgo frames appear as opaque addresses",
			"table-driven subtests report the parent test's file for the assertion",
		],
	},
	java: {
		language: "java",
		extensions: [".java", ".kt", ".scala"],
		parsers: ["java"],
		stack_traces: "full",
		locations: "partial",
		ast_slices: "none",
		symbol_resolution: "none",
		gaps: [
			"a frame gives a class and line but not a path; mapping to a file requires the source layout",
			"lambda and synthetic frames have generated names that do not appear in the source",
			"a `Caused by` chain can be truncated by the runtime's frame limit",
		],
	},
	cpp: {
		language: "cpp",
		extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"],
		parsers: ["cpp"],
		stack_traces: "partial",
		locations: "full",
		ast_slices: "none",
		symbol_resolution: "none",
		gaps: [
			"a template instantiation error reports the instantiation site and the definition, and which one is the defect is not determinable from the message",
			"optimized builds inline frames out of existence",
			"a crash without a debugger produces addresses, not symbols",
		],
	},
	ruby: {
		language: "ruby",
		extensions: [".rb", ".rake"],
		parsers: ["ruby"],
		stack_traces: "full",
		locations: "full",
		ast_slices: "none",
		symbol_resolution: "none",
		gaps: [
			"`method_missing` and `define_method` frames name the defining site, not the call",
			"a gem frame's path depends on the installation layout and may not exist locally",
		],
	},
	hdl: {
		language: "hdl",
		extensions: [".v", ".sv", ".vh", ".svh", ".vhd", ".vhdl"],
		parsers: ["rtl-compiler", "hdl-simulation"],
		stack_traces: "none",
		locations: "full",
		ast_slices: "none",
		symbol_resolution: "none",
		gaps: [
			"hardware has no call stack; the instance path is the closest analogue and is not a trace",
			"a simulation failure's location is where the assertion sits, not where the signal was driven",
			"elaboration errors can report a generated module name with no source file",
		],
	},
};

/** Language of a file, from its extension. */
export function languageOf(file: string): Language {
	const dot = file.lastIndexOf(".");
	if (dot < 0) return "unknown";
	const extension = file.slice(dot).toLowerCase();
	for (const capability of Object.values(LANGUAGE_CAPABILITIES)) {
		if (capability.extensions.includes(extension)) return capability.language;
	}
	return "unknown";
}

/**
 * Markers that a frame sits at a foreign-function boundary.
 *
 * Matched on the file rather than the symbol because the symbol is frequently
 * the *caller's* name — `lib.query()` tells you nothing, `_lib.cpython-311.so`
 * tells you the trace is about to stop.
 */
const FFI_MARKERS = [
	/\.so(\.\d+)*$/,
	/\.dylib$/,
	/\.dll$/,
	/\.pyd$/,
	/\.node$/,
	/(^|\/)ctypes\//,
	/(^|\/)cffi/,
	/_cgo_/,
	/(^|\/)jni/i,
	/(^|\/)napi/i,
	/<native>/,
	/\[native code\]/,
];

export function isForeignBoundary(frame: StackFrame): boolean {
	return FFI_MARKERS.some((marker) => marker.test(frame.file));
}

export type StackAssessment = {
	/** Languages appearing anywhere in the parsed results. */
	languages: Language[];
	/** True when more than one language is present. */
	mixed: boolean;
	/**
	 * True when a frame sits at a foreign-function boundary, meaning the trace
	 * stops there and the frames beyond it were never captured.
	 */
	boundary_truncated: boolean;
	/** The boundary frame, when there is one. */
	boundary_frame?: StackFrame;
	/**
	 * The innermost frame that can be treated as the origin, or `null` when the
	 * trace is truncated and the origin lies beyond it.
	 */
	origin: StackFrame | null;
	/** Capability gaps for every language present, so they are visible up front. */
	gaps: Array<{ language: Language; gaps: string[] }>;
	caveats: string[];
};

function framesOf(results: ParserResult[]): StackFrame[] {
	const frames: StackFrame[] = [];
	for (const result of results) {
		for (const error of result.errors) {
			for (const frame of error.stack_frames ?? []) frames.push(frame);
		}
	}
	return frames;
}

function locationsOf(results: ParserResult[]): ParsedError["location"][] {
	return results.flatMap((r) => r.errors.map((e) => e.location)).filter(Boolean);
}

/**
 * Assess a parsed failure that may cross language boundaries.
 *
 * The load-bearing rule: when a foreign-function boundary is present the origin
 * is `null`, not the frame before it. Naming that frame would assert that the
 * bug is in the binding code, which is occasionally true and usually the one
 * place it is not — the binding is where the evidence ends, not where the
 * defect is.
 */
export function assessStack(results: ParserResult[]): StackAssessment {
	const frames = framesOf(results);
	const languages = new Set<Language>();

	for (const frame of frames) languages.add(languageOf(frame.file));
	for (const location of locationsOf(results)) {
		if (location?.file) languages.add(languageOf(location.file));
	}
	languages.delete("unknown");

	const boundary = frames.find(isForeignBoundary);
	const applicationFrames = frames.filter((f) => f.is_application && !isForeignBoundary(f));
	const present = [...languages].sort();

	const caveats: string[] = [];
	if (boundary) {
		caveats.push(
			`the trace reaches a foreign-function boundary at '${boundary.file}' and stops; frames beyond it were never captured, so the innermost visible frame is where the evidence ends rather than where the defect is`,
		);
	}
	if (present.length > 1) {
		caveats.push(
			`this failure spans ${present.length} languages (${present.join(", ")}); the traces from each are separate artifacts with no shared frame ids, so any ordering between them is inferred rather than observed`,
		);
	}
	if (present.length === 0) {
		caveats.push("no recognized language in the parsed output; capability claims do not apply");
	}

	return {
		languages: present,
		mixed: present.length > 1,
		boundary_truncated: boundary !== undefined,
		...(boundary ? { boundary_frame: boundary } : {}),
		origin: boundary ? null : (applicationFrames[0] ?? null),
		gaps: present
			.filter((language): language is Exclude<Language, "unknown"> => language !== "unknown")
			.map((language) => ({ language, gaps: LANGUAGE_CAPABILITIES[language].gaps })),
		caveats,
	};
}

export type CoverageReport = {
	languages: number;
	/** Capabilities that are `full` for every language. */
	universal: string[];
	/** Capabilities missing entirely for at least one language, with which. */
	partial: Array<{ capability: string; missing: Language[]; partial: Language[] }>;
	/** Total number of stated gaps across all languages. */
	stated_gaps: number;
	summary: string;
};

const CAPABILITY_FIELDS = ["stack_traces", "locations", "ast_slices", "symbol_resolution"] as const;

/**
 * Summarize what is and is not supported.
 *
 * The output people want is "we support seven languages". The output this
 * produces is the same fact with the qualifications attached, which is longer
 * and is the only version that survives contact with a user.
 */
export function coverageReport(): CoverageReport {
	const entries = Object.values(LANGUAGE_CAPABILITIES);
	const universal: string[] = [];
	const partial: CoverageReport["partial"] = [];

	for (const field of CAPABILITY_FIELDS) {
		const missing = entries.filter((e) => e[field] === "none").map((e) => e.language);
		const partialOnes = entries.filter((e) => e[field] === "partial").map((e) => e.language);
		if (missing.length === 0 && partialOnes.length === 0) universal.push(field);
		else partial.push({ capability: field, missing, partial: partialOnes });
	}

	const gaps = entries.reduce((sum, e) => sum + e.gaps.length, 0);
	return {
		languages: entries.length,
		universal,
		partial,
		stated_gaps: gaps,
		summary: `${entries.length} languages with ${universal.length} capability(ies) working everywhere and ${partial.length} that do not; ${gaps} specific limitations are stated rather than discovered during an incident`,
	};
}

/**
 * Order mixed-language results so the most specific evidence is read first.
 *
 * Deliberately does *not* claim a causal order between languages. When a Python
 * traceback and a Rust panic both appear there is no shared identifier linking
 * them, and choosing one as the cause is a guess. Ordering is by evidence
 * quality — results with a location before results without — and the caller is
 * told, via `assessStack`, that ordering is not causation here.
 */
export function orderMixedResults(results: ParserResult[]): ParserResult[] {
	const quality = (result: ParserResult): number => {
		const hasLocation = result.errors.some((e) => e.location !== undefined);
		const hasFrames = result.errors.some((e) => (e.stack_frames?.length ?? 0) > 0);
		return (hasFrames ? 2 : 0) + (hasLocation ? 1 : 0);
	};
	return [...results].sort((a, b) => quality(b) - quality(a) || a.parser.localeCompare(b.parser));
}
