import { describe, expect, test } from "bun:test";
import {
	EXACTNESS,
	type LspClient,
	RESOLVER_EXACTNESS,
	RESOLVER_KINDS,
	RESOLVER_LIMITATIONS,
	type SourceFile,
	auditResolution,
	lspResolver,
	regexResolver,
	resolveSymbol,
	selectResolver,
	treeSitterResolver,
} from "../../src/diagnosis/symbol-resolution.js";

const FILES: SourceFile[] = [
	{
		path: "src/handler.py",
		content: [
			"import json",
			"",
			"def process(payload):",
			"    # process the payload",
			'    return json.dumps({"process": payload})',
		].join("\n"),
	},
	{
		path: "src/app.py",
		content: ["from handler import process", "", "def main():", "    return process({})"].join(
			"\n",
		),
	},
];

describe("the backends are ordered and their exactness stated", () => {
	test("the kinds are ordered strongest first", () => {
		expect(RESOLVER_KINDS).toEqual(["language_server", "tree_sitter", "regex"]);
		for (let i = 1; i < RESOLVER_KINDS.length; i++) {
			expect(EXACTNESS.indexOf(RESOLVER_EXACTNESS[RESOLVER_KINDS[i]])).toBeGreaterThan(
				EXACTNESS.indexOf(RESOLVER_EXACTNESS[RESOLVER_KINDS[i - 1]]),
			);
		}
	});

	test("every backend states what it cannot do", () => {
		for (const kind of RESOLVER_KINDS) {
			expect(RESOLVER_LIMITATIONS[kind].length).toBeGreaterThan(0);
		}
	});

	test("the regex backend admits it cannot tell a definition from a mention", () => {
		expect(RESOLVER_LIMITATIONS.regex[0]).toContain("cannot tell a definition from a call");
	});

	test("tree-sitter admits it cannot follow an import", () => {
		expect(RESOLVER_LIMITATIONS.tree_sitter[0]).toContain("cannot follow an import");
	});
});

describe("the regex fallback", () => {
	test("it is always available", () => {
		expect(regexResolver.available()).toEqual({ ok: true });
	});

	test("it finds a declaration by keyword", () => {
		const definitions = regexResolver.definitions("process", FILES);
		expect(definitions).toHaveLength(1);
		expect(definitions[0].file).toBe("src/handler.py");
		expect(definitions[0].line).toBe(3);
	});

	test("it finds every textual occurrence as a reference, comments included", () => {
		const references = regexResolver.references("process", FILES);
		// Declaration, comment, string key, import, and call.
		expect(references.length).toBeGreaterThanOrEqual(5);
		expect(references.some((r) => r.preview.startsWith("#"))).toBe(true);
	});

	test("a symbol with regex metacharacters is escaped, not interpreted", () => {
		const files: SourceFile[] = [{ path: "a.py", content: "def a_b(): pass\ndef axb(): pass" }];
		expect(regexResolver.definitions("a.b", files)).toEqual([]);
	});

	test("a symbol that appears nowhere yields nothing", () => {
		expect(regexResolver.definitions("nonexistent", FILES)).toEqual([]);
	});

	test("declaration keywords across languages are recognized", () => {
		const files: SourceFile[] = [
			{ path: "a.rs", content: "fn handle() {}" },
			{ path: "b.go", content: "func handle() {}" },
			{ path: "c.ts", content: "const handle = () => {}" },
		];
		expect(regexResolver.definitions("handle", files)).toHaveLength(3);
	});
});

describe("unavailable backends report why", () => {
	test("tree-sitter without a parser is unavailable with a reason", () => {
		const availability = treeSitterResolver().available();
		expect(availability.ok).toBe(false);
		if (!availability.ok) expect(availability.reason).toContain("grammar WASM is not bundled");
	});

	test("an unavailable backend returns nothing rather than throwing", () => {
		expect(treeSitterResolver().definitions("process", FILES)).toEqual([]);
	});

	test("the language server without a client is unavailable", () => {
		const availability = lspResolver().available();
		expect(availability.ok).toBe(false);
		if (!availability.ok) expect(availability.reason).toContain("no language-server client");
	});

	test("a cold language server reports its own reason", () => {
		const cold: LspClient = {
			ready: () => ({ ok: false, reason: "index is still building" }),
			definition: () => [],
			references: () => [],
		};
		const availability = lspResolver(cold).available();
		expect(availability.ok).toBe(false);
		if (!availability.ok) expect(availability.reason).toBe("index is still building");
	});
});

