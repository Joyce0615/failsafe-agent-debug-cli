/**
 * Persistence + failure-driven retrieval for the project index (item 36).
 *
 * The index lives as a single JSON file under the storage dir. It is opt-in:
 * nothing is built, read, or attached to a packet unless
 * `config.memory.enabled` is set AND the file exists, so the default diagnosis
 * path is byte-identical to before.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SourceLocation } from "../types/common.js";
import type { ParsedError } from "../types/failure.js";
import {
	PROJECT_INDEX_VERSION,
	type ProjectIndex,
	type RetrievalQuery,
	type RetrievalResult,
	retrieveContext,
} from "./project-index.js";

export function saveProjectIndex(path: string, index: ProjectIndex): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(index));
}

/**
 * Load an index, or null when it is missing, unreadable, or was written by a
 * different index version (a stale schema must never be silently trusted).
 */
export function loadProjectIndex(path: string): ProjectIndex | null {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProjectIndex;
		if (parsed.version !== PROJECT_INDEX_VERSION || !Array.isArray(parsed.entries)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Tokens worth matching on: identifier-ish words from the failure text. */
const STOPWORDS = new Set([
	"error",
	"failed",
	"failure",
	"test",
	"the",
	"and",
	"for",
	"not",
	"with",
	"from",
	"this",
	"that",
	"none",
	"null",
	"undefined",
	"object",
	"module",
	"line",
	"file",
]);

/**
 * Turn a failure into a retrieval query: the files its frames name, the
 * symbols it names, and identifier-ish tokens from its messages.
 */
export function queryFromFailure(
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
	recentFixFiles: string[] = [],
): RetrievalQuery {
	const files: string[] = [];
	const symbols: string[] = [];
	const tokens: string[] = [];
	const push = (list: string[], value?: string) => {
		if (value && !list.includes(value)) list.push(value);
	};

	push(files, primaryLocation?.file);
	push(symbols, primaryLocation?.symbol);

	for (const err of errors) {
		push(files, err.location?.file);
		push(files, err.test_file);
		push(symbols, err.test_name);
		for (const frame of err.stack_frames ?? []) {
			if (frame.collapsed) continue; // fold markers are not real files
			push(files, frame.file);
			push(symbols, frame.function);
		}
		for (const raw of err.message.split(/[^A-Za-z_$][^A-Za-z0-9_$]*/)) {
			const token = raw.trim();
			if (token.length > 2 && !STOPWORDS.has(token.toLowerCase())) push(tokens, token);
		}
	}

	return { files, symbols, tokens: tokens.slice(0, 12), recentFixFiles };
}

/**
 * Retrieve project memory for a failure, or null when memory is off / absent.
 */
export function retrieveForFailure(
	indexPath: string,
	errors: ParsedError[],
	primaryLocation: SourceLocation | undefined,
	opts: { budgetBytes?: number; recentFixFiles?: string[] } = {},
): RetrievalResult | null {
	const index = loadProjectIndex(indexPath);
	if (!index) return null;
	const query = queryFromFailure(errors, primaryLocation, opts.recentFixFiles ?? []);
	const result = retrieveContext(index, query, opts.budgetBytes ?? 2000);
	return result.entries.length > 0 ? result : null;
}
