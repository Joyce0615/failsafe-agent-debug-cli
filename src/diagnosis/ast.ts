/**
 * Syntax-aware enclosing-unit resolution for source slices (item 29).
 *
 * DESIGN §10.2 wants slices bounded by the *enclosing function/class* rather
 * than a fixed ±N line window, because an arbitrary window both cuts the
 * relevant unit in half and pads the packet with unrelated lines
 * (AutoCodeRover's AST-structured localization result).
 *
 * Two layers, in precedence order:
 *
 *  1. An optional {@link SyntaxProvider} — the seam a Tree-sitter (WASM)
 *     grammar plugs into. Registered via {@link setSyntaxProvider}; when a
 *     grammar is loaded it wins outright. Nothing is loaded by default, so a
 *     checkout with no grammars pays zero cost and ships no binary blobs.
 *  2. A bounded structural analyzer that recovers the same span from layout:
 *     indentation blocks for Python/Ruby-style languages and brace matching
 *     (comment/string aware) for C-family languages.
 *
 * When neither layer identifies a unit, the caller falls back to the original
 * line window — the graceful degradation the item calls for.
 *
 * Pure: no fs, network, or process access. All scanning is bounded so a
 * pathological file cannot dominate diagnosis latency.
 */

export type SyntaxUnitKind = "function" | "method" | "class" | "module" | "block";

export type SyntaxUnit = {
	/** 1-based inclusive first line of the unit (its declaration header). */
	start_line: number;
	/** 1-based inclusive last line of the unit. */
	end_line: number;
	kind: SyntaxUnitKind;
	/** Declared name, when the header exposes one. */
	name?: string;
	/** Which layer produced the span. */
	provider: string;
};

/**
 * Pluggable syntax backend. A Tree-sitter (WASM) implementation supplies
 * `enclosingUnit` by walking up from the node at `line` to the nearest
 * function/method/class node and returning its span.
 */
export type SyntaxProvider = {
	name: string;
	/** Innermost declaration enclosing `line` (1-based), or null. */
	enclosingUnit(source: string, line: number, file: string): SyntaxUnit | null;
};

let activeProvider: SyntaxProvider | null = null;

/** Register (or clear, with `null`) the syntax provider. */
export function setSyntaxProvider(provider: SyntaxProvider | null): void {
	activeProvider = provider;
}

export function getSyntaxProvider(): SyntaxProvider | null {
	return activeProvider;
}

export type Language = "indent" | "brace" | "keyword-end" | "unknown";

const INDENT_EXTS = new Set(["py", "pyi", "pyw"]);
const KEYWORD_END_EXTS = new Set(["rb", "rake", "gemspec"]);
const BRACE_EXTS = new Set([
	"js",
	"jsx",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"mts",
	"cts",
	"java",
	"c",
	"h",
	"cc",
	"cpp",
	"cxx",
	"hpp",
	"hh",
	"go",
	"rs",
	"cs",
	"swift",
	"kt",
	"kts",
	"scala",
	"php",
]);

/** Classify a file by extension into the structural family that fits it. */
export function detectLanguage(file: string): Language {
	const ext = file.split(".").pop()?.toLowerCase() ?? "";
	if (INDENT_EXTS.has(ext)) return "indent";
	if (KEYWORD_END_EXTS.has(ext)) return "keyword-end";
	if (BRACE_EXTS.has(ext)) return "brace";
	return "unknown";
}

/** Max lines scanned above the target when hunting for a declaration header. */
const MAX_LOOKBACK = 800;
/** Files longer than this skip structural analysis entirely (latency bound). */
const MAX_FILE_LINES = 20_000;

function indentWidth(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4;
		else break;
	}
	return width;
}

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

const PY_HEADER = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
const RB_HEADER = /^(\s*)(def|class|module)\s+([A-Za-z_][\w.:?!]*)/;

/**
 * Indentation-scoped block end: the last non-blank line whose indent is deeper
 * than the header's. `terminator` (Ruby's `end`) is absorbed when present at
 * the header's own indent.
 */
