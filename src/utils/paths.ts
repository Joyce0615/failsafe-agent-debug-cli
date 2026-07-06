/**
 * Cross-platform normalization for filesystem paths extracted from tool and
 * compiler output. Stack traces and diagnostics on Windows use backslash
 * separators and drive letters (`C:\src\app.ts`), while POSIX agents emit
 * forward slashes. To give every consumer a stable, comparable
 * `primary_location.file` we canonicalize emitted *source locations* to a
 * single POSIX-style form regardless of the platform that produced them.
 *
 * This is deliberately separate from local-filesystem path building (storage
 * dirs, run folders), which must keep the host-native separator and is handled
 * with `node:path` `join`/`isAbsolute` at the call sites.
 */
import type { SourceLocation } from "../types/common.js";

/**
 * Canonicalize a path string into a stable, POSIX-style form:
 *  - Windows backslash separators become forward slashes.
 *  - Runs of redundant separators collapse to one (a leading UNC `//` is kept).
 *  - A Windows drive letter is upper-cased (`c:/x` -> `C:/x`) for stable
 *    comparison and de-duplication.
 *
 * Returns the input unchanged when it is empty. Does not touch the filesystem
 * and never throws.
 */
export function normalizePath(file: string): string {
	if (!file) return file;
	// Windows separators -> POSIX.
	let p = file.replace(/\\/g, "/");
	// Collapse duplicate separators, preserving a leading UNC `//`.
	const unc = p.startsWith("//");
	p = p.replace(/\/{2,}/g, "/");
	if (unc) p = `/${p}`;
	// Upper-case a leading Windows drive letter for stable comparison.
	p = p.replace(/^([a-zA-Z]):\//, (_m, d: string) => `${d.toUpperCase()}:/`);
	return p;
}

/**
 * Return a copy of a {@link SourceLocation} with its `file` normalized via
 * {@link normalizePath}. All other fields are preserved.
 */
export function normalizeLocation(loc: SourceLocation): SourceLocation {
	return { ...loc, file: normalizePath(loc.file) };
}
