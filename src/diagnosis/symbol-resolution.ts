/**
 * Definition and reference resolution behind the syntax seam (item 84).
 *
 * Item 29 established `SyntaxProvider` as the seam a Tree-sitter grammar plugs
 * into for *spans*. Definitions and references are the other half, and they are
 * where the difference between backends stops being cosmetic:
 *
 * - A **regex** scan finds every textual occurrence of a name. It cannot tell a
 *   definition from a call, a shadowed local from the outer binding, or a
 *   comment from code. It is always available.
 * - **Tree-sitter** parses, so it can tell a definition from a reference and a
 *   string literal from an identifier. It cannot resolve across files, because
 *   it has no notion of imports.
 * - A **language server** resolves properly, across files, through imports and
 *   re-exports. It requires a running server, an indexed project, and time.
 *
 * The failure this module exists to prevent is the three becoming
 * indistinguishable in the output. An approximate answer rendered exactly like
 * an exact one is worse than no answer, because a reader has no way to apply
 * the discount it deserves. So every result carries `provider` and `exactness`,
 * `approximate` results carry the specific reasons they may be wrong, and
 * `resolveDefinition` never silently substitutes a weaker backend for a
 * stronger one — a downgrade is reported.
 *
 * Providers are injected. This module contains no Tree-sitter or LSP
 * dependency; it defines what one must supply and behaves correctly when none
 * is present, which is the state a fresh checkout is in.
 */

export const RESOLVER_KINDS = ["language_server", "tree_sitter", "regex"] as const;
export type ResolverKind = (typeof RESOLVER_KINDS)[number];

/** How much a result can be trusted. Ordered strongest first. */
export const EXACTNESS = ["exact", "syntactic", "approximate"] as const;
export type Exactness = (typeof EXACTNESS)[number];

export const RESOLVER_EXACTNESS: Record<ResolverKind, Exactness> = {
	language_server: "exact",
	tree_sitter: "syntactic",
	regex: "approximate",
};

/**
 * What each backend cannot do, stated per backend rather than per result.
 *
 * Attached to every approximate or syntactic result so the discount travels
 * with the answer instead of living in documentation nobody reads mid-incident.
 */
export const RESOLVER_LIMITATIONS: Record<ResolverKind, string[]> = {
	language_server: [
		"requires a running server and a completed index; a cold project returns nothing rather than being slow",
		"dynamic dispatch and reflection are resolved only as far as the language's own type system reaches",
	],
	tree_sitter: [
		"cannot follow an import: a definition in another file is invisible",
		"cannot distinguish two same-named symbols in different scopes of the same file when neither is declared locally",
		"a re-exported symbol resolves to the re-export, not the original",
	],
	regex: [
		"cannot tell a definition from a call, an assignment, or a mention in a comment",
		"a shadowed local and the outer binding it shadows look identical",
		"a name appearing inside a string literal is indistinguishable from code",
		"a symbol whose name is a common word will match everywhere",
	],
};

export type SourceFile = { path: string; content: string };

export type SymbolLocation = {
	file: string;
	/** 1-based. */
	line: number;
	column?: number;
	/** The line's text, for the caller to judge the match. */
	preview: string;
};

export type ResolutionResult = {
	symbol: string;
	provider: ResolverKind;
	exactness: Exactness;
	definitions: SymbolLocation[];
	references: SymbolLocation[];
	/** Reasons this result may be wrong. Empty only for `exact`. */
	limitations: string[];
	/** Set when a stronger backend was requested but unavailable. */
	downgraded_from?: ResolverKind;
	downgrade_reason?: string;
};

/**
 * A backend. `available()` is separate from the resolution calls so a caller
 * can find out that a backend is unusable *before* committing to it, and so an
 * unavailable backend reports why rather than returning an empty result that
 * looks like "no matches".
 */
export type SymbolResolver = {
	kind: ResolverKind;
	available(): { ok: true } | { ok: false; reason: string };
	definitions(symbol: string, files: SourceFile[]): SymbolLocation[];
	references(symbol: string, files: SourceFile[]): SymbolLocation[];
};