function indentBlockEnd(lines: string[], headerIdx: number, terminator: RegExp | null): number {
	const headerIndent = indentWidth(lines[headerIdx]);
	let lastBody = headerIdx;
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (isBlank(line)) continue;
		if (indentWidth(line) > headerIndent) {
			lastBody = i;
			continue;
		}
		// Dedent: the block is over. Absorb a matching terminator line.
		if (terminator?.test(line)) lastBody = i;
		break;
	}
	return lastBody;
}

function unitKindFor(keyword: string): SyntaxUnitKind {
	if (keyword === "class") return "class";
	if (keyword === "module") return "module";
	return "function";
}

function indentEnclosingUnit(
	lines: string[],
	line: number,
	header: RegExp,
	terminator: RegExp | null,
): SyntaxUnit | null {
	const targetIdx = line - 1;
	const start = Math.max(0, targetIdx - MAX_LOOKBACK);
	let best: SyntaxUnit | null = null;
	let bestIndent = -1;

	for (let i = targetIdx; i >= start; i--) {
		const m = header.exec(lines[i]);
		if (!m) continue;
		const endIdx = indentBlockEnd(lines, i, terminator);
		if (endIdx < targetIdx) continue; // header's block ends before the target
		const indent = indentWidth(lines[i]);
		// Keep the innermost (deepest-indented) enclosing declaration.
		if (indent > bestIndent) {
			bestIndent = indent;
			best = {
				start_line: i + 1,
				end_line: endIdx + 1,
				kind: indent > 0 && m[2] === "def" ? "method" : unitKindFor(m[2]),
				name: m[3],
				provider: "structural",
			};
		}
		if (indent === 0) break; // reached top level; nothing outer can be tighter
	}
	return best;
}

/**
 * Blank out string literals and comments so brace counting is not confused by
 * `"{"` or `// }`. Length is preserved so column offsets stay valid.
 */
function sanitizeForBraces(lines: string[]): string[] {
	const out: string[] = [];
	let inBlockComment = false;
	for (const raw of lines) {
		let result = "";
		let i = 0;
		let quote: string | null = null;
		while (i < raw.length) {
			const ch = raw[i];
			const next = raw[i + 1];
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					result += "  ";
					i += 2;
					continue;
				}
				result += " ";
				i++;
				continue;
			}
			if (quote) {
				if (ch === "\\") {
					result += "  ";
					i += 2;
					continue;
				}
				if (ch === quote) quote = null;
				result += " ";
				i++;
				continue;
			}
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				result += "  ";
				i += 2;
				continue;
			}
			if ((ch === "/" && next === "/") || ch === "#") {
				result += " ".repeat(raw.length - i);
				break;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				result += " ";
				i++;
				continue;
			}
			result += ch;
			i++;
		}
		out.push(result);
	}
	return out;
}

/**
 * Header shapes that introduce a function/method/class body in C-family code:
 * an explicit declaration keyword, an arrow function, or a parameter list that
 * ends the line (with the body brace either here or, Allman-style, on the next
 * line — `openingBraceLine` confirms which).
 */
