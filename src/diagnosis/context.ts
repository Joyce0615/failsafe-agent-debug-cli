import { existsSync, readFileSync } from "node:fs";
import type { SourceLocation } from "../types/common.js";
import type { ContextSlice } from "../types/diagnosis.js";

export async function extractSourceSlice(
	location: SourceLocation,
	contextLines = 5,
): Promise<ContextSlice | null> {
	try {
		if (!existsSync(location.file)) return null;
		const content = readFileSync(location.file, "utf-8");
		const lines = content.split("\n");
		const startLine = Math.max(1, location.line - contextLines);
		const endLine = Math.min(lines.length, location.line + contextLines);
		const text = lines
			.slice(startLine - 1, endLine)
			.map((l, i) => `${startLine + i}: ${l}`)
			.join("\n");
		return { file: location.file, start_line: startLine, end_line: endLine, text };
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

		// Find the end of the test function (heuristic: next function at same/lower indent, or end of file)
		const startIndent = lines[startIdx].match(/^\s*/)?.[0].length ?? 0;
		let endIdx = startIdx + 1;
		for (; endIdx < lines.length; endIdx++) {
			const line = lines[endIdx];
			if (line.trim() === "") continue;
			const indent = line.match(/^\s*/)?.[0].length ?? 0;
			// If we hit a line at the same or lower indent that looks like a new definition, stop
			if (
				indent <= startIndent &&
				/^\s*(def |class |it\(|test\(|describe\(|function )/.test(line)
			) {
				break;
			}
		}

		const startLine = startIdx + 1;
		const endLine = endIdx;
		const text = lines
			.slice(startIdx, endIdx)
			.map((l, i) => `${startLine + i}: ${l}`)
			.join("\n");

		return { file: testFile, start_line: startLine, end_line: endLine, text };
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

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
