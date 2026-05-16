/**
 * Environment fingerprinting.
 * Captures runtime environment details for reproducibility context.
 */

import type { EnvFingerprint } from "../types/common.js";

const TOOL_TIMEOUT_MS = 2000;

/**
 * Runs a shell command with a timeout, returning trimmed stdout or undefined on failure.
 */
async function runQuiet(args: string[]): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "ignore",
		});

		const timeoutPromise = new Promise<undefined>((resolve) => {
			setTimeout(() => {
				proc.kill();
				resolve(undefined);
			}, TOOL_TIMEOUT_MS);
		});

		const resultPromise = (async () => {
			const exitCode = await proc.exited;
			if (exitCode !== 0) return undefined;
			const text = await new Response(proc.stdout).text();
			return text.trim() || undefined;
		})();

		return await Promise.race([resultPromise, timeoutPromise]);
	} catch {
		return undefined;
	}
}

/**
 * Captures a fingerprint of the current environment including
 * runtime versions, OS info, git state, and working directory.
 *
 * Each external tool call has a 2-second timeout and will silently
 * return undefined if the tool is not available.
 */
export async function captureEnvFingerprint(): Promise<EnvFingerprint> {
	const [nodeVersion, pythonVersion, gitCommitShort, gitBranch] = await Promise.all([
		runQuiet(["node", "--version"]),
		runQuiet(["python3", "--version"]),
		runQuiet(["git", "rev-parse", "--short", "HEAD"]),
		runQuiet(["git", "branch", "--show-current"]),
	]);

	return {
		node_version: nodeVersion?.replace(/^v/, ""),
		python_version: pythonVersion?.replace(/^Python\s+/, ""),
		bun_version: Bun.version,
		os: process.platform,
		arch: process.arch,
		cwd: process.cwd(),
		git_branch: gitBranch,
		git_commit_short: gitCommitShort,
	};
}
