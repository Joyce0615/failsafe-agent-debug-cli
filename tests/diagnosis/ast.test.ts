/**
 * AST-aware source slices (item 29).
 *
 * A failure inside a long function must yield a slice bounded by that
 * function's declaration, not an arbitrary ±5 lines — with a graceful line
 * window when no unit can be identified.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type SyntaxProvider,
	detectLanguage,
	findEnclosingUnit,
	setSyntaxProvider,
	unitSpanFromHeader,
} from "../../src/diagnosis/ast.js";
import { extractSourceSlice, extractTestSlice } from "../../src/diagnosis/context.js";

afterEach(() => setSyntaxProvider(null));

/** A 30-line Python function surrounded by other definitions. */
const PY_SOURCE = [
	"import os", // 1
	"", // 2
	"def before():", // 3
	"    return 1", // 4
	"", // 5
	"def load_user(rows, user_id):", // 6
	...Array.from({ length: 25 }, (_, i) => `    step_${i} = ${i}`), // 7..31
	"    return rows[user_id]", // 32
	"", // 33
	"def after():", // 34
	"    return 2", // 35
].join("\n");

const JS_SOURCE = [
	"const a = 1;", // 1
	"", // 2
	"function before() {", // 3
	"  return 1;", // 4
	"}", // 5
	"", // 6
	"function loadUser(rows, userId) {", // 7
	...Array.from({ length: 20 }, (_, i) => `  const step${i} = ${i}; // } not a brace`), // 8..27
	'  const s = "}";', // 28
	"  return rows[userId];", // 29
	"}", // 30
	"", // 31
	"function after() {", // 32
	"  return 2;", // 33
	"}", // 34
].join("\n");

describe("detectLanguage", () => {
	test("classifies by extension", () => {
		expect(detectLanguage("a/b/c.py")).toBe("indent");
		expect(detectLanguage("x.rb")).toBe("keyword-end");
		expect(detectLanguage("x.tsx")).toBe("brace");
		expect(detectLanguage("x.go")).toBe("brace");
		expect(detectLanguage("notes.txt")).toBe("unknown");
		expect(detectLanguage("Makefile")).toBe("unknown");
	});
});

describe("findEnclosingUnit — indentation languages", () => {
	test("bounds the slice by the enclosing def, not a fixed window", () => {
		const unit = findEnclosingUnit(PY_SOURCE, 20, "app.py");
		expect(unit).not.toBeNull();
		expect(unit!.start_line).toBe(6);
		expect(unit!.end_line).toBe(32);
		expect(unit!.name).toBe("load_user");
		expect(unit!.kind).toBe("function");
		expect(unit!.provider).toBe("structural");
	});

	test("picks the innermost method inside a class", () => {
		const src = [
			"class Repo:", // 1
			"    def find(self, k):", // 2
			"        return self.rows[k]", // 3
			"", // 4
			"    def save(self, k, v):", // 5
			"        self.rows[k] = v", // 6
		].join("\n");
		const unit = findEnclosingUnit(src, 3, "repo.py");
		expect(unit!.name).toBe("find");
		expect(unit!.kind).toBe("method");
		expect(unit!.start_line).toBe(2);
		expect(unit!.end_line).toBe(3);
	});

	test("returns null for a top-level statement with no enclosing unit", () => {
		expect(findEnclosingUnit(PY_SOURCE, 1, "app.py")).toBeNull();
	});

	test("absorbs Ruby's terminating end", () => {
		const src = ["def widget(x)", "  x.frob", "end", "", "def other", "  1", "end"].join("\n");
		const unit = findEnclosingUnit(src, 2, "widget.rb");
		expect(unit!.start_line).toBe(1);
		expect(unit!.end_line).toBe(3);
		expect(unit!.name).toBe("widget");
	});
});

describe("findEnclosingUnit — brace languages", () => {
	test("bounds the slice by the enclosing function", () => {
		const unit = findEnclosingUnit(JS_SOURCE, 20, "app.js");
		expect(unit!.start_line).toBe(7);
		expect(unit!.end_line).toBe(30);
		expect(unit!.name).toBe("loadUser");
	});

	test("ignores braces inside comments and strings", () => {
		// Line 28 is `const s = "}";` — a naive counter would close the function there.
		const unit = findEnclosingUnit(JS_SOURCE, 29, "app.ts");
		expect(unit!.end_line).toBe(30);
	});

	test("handles Allman-style braces on the next line", () => {
		const src = ["int main(int argc)", "{", "    return broken();", "}"].join("\n");
		const unit = findEnclosingUnit(src, 3, "main.c");
		expect(unit!.start_line).toBe(1);
		expect(unit!.end_line).toBe(4);
	});

	test("returns null for an unclosed unit", () => {
		expect(findEnclosingUnit("function broken() {\n  oops();", 2, "x.js")).toBeNull();
	});
});

