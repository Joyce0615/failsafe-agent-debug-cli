import { existsSync, readFileSync } from "node:fs";
import type { SourceLocation } from "../types/common.js";
import type { ContextSlice } from "../types/diagnosis.js";
import { findEnclosingUnit, unitSpanFromHeader } from "./ast.js";

/**
 * Upper bound on an AST-derived slice. A 900-line god function is not a
 * "minimal context"; past this we keep the unit's identity but return a window
 * around the failing line, clamped to the unit's own boundaries.
 */
const MAX_UNIT_LINES = 120;

function renderSlice(
	file: string,
	lines: string[],
	startLine: number,
	endLine: number,
	extra: Partial<ContextSlice> = {},
): ContextSlice {
	const text = lines
		.slice(startLine - 1, endLine)
		.map((l, i) => `${startLine + i}: ${l}`)
		.join("\n");
	return { file, start_line: startLine, end_line: endLine, text, ...extra };
}

/**
 * Extract the source context around a failure location.
 *
 * Prefers the *enclosing function/class* span (item 29) so the slice is a
 * syntactic unit rather than an arbitrary cut; falls back to the original
 * ±`contextLines` window when no unit can be identified (unknown language, no
 * grammar, top-level statement).
 */
export async function extractSourceSlice(
	location: SourceLocation,
	contextLines = 5,
): Promise<ContextSlice | null> {
	try {
		if (!existsSync(location.file)) return null;
		const content = readFileSync(location.file, "utf-8");
		const lines = content.split("\n");

		const unit = findEnclosingUnit(content, location.line, location.file);
		if (unit) {
			const unitLines = unit.end_line - unit.start_line + 1;
			if (unitLines <= MAX_UNIT_LINES) {
				return renderSlice(location.file, lines, unit.start_line, unit.end_line, {
					symbol: unit.name,
					unit_kind: unit.kind,
				});
			}
			// Oversized unit: window inside it, never spilling into a neighbour.
			const startLine = Math.max(unit.start_line, location.line - contextLines);
			const endLine = Math.min(unit.end_line, location.line + contextLines);
			return renderSlice(location.file, lines, startLine, endLine, {
				symbol: unit.name,
				unit_kind: unit.kind,
				truncated_unit: true,
			});
		}

		const startLine = Math.max(1, location.line - contextLines);
		const endLine = Math.min(lines.length, location.line + contextLines);
		return renderSlice(location.file, lines, startLine, endLine);
	} catch {
		return null;
	}
}

export async function extractTestSlice(
	testFile: string,
	testName: string,
): Promise<ContextSlice | null> {
	try {
		if (!existsSync(testFile)) return null;
		const content = readFileSync(testFile, "utf-8");
		const lines = content.split("\n");

		// Try to find the test function by name
		const patterns = [
			// Python: def test_name(
			new RegExp(`^\\s*def\\s+${escapeRegex(testName)}\\s*\\(`),
			// Python: class-scoped with method name
			new RegExp(`^\\s*def\\s+${escapeRegex(testName.split("::").pop() || testName)}\\s*\\(`),
			// JS/TS: it("name" or test("name"
			new RegExp(`(?:it|test)\\s*\\(\\s*['"\`]${escapeRegex(testName)}['"\`]`),
			// JS/TS: partial match
			new RegExp(`(?:it|test)\\s*\\(\\s*['"\`][^'"]*${escapeRegex(testName)}[^'"]*['"\`]`),
		];

		let startIdx = -1;
		for (const pattern of patterns) {
			for (let i = 0; i < lines.length; i++) {
				if (pattern.test(lines[i])) {
					startIdx = i;
					break;
				}
			}
			if (startIdx >= 0) break;
		}

		if (startIdx < 0) return null;

		const startLine = startIdx + 1;

		// Bound the test body by its syntactic span (item 29). Only if that is
		// unavailable do we fall back to the old indentation/next-definition
		// heuristic, which over- or under-shoots on nested and multi-line tests.
		let endLine = unitSpanFromHeader(content, startLine, testFile);
		if (endLine === null) {
			const startIndent = lines[startIdx].match(/^\s*/)?.[0].length ?? 0;
			let endIdx = startIdx + 1;
			for (; endIdx < lines.length; endIdx++) {
				const line = lines[endIdx];
				if (line.trim() === "") continue;
				const indent = line.match(/^\s*/)?.[0].length ?? 0;
				// A line at the same or lower indent that starts a new definition ends the test.
				if (
					indent <= startIndent &&
					/^\s*(def |class |it\(|test\(|describe\(|function )/.test(line)
				) {
					break;
				}
			}
			endLine = endIdx;
		}

		return renderSlice(testFile, lines, startLine, endLine);
	} catch {
		return null;
	}
}

/**
 * Find the git repository root for a given file path.
 * Returns null if not in a git repo.
 */
async function findGitRoot(filePath: string): Promise<string | null> {
	try {
		// Determine a valid starting directory
		const startDir = filePath.startsWith("/")
			? filePath.substring(0, filePath.lastIndexOf("/")) || "/"
			: process.cwd();

		const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
			cwd: startDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;
		return output.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Check whether the repo has at least one commit (HEAD exists).
 */
async function hasHead(gitRoot: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		await new Response(proc.stdout).text();
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

/**
 * Make a file path relative to a root directory.
 */
function relativeTo(filePath: string, root: string): string {
	const abs = filePath.startsWith("/") ? filePath : `${process.cwd()}/${filePath}`;
	if (abs.startsWith(root)) {
		const rel = abs.substring(root.length);
		return rel.startsWith("/") ? rel.substring(1) : rel;
	}
	return filePath;
}

export async function extractRecentDiff(file: string): Promise<string | null> {
	try {
		const gitRoot = await findGitRoot(file);
		if (!gitRoot) return null;

		// Skip repos without any commits (no HEAD)
		if (!(await hasHead(gitRoot))) return null;

		const relPath = relativeTo(file, gitRoot);

		const proc = Bun.spawn(["git", "diff", "HEAD", "--", relPath], {
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;
		return text.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Files modified in the working tree relative to HEAD, as repo-relative paths.
 *
 * Used to describe *what an agent actually changed* between a failure and a
 * `verify` run (item 32). Returns an empty list outside a git repo, in a repo
 * with no commits, or on any error — this must never fail a verification.
 */
export async function listChangedFiles(cwd: string, limit = 10): Promise<string[]> {
	try {
		const gitRoot = await findGitRoot(cwd.endsWith("/") ? cwd : `${cwd}/`);
		if (!gitRoot || !(await hasHead(gitRoot))) return [];
		const proc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const text = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return [];
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.slice(0, limit);
	} catch {
		return [];
	}
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