describe("selection never downgrades silently", () => {
	test("the strongest available backend is chosen", () => {
		const ready: LspClient = {
			ready: () => ({ ok: true }),
			definition: () => [{ file: "src/handler.py", line: 3, preview: "def process(payload):" }],
			references: () => [],
		};
		const selection = selectResolver([regexResolver, lspResolver(ready)]);
		expect(selection.chosen.kind).toBe("language_server");
		expect(selection.skipped).toEqual([]);
	});

	test("skipped backends are recorded with their reasons", () => {
		const selection = selectResolver([regexResolver, lspResolver(), treeSitterResolver()]);
		expect(selection.chosen.kind).toBe("regex");
		expect(selection.skipped.map((s) => s.kind)).toEqual(["language_server", "tree_sitter"]);
		expect(selection.skipped[0].reason).toContain("no language-server client");
	});

	test("a backend absent from the list is not reported as skipped", () => {
		const selection = selectResolver([regexResolver]);
		expect(selection.skipped).toEqual([]);
	});

	test("an empty resolver list falls back to regex", () => {
		expect(selectResolver([]).chosen.kind).toBe("regex");
	});

	test("the preference order is configurable", () => {
		const ready: LspClient = {
			ready: () => ({ ok: true }),
			definition: () => [],
			references: () => [],
		};
		const selection = selectResolver([regexResolver, lspResolver(ready)], [
			"regex",
			"language_server",
		]);
		expect(selection.chosen.kind).toBe("regex");
	});
});

describe("results carry their provenance", () => {
	test("a regex answer is labelled approximate with its limitations", () => {
		const result = resolveSymbol("process", FILES, [regexResolver]);
		expect(result.provider).toBe("regex");
		expect(result.exactness).toBe("approximate");
		expect(result.limitations.length).toBeGreaterThan(0);
	});

	test("an exact answer carries no limitations", () => {
		const ready: LspClient = {
			ready: () => ({ ok: true }),
			definition: () => [{ file: "src/handler.py", line: 3, preview: "def process(payload):" }],
			references: () => [],
		};
		const result = resolveSymbol("process", FILES, [regexResolver, lspResolver(ready)]);
		expect(result.exactness).toBe("exact");
		expect(result.limitations).toEqual([]);
		expect(result.downgraded_from).toBeUndefined();
	});

	test("a downgrade is recorded on the result", () => {
		const result = resolveSymbol("process", FILES, [regexResolver, lspResolver()]);
		expect(result.downgraded_from).toBe("language_server");
		expect(result.downgrade_reason).toContain("preferred but unavailable");
	});

	test("an injected tree-sitter parser is used and labelled syntactic", () => {
		const result = resolveSymbol(
			"process",
			FILES,
			[
				regexResolver,
				treeSitterResolver((file) =>
					file.path === "src/handler.py"
						? [{ name: "process", line: 3, is_definition: true }]
						: [{ name: "process", line: 4, is_definition: false }],
				),
			],
		);
		expect(result.provider).toBe("tree_sitter");
		expect(result.exactness).toBe("syntactic");
		expect(result.definitions).toHaveLength(1);
		expect(result.references).toHaveLength(1);
	});

	test("tree-sitter excludes the comment and string matches that regex includes", () => {
		const syntactic = resolveSymbol("process", FILES, [
			treeSitterResolver((file) =>
				file.path === "src/handler.py" ? [{ name: "process", line: 3, is_definition: true }] : [],
			),
		]);
		const approximate = resolveSymbol("process", FILES, [regexResolver]);
		expect(syntactic.references.length).toBeLessThan(approximate.references.length);
	});
});

describe("the audit says what to do with the answer", () => {
	test("an approximate answer is explicitly not citable as a resolved symbol", () => {
		const audit = auditResolution(resolveSymbol("process", FILES, [regexResolver]));
		expect(audit.trust).toBe("approximate");
		expect(
			audit.caveats.some((c) => c.includes("should not be cited as one")),
		).toBe(true);
	});

	test("an exact answer carries no caveats", () => {
		const ready: LspClient = {
			ready: () => ({ ok: true }),
			definition: () => [{ file: "a.py", line: 1, preview: "def process():" }],
			references: () => [],
		};
		const audit = auditResolution(resolveSymbol("process", FILES, [lspResolver(ready)]));
		expect(audit.caveats).toEqual([]);
		expect(audit.found).toBe(true);
	});

	test("several approximate definitions are flagged as probably false matches", () => {
		const files: SourceFile[] = [
			{ path: "a.py", content: "def handle(): pass" },
			{ path: "b.py", content: "def handle(): pass" },
		];
		const audit = auditResolution(resolveSymbol("handle", files, [regexResolver]));
		expect(audit.ambiguous_and_approximate).toBe(true);
		expect(audit.caveats.some((c) => c.includes("a false match is not"))).toBe(true);
	});

	test("nothing found after a downgrade is not evidence that nothing exists", () => {
		const audit = auditResolution(
			resolveSymbol("nonexistent", FILES, [regexResolver, lspResolver()]),
		);
		expect(audit.found).toBe(false);
		expect(
			audit.caveats.some((c) => c.includes("not evidence that no definition exists")),
		).toBe(true);
	});

	test("several exact definitions are not flagged as ambiguous", () => {
		const ready: LspClient = {
			ready: () => ({ ok: true }),
			definition: () => [
				{ file: "a.py", line: 1, preview: "x" },
				{ file: "b.py", line: 1, preview: "x" },
			],
			references: () => [],
		};
		const audit = auditResolution(resolveSymbol("handle", FILES, [lspResolver(ready)]));
		expect(audit.ambiguous_and_approximate).toBe(false);
	});
});