/** Declaration keywords across the supported languages. */
const DEFINITION_PATTERNS = [
	String.raw`\bdef\s+`,
	String.raw`\bclass\s+`,
	String.raw`\bfunction\s+`,
	String.raw`\bfn\s+`,
	String.raw`\bfunc\s+`,
	String.raw`\bstruct\s+`,
	String.raw`\benum\s+`,
	String.raw`\binterface\s+`,
	String.raw`\btype\s+`,
	String.raw`\b(?:const|let|var)\s+`,
];

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The always-available fallback.
 *
 * Deliberately simple. A cleverer regex scanner would be more accurate and
 * would blur the line between it and Tree-sitter, which is precisely the
 * distinction the rest of this module exists to keep sharp. It is a text
 * search, it is labelled as one, and its limitations are attached to every
 * answer it gives.
 */
export const regexResolver: SymbolResolver = {
	kind: "regex",
	available: () => ({ ok: true }),

	definitions(symbol, files) {
		const pattern = new RegExp(`(?:${DEFINITION_PATTERNS.join("|")})${escapeRegex(symbol)}\\b`);
		const found: SymbolLocation[] = [];
		for (const file of files) {
			file.content.split("\n").forEach((text, index) => {
				if (pattern.test(text)) {
					found.push({ file: file.path, line: index + 1, preview: text.trim() });
				}
			});
		}
		return found;
	},

	references(symbol, files) {
		const pattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
		const found: SymbolLocation[] = [];
		for (const file of files) {
			file.content.split("\n").forEach((text, index) => {
				if (pattern.test(text)) {
					found.push({
						file: file.path,
						line: index + 1,
						column: text.indexOf(symbol) + 1,
						preview: text.trim(),
					});
				}
			});
		}
		return found;
	},
};

/**
 * Build a Tree-sitter-backed resolver from an injected parser.
 *
 * The parser is a function because this repository does not depend on
 * Tree-sitter: adding the grammar WASM would mean fetching binaries, which is
 * a decision for whoever deploys this and not something a library should do on
 * its own. When no parser is supplied the resolver reports itself unavailable
 * with that reason, which is what a fresh checkout should see.
 */
export function treeSitterResolver(
	parse?: (file: SourceFile) => Array<{ name: string; line: number; is_definition: boolean }>,
): SymbolResolver {
	return {
		kind: "tree_sitter",
		available: () =>
			parse
				? { ok: true }
				: {
						ok: false,
						reason:
							"no Tree-sitter parser was supplied; the grammar WASM is not bundled and must be provided by the host",
					},
		definitions(symbol, files) {
			if (!parse) return [];
			return files.flatMap((file) =>
				parse(file)
					.filter((node) => node.name === symbol && node.is_definition)
					.map((node) => ({
						file: file.path,
						line: node.line,
						preview: file.content.split("\n")[node.line - 1]?.trim() ?? "",
					})),
			);
		},
		references(symbol, files) {
			if (!parse) return [];
			return files.flatMap((file) =>
				parse(file)
					.filter((node) => node.name === symbol && !node.is_definition)
					.map((node) => ({
						file: file.path,
						line: node.line,
						preview: file.content.split("\n")[node.line - 1]?.trim() ?? "",
					})),
			);
		},
	};
}

export type LspClient = {
	/** Whether the server is running and the project is indexed. */
	ready(): { ok: true } | { ok: false; reason: string };
	definition(symbol: string): SymbolLocation[];
	references(symbol: string): SymbolLocation[];
};

/** Build a language-server-backed resolver from an injected client. */
export function lspResolver(client?: LspClient): SymbolResolver {
	return {
		kind: "language_server",
		available: () =>
			client ? client.ready() : { ok: false, reason: "no language-server client was supplied" },
		definitions: (symbol) => client?.definition(symbol) ?? [],
		references: (symbol) => client?.references(symbol) ?? [],
	};
}