const BRACE_DECL =
	/\b(function|func|fn|class|struct|interface|impl|trait|enum|namespace)\b|=>\s*\{?\s*$|\)\s*(?:const\s*)?(?:noexcept\s*)?(?:throws\s+[\w.,\s]+)?\s*(?:->[^{;]*)?\{?\s*$/;

const BRACE_NAME =
	/(?:function|func|fn|class|struct|interface|impl|trait|enum|namespace)\s+([A-Za-z_]\w*)|(?:const|let|var)\s+([A-Za-z_]\w*)\s*=|([A-Za-z_]\w*)\s*\(/;

function braceKind(line: string): SyntaxUnitKind {
	if (/\b(class|struct|interface|trait|enum|impl|namespace)\b/.test(line)) return "class";
	return "function";
}

function braceNameFrom(line: string): string | undefined {
	const m = BRACE_NAME.exec(line);
	if (!m) return undefined;
	return m[1] ?? m[2] ?? m[3];
}

/**
 * Find the line index holding the `{` that opens `headerIdx`'s body: either on
 * the header itself or on the next non-blank line (Allman style).
 */
function openingBraceLine(sanitized: string[], headerIdx: number): number | null {
	if (sanitized[headerIdx].includes("{")) return headerIdx;
	for (let i = headerIdx + 1; i < sanitized.length && i <= headerIdx + 2; i++) {
		if (isBlank(sanitized[i])) continue;
		return sanitized[i].trimStart().startsWith("{") ? i : null;
	}
	return null;
}

/** Line index of the `}` closing the first `{` at/after `openIdx`. */
function matchingCloseLine(sanitized: string[], openIdx: number): number | null {
	let depth = 0;
	let started = false;
	for (let i = openIdx; i < sanitized.length; i++) {
		for (const ch of sanitized[i]) {
			if (ch === "{") {
				depth++;
				started = true;
			} else if (ch === "}") {
				depth--;
				if (started && depth === 0) return i;
			}
		}
	}
	return null;
}

function braceEnclosingUnit(lines: string[], line: number): SyntaxUnit | null {
	const sanitized = sanitizeForBraces(lines);
	const targetIdx = line - 1;
	const start = Math.max(0, targetIdx - MAX_LOOKBACK);

	// Walk upward: the FIRST header whose body spans the target is the
	// innermost enclosing unit.
	for (let i = targetIdx; i >= start; i--) {
		const raw = lines[i];
		if (isBlank(raw) || !BRACE_DECL.test(sanitized[i])) continue;
		const openIdx = openingBraceLine(sanitized, i);
		if (openIdx === null) continue;
		const closeIdx = matchingCloseLine(sanitized, openIdx);
		if (closeIdx === null || closeIdx < targetIdx) continue;
		return {
			start_line: i + 1,
			end_line: closeIdx + 1,
			kind: braceKind(sanitized[i]),
			name: braceNameFrom(sanitized[i]),
			provider: "structural",
		};
	}
	return null;
}

/**
 * Resolve the innermost function/class span enclosing `line` (1-based).
 *
 * Tries the registered {@link SyntaxProvider} first (the Tree-sitter seam),
 * then the structural analyzer. Returns null when neither can identify a unit,
 * which is the caller's signal to fall back to a line window.
 */
export function findEnclosingUnit(source: string, line: number, file: string): SyntaxUnit | null {
	const provider = activeProvider;
	if (provider) {
		try {
			const unit = provider.enclosingUnit(source, line, file);
			if (unit && unit.start_line <= line && unit.end_line >= line) {
				return { ...unit, provider: unit.provider || provider.name };
			}
		} catch {
			// A broken/missing grammar must never fail a diagnosis.
		}
	}

	const lines = source.split("\n");
	if (line < 1 || line > lines.length || lines.length > MAX_FILE_LINES) return null;

	switch (detectLanguage(file)) {
		case "indent":
			return indentEnclosingUnit(lines, line, PY_HEADER, null);
		case "keyword-end":
			return indentEnclosingUnit(lines, line, RB_HEADER, /^\s*end\b/);
		case "brace":
			return braceEnclosingUnit(lines, line);
		default:
			return null;
	}
}

/**
 * Span of the declaration whose header is at `headerLine` (1-based). Used to
 * bound a unit located by name (e.g. a test function) instead of by position.
 */
export function unitSpanFromHeader(
	source: string,
	headerLine: number,
	file: string,
): number | null {
	const lines = source.split("\n");
	const idx = headerLine - 1;
	if (idx < 0 || idx >= lines.length) return null;

	switch (detectLanguage(file)) {
		case "indent":
			return indentBlockEnd(lines, idx, null) + 1;
		case "keyword-end":
			return indentBlockEnd(lines, idx, /^\s*end\b/) + 1;
		case "brace": {
			const sanitized = sanitizeForBraces(lines);
			const openIdx = openingBraceLine(sanitized, idx);
			if (openIdx === null) return null;
			const closeIdx = matchingCloseLine(sanitized, openIdx);
			return closeIdx === null ? null : closeIdx + 1;
		}
		default:
			return null;
	}
}
