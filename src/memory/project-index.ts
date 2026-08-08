/**
 * Project-context external memory for fault localization (item 36).
 *
 * [MemFL](https://arxiv.org/abs/2506.03585) improves fault localization by
 * giving the model a static summary of the project plus dynamic memory of
 * earlier attempts. Failsafe's learned rules are signature/fix statistics: they
 * say nothing about which module owns a symbol, what imports what, or which
 * test covers which file, so a new failure cannot be localized by anything
 * except its own stack.
 *
 * This module builds an **opt-in, versioned** index of exactly that structure
 * and retrieves a *bounded* slice of it for a specific failure.
 *
 * Safety properties, by construction:
 *  - The index stores NO file content — only relative paths, declared symbol
 *    names, import targets, and a content hash. A secret in a file body can
 *    therefore never reach a packet through the index.
 *  - Secret-ish and ignored paths (`.env*`, keys/credentials, `node_modules`,
 *    `.git`, `dist`, `.failsafe`, …) are skipped entirely.
 *  - Entries are invalidated by content hash, so a stale symbol list cannot
 *    outlive an edit.
 *  - Every retrieval is capped by an explicit byte budget.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const PROJECT_INDEX_VERSION = 1;

export type ProjectEntry = {
	/** Stable id — the repo-relative POSIX path. */
	id: string;
	/** sha256 (16 hex) of the file content, for invalidation. */
	hash: string;
	size: number;
	/** Declared top-level symbols (functions/classes/methods). */
	symbols: string[];
	/** Import/require targets referenced by this file. */
	imports: string[];
	/** True when the path looks like a test file. */
	is_test: boolean;
	/**
	 * For a test file, the repo-relative module paths it appears to exercise
	 * (resolved from its relative imports). This is the ownership edge MemFL
	 * uses to jump from a failing test to the module under test.
	 */
	covers: string[];
};

export type ProjectIndex = {
	version: number;
	root: string;
	built_at: string;
	entries: ProjectEntry[];
	/** Files skipped and why, so the index is auditable. */
	skipped: { path: string; reason: "secret" | "binary" | "too_large" }[];
};

export type BuildOptions = {
	/** Hard cap on indexed files (latency + size bound). */
	maxFiles?: number;
	/** Files larger than this are skipped. */
	maxFileBytes?: number;
	/** Extra directory names to skip. */
	excludeDirs?: string[];
};

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".failsafe",
	".pytest_cache",
	"__pycache__",
	".venv",
	"venv",
	"target",
	"coverage",
	".next",
	".cache",
]);

/** Paths that may hold credentials and are never indexed. */
const SECRET_PATH =
	/(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|id_rsa.*|.*credentials.*|.*secrets?.*)$/i;

const INDEXABLE_EXT = new Set([
	"py",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"mts",
	"cts",
	"rb",
	"go",
	"rs",
	"java",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
]);

const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_FILE = /(^|[._-])(test|spec)([._-]|$)|_test\.|\.test\.|\.spec\./i;

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

function extOf(path: string): string {
	return path.split(".").pop()?.toLowerCase() ?? "";
}