/** Default preference order: strongest available backend wins. */
export const DEFAULT_RESOLVER_ORDER: ResolverKind[] = ["language_server", "tree_sitter", "regex"];

export type ResolverSelection = {
	chosen: SymbolResolver;
	/** Backends that were preferred but unavailable, with why. */
	skipped: Array<{ kind: ResolverKind; reason: string }>;
};

/**
 * Pick the strongest available resolver.
 *
 * Records what it skipped and why. A silent downgrade is the failure mode here:
 * a caller who asked for language-server precision and got a regex scan will
 * read the result as precise unless something tells them otherwise.
 */
export function selectResolver(
	resolvers: SymbolResolver[],
	order: ResolverKind[] = DEFAULT_RESOLVER_ORDER,
): ResolverSelection {
	const skipped: ResolverSelection["skipped"] = [];
	for (const kind of order) {
		const resolver = resolvers.find((r) => r.kind === kind);
		if (!resolver) continue;
		const availability = resolver.available();
		if (availability.ok) return { chosen: resolver, skipped };
		skipped.push({ kind, reason: availability.reason });
	}
	return { chosen: regexResolver, skipped };
}

/**
 * Resolve a symbol with the best available backend.
 *
 * The result always states which backend answered and how exact that makes it.
 * When a preferred backend was skipped the result records the downgrade and its
 * reason, so "no definitions found" by an unavailable language server is never
 * confused with "no definitions exist".
 */
export function resolveSymbol(
	symbol: string,
	files: SourceFile[],
	resolvers: SymbolResolver[] = [regexResolver],
	order: ResolverKind[] = DEFAULT_RESOLVER_ORDER,
): ResolutionResult {
	const { chosen, skipped } = selectResolver(resolvers, order);
	const exactness = RESOLVER_EXACTNESS[chosen.kind];
	const preferred = skipped[0];

	return {
		symbol,
		provider: chosen.kind,
		exactness,
		definitions: chosen.definitions(symbol, files),
		references: chosen.references(symbol, files),
		limitations: exactness === "exact" ? [] : RESOLVER_LIMITATIONS[chosen.kind],
		...(preferred
			? {
					downgraded_from: preferred.kind,
					downgrade_reason: `'${preferred.kind}' was preferred but unavailable: ${preferred.reason}`,
				}
			: {}),
	};
}

export type ResolutionAudit = {
	/** How much of the answer can be relied on, in one word. */
	trust: Exactness;
	/** Whether a definition was found at all. */
	found: boolean;
	/**
	 * True when the result is approximate *and* returned several definitions,
	 * which is the specific shape in which a regex scan misleads most: it looks
	 * like a symbol defined in several places, and usually is not.
	 */
	ambiguous_and_approximate: boolean;
	caveats: string[];
};

/**
 * What a reader should take from a resolution.
 *
 * Written as a separate function because the interesting judgment is not in the
 * data but in what to do with it, and burying "this is a text search" in a
 * field of a result object is a reliable way to have it ignored.
 */
export function auditResolution(result: ResolutionResult): ResolutionAudit {
	const caveats: string[] = [];
	if (result.downgrade_reason) caveats.push(result.downgrade_reason);
	if (result.exactness !== "exact") {
		caveats.push(
			`answered by '${result.provider}' (${result.exactness}); this is not a resolved symbol and should not be cited as one`,
		);
		caveats.push(...result.limitations);
	}
	const ambiguous = result.exactness === "approximate" && result.definitions.length > 1;
	if (ambiguous) {
		caveats.push(
			`${result.definitions.length} candidate definitions from a text search; a symbol genuinely defined in several places is rare and a false match is not`,
		);
	}
	if (result.definitions.length === 0 && result.downgrade_reason) {
		caveats.push(
			"no definition was found, but the preferred backend was unavailable: this is not evidence that no definition exists",
		);
	}

	return {
		trust: result.exactness,
		found: result.definitions.length > 0,
		ambiguous_and_approximate: ambiguous,
		caveats,
	};
}