describe("syntax provider seam (Tree-sitter integration point)", () => {
	test("a registered provider wins over the structural analyzer", () => {
		const provider: SyntaxProvider = {
			name: "tree-sitter",
			enclosingUnit: () => ({
				start_line: 6,
				end_line: 32,
				kind: "function",
				name: "from_grammar",
				provider: "tree-sitter",
			}),
		};
		setSyntaxProvider(provider);
		const unit = findEnclosingUnit(PY_SOURCE, 20, "app.py");
		expect(unit!.name).toBe("from_grammar");
		expect(unit!.provider).toBe("tree-sitter");
	});

	test("a throwing or non-enclosing provider degrades to structural analysis", () => {
		setSyntaxProvider({
			name: "broken",
			enclosingUnit: () => {
				throw new Error("grammar not loaded");
			},
		});
		expect(findEnclosingUnit(PY_SOURCE, 20, "app.py")!.name).toBe("load_user");

		setSyntaxProvider({
			name: "offbase",
			// Span that does not actually contain the line is rejected.
			enclosingUnit: () => ({ start_line: 1, end_line: 2, kind: "function", provider: "x" }),
		});
		expect(findEnclosingUnit(PY_SOURCE, 20, "app.py")!.name).toBe("load_user");
	});
});

describe("unitSpanFromHeader", () => {
	test("returns the last line of the declaration at the header", () => {
		expect(unitSpanFromHeader(PY_SOURCE, 6, "app.py")).toBe(32);
		expect(unitSpanFromHeader(JS_SOURCE, 7, "app.js")).toBe(30);
		expect(unitSpanFromHeader(PY_SOURCE, 6, "notes.txt")).toBeNull();
	});
});

describe("extractSourceSlice with AST units", () => {
	let dir: string;

	function writeSource(name: string, content: string): string {
		dir = mkdtempSync(join(tmpdir(), "failsafe-ast-"));
		const file = join(dir, name);
		writeFileSync(file, content);
		return file;
	}

	test("a failure inside a long function yields the whole function", async () => {
		const file = writeSource("app.py", PY_SOURCE);
		const slice = await extractSourceSlice({ file, line: 20 });
		expect(slice).not.toBeNull();
		// Bounded by the def, not line 20 ± 5.
		expect(slice!.start_line).toBe(6);
		expect(slice!.end_line).toBe(32);
		expect(slice!.symbol).toBe("load_user");
		expect(slice!.unit_kind).toBe("function");
		expect(slice!.text).toContain("6: def load_user(rows, user_id):");
		expect(slice!.text).toContain("32:     return rows[user_id]");
		// Neighbouring definitions are excluded.
		expect(slice!.text).not.toContain("def before");
		expect(slice!.text).not.toContain("def after");
		rmSync(dir, { recursive: true, force: true });
	});

	test("falls back to a line window when no unit is identifiable", async () => {
		const file = writeSource("notes.txt", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
		const slice = await extractSourceSlice({ file, line: 5 }, 2);
		expect(slice!.start_line).toBe(3);
		expect(slice!.end_line).toBe(7);
		expect(slice!.symbol).toBeUndefined();
		expect(slice!.unit_kind).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});

	test("an oversized unit is windowed but clamped inside its own boundaries", async () => {
		const huge = [
			"def giant():",
			...Array.from({ length: 400 }, (_, i) => `    x${i} = ${i}`),
			"    return 0",
			"",
			"def neighbour():",
			"    return 1",
		].join("\n");
		const file = writeSource("giant.py", huge);
		const slice = await extractSourceSlice({ file, line: 200 }, 5);
		expect(slice!.truncated_unit).toBe(true);
		expect(slice!.symbol).toBe("giant");
		expect(slice!.start_line).toBe(195);
		expect(slice!.end_line).toBe(205);
		expect(slice!.text).not.toContain("def neighbour");
		rmSync(dir, { recursive: true, force: true });
	});

	test("test slices are bounded by the test's own body", async () => {
		const src = [
			"describe('auth', () => {", // 1
			"  test('logs in', () => {", // 2
			"    const cfg = { a: 1 };", // 3
			"    expect(login(cfg)).toBe(true);", // 4
			"  });", // 5
			"", // 6
			"  test('logs out', () => {", // 7
			"    expect(logout()).toBe(true);", // 8
			"  });", // 9
			"});", // 10
		].join("\n");
		const file = writeSource("auth.test.js", src);
		const slice = await extractTestSlice(file, "logs in");
		expect(slice!.start_line).toBe(2);
		expect(slice!.end_line).toBe(5);
		expect(slice!.text).toContain("logs in");
		expect(slice!.text).not.toContain("logs out");
		rmSync(dir, { recursive: true, force: true });
	});
});