/** Declared symbol names, by language family. Bounded and regex-based. */
export function extractSymbols(source: string, file: string): string[] {
	const ext = extOf(file);
	const patterns: RegExp[] =
		ext === "py"
			? [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm]
			: ext === "rb"
				? [/^\s*def\s+([A-Za-z_][\w?!]*)/gm, /^\s*(?:class|module)\s+([A-Za-z_]\w*)/gm]
				: ext === "go"
					? [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^\s*type\s+([A-Za-z_]\w*)/gm]
					: ext === "rs"
						? [/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/gm, /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm]
						: [
								/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
								/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
								/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm,
								/^\s*(?:public|private|protected|static|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
							];

	const symbols: string[] = [];
	for (const pattern of patterns) {
		for (const m of source.matchAll(pattern)) {
			const name = m[1];
			if (name && !symbols.includes(name) && name.length > 1) symbols.push(name);
		}
	}
	return symbols.slice(0, 200);
}

/** Import/require targets referenced by a file. */
export function extractImports(source: string): string[] {
	const targets: string[] = [];
	const add = (t?: string) => {
		if (t && !targets.includes(t)) targets.push(t);
	};
	for (const m of source.matchAll(/^\s*(?:import|export)[^'"\n]*['"]([^'"]+)['"]/gm)) add(m[1]);
	for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
	for (const m of source.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) add(m[1]);
	for (const m of source.matchAll(/^\s*import\s+([\w.]+)\s*$/gm)) add(m[1]);
	return targets.slice(0, 100);
}

/** Resolve a test file's relative imports to repo-relative module paths. */
function resolveCovers(testPath: string, imports: string[], known: Set<string>): string[] {
	const dir = testPath.includes("/") ? testPath.slice(0, testPath.lastIndexOf("/")) : "";
	const covers: string[] = [];
	for (const target of imports) {
		const candidates: string[] = [];
		if (target.startsWith(".")) {
			const joined = normalizeRelative(dir, target);
			candidates.push(joined);
			for (const ext of INDEXABLE_EXT) {
				candidates.push(`${joined.replace(/\.(js|ts|mjs|cjs)$/, "")}.${ext}`);
			}
		} else {
			// Python-style dotted module: a.b.c -> a/b/c.py
			const dotted = target.replace(/\./g, "/");
			candidates.push(`${dotted}.py`, `${dotted}.rb`);
		}
		for (const candidate of candidates) {
			if (known.has(candidate) && !covers.includes(candidate)) {
				covers.push(candidate);
				break;
			}
		}
	}
	return covers;
}

function normalizeRelative(dir: string, target: string): string {
	const parts = (dir ? `${dir}/${target}` : target).split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return stack.join("/");
}

function walk(root: string, dir: string, out: string[], opts: Required<BuildOptions>): void {
	if (out.length >= opts.maxFiles) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (out.length >= opts.maxFiles) return;
		if (SKIP_DIRS.has(name) || opts.excludeDirs.includes(name)) continue;
		const full = join(dir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(root, full, out, opts);
		} else if (st.isFile()) {
			out.push(full);
		}
	}
}

/**
 * Build a project index rooted at `root`. Reads file contents only to derive
 * symbols/imports/hash — no content is retained.
 */
export function buildProjectIndex(root: string, options: BuildOptions = {}): ProjectIndex {
	const opts: Required<BuildOptions> = {
		maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
		maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		excludeDirs: options.excludeDirs ?? [],
	};

	const files: string[] = [];
	walk(root, root, files, opts);

	const entries: ProjectEntry[] = [];
	const skipped: ProjectIndex["skipped"] = [];

	for (const full of files) {
		const rel = relative(root, full).split("\\").join("/");
		if (SECRET_PATH.test(rel)) {
			skipped.push({ path: rel, reason: "secret" });
			continue;
		}
		if (!INDEXABLE_EXT.has(extOf(rel))) continue;
		let size = 0;
		try {
			size = statSync(full).size;
		} catch {
			continue;
		}
		if (size > opts.maxFileBytes) {
			skipped.push({ path: rel, reason: "too_large" });
			continue;
		}
		let source: string;
		try {
			source = readFileSync(full, "utf-8");
		} catch {
			skipped.push({ path: rel, reason: "binary" });
			continue;
		}
		entries.push({
			id: rel,
			hash: hashContent(source),
			size,
			symbols: extractSymbols(source, rel),
			imports: extractImports(source),
			is_test: TEST_PATH.test(rel) || TEST_FILE.test(rel),
			covers: [],
		});
	}

	// Second pass: test-ownership edges need the full path set.
	const known = new Set(entries.map((e) => e.id));
	for (const entry of entries) {
		if (entry.is_test) entry.covers = resolveCovers(entry.id, entry.imports, known);
	}

	return {
		version: PROJECT_INDEX_VERSION,
		root,
		built_at: new Date().toISOString(),
		entries,
		skipped,
	};
}

/**
 * Re-hash indexed files and rebuild only the entries whose content changed.
 * Deleted files drop out; new files are NOT added (a full rebuild does that),
 * so refresh stays cheap and predictable.
 *
 * Returns the updated index plus the ids that changed/were removed.
 */
export function refreshProjectIndex(index: ProjectIndex): {
	index: ProjectIndex;
	changed: string[];
	removed: string[];
} {
	const changed: string[] = [];
	const removed: string[] = [];
	const entries: ProjectEntry[] = [];

	for (const entry of index.entries) {
		const full = join(index.root, entry.id);
		let source: string;
		try {
			source = readFileSync(full, "utf-8");
		} catch {
			removed.push(entry.id);
			continue;
		}
		const hash = hashContent(source);
		if (hash === entry.hash) {
			entries.push(entry);
			continue;
		}
		changed.push(entry.id);
		entries.push({
			...entry,
			hash,
			size: Buffer.byteLength(source),
			symbols: extractSymbols(source, entry.id),
			imports: extractImports(source),
		});
	}

	const known = new Set(entries.map((e) => e.id));
	for (const entry of entries) {
		if (entry.is_test) entry.covers = resolveCovers(entry.id, entry.imports, known);
	}

	return {
		index: { ...index, built_at: new Date().toISOString(), entries },
		changed,
		removed,
	};
}

export type RetrievalQuery = {
	/** Files named by the failure's stack frames / primary location. */
	files?: string[];
	/** Function/symbol names named by the failure. */
	symbols?: string[];
	/** Free tokens from the failure message / signature. */
	tokens?: string[];
	/** Files touched by recent (failed) fix attempts — MemFL's dynamic memory. */
	recentFixFiles?: string[];
};

export type RetrievedEntry = {
	id: string;
	score: number;
	/** Why this entry was retrieved, for auditability. */
	reason: string;
	symbols: string[];
	is_test: boolean;
};

export type RetrievalResult = {
	index_version: number;
	budget_bytes: number;
	used_bytes: number;
	considered: number;
	entries: RetrievedEntry[];
};

const SCORE = {
	exactFile: 4,
	basenameFile: 2,
	symbol: 2.5,
	token: 0.75,
	ownsMatchedFile: 1.5,
	recentFix: 1,
	/** Multiplier applied to test files (see the ranking note below). */
	testWeight: 0.75,
};

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

/**
 * Retrieve a bounded, scored slice of the index for one failure.
 *
 * Lexical only — deliberately, so it is deterministic, offline, and reviewable;
 * embeddings would be a later refinement over this baseline. Every returned
 * entry carries its score and the reason it matched.
 */
export function retrieveContext(
	index: ProjectIndex,
	query: RetrievalQuery,
	budgetBytes = 2000,
): RetrievalResult {
	const queryFiles = (query.files ?? []).map((f) => f.split("\\").join("/"));
	const queryBases = new Set(queryFiles.map(basename));
	const querySymbols = new Set(query.symbols ?? []);
	const tokens = (query.tokens ?? []).filter((t) => t.length > 2).map((t) => t.toLowerCase());
	const recentFix = new Set((query.recentFixFiles ?? []).map((f) => f.split("\\").join("/")));

	const matchedFiles = new Set<string>();
	const scored: RetrievedEntry[] = [];

	for (const entry of index.entries) {
		let score = 0;
		const reasons: string[] = [];

		if (queryFiles.some((f) => f === entry.id || f.endsWith(`/${entry.id}`))) {
			score += SCORE.exactFile;
			reasons.push("stack frame file");
			matchedFiles.add(entry.id);
		} else if (queryBases.has(basename(entry.id))) {
			// A same-named file in a different module is a weaker signal — this
			// is exactly the distractor MemFL has to rank below the real owner.
			score += SCORE.basenameFile;
			reasons.push("file name match");
		}

		const symbolHits = entry.symbols.filter((s) => querySymbols.has(s));
		if (symbolHits.length > 0) {
			score += SCORE.symbol * Math.min(symbolHits.length, 3);
			reasons.push(`declares ${symbolHits.slice(0, 3).join(", ")}`);
		}

		if (tokens.length > 0) {
			const haystack = `${entry.id} ${entry.symbols.join(" ")}`.toLowerCase();
			const hits = tokens.filter((t) => haystack.includes(t)).length;
			if (hits > 0) {
				score += SCORE.token * Math.min(hits, 3);
				reasons.push(`${hits} token match(es)`);
			}
		}

		if (recentFix.has(entry.id)) {
			score += SCORE.recentFix;
			reasons.push("touched by a recent fix attempt");
		}

		if (score > 0)
			scored.push({
				id: entry.id,
				score,
				reason: reasons.join("; "),
				symbols: entry.symbols.slice(0, 8),
				is_test: entry.is_test,
			});
	}

	// Ownership boost: a test that covers a file the stack already implicated.
	for (const entry of index.entries) {
		if (!entry.is_test) continue;
		if (!entry.covers.some((c) => matchedFiles.has(c))) continue;
		const existing = scored.find((s) => s.id === entry.id);
		if (existing) {
			existing.score += SCORE.ownsMatchedFile;
			existing.reason += "; covers an implicated module";
		} else {
			scored.push({
				id: entry.id,
				score: SCORE.ownsMatchedFile,
				reason: "covers an implicated module",
				symbols: entry.symbols.slice(0, 8),
				is_test: true,
			});
		}
	}

	// A test file names where the failure *surfaced*; the fault usually lives in
	// the module it exercises. Keep tests retrievable (they are the ownership
	// edge) but rank them below source modules with comparable evidence.
	for (const entry of scored) {
		if (entry.is_test) entry.score = Math.round(entry.score * SCORE.testWeight * 100) / 100;
	}

	scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

	// Fill to the byte budget, highest score first.
	const entries: RetrievedEntry[] = [];
	let used = 0;
	for (const candidate of scored) {
		const cost = Buffer.byteLength(JSON.stringify(candidate));
		if (used + cost > budgetBytes) break;
		entries.push(candidate);
		used += cost;
	}

	return {
		index_version: index.version,
		budget_bytes: budgetBytes,
		used_bytes: used,
		considered: scored.length,
		entries,
	};
}
