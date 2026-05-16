/**
 * Command execution and capture.
 * Runs shell commands and records their full output, timing, and environment.
 */

import type { EnvFingerprint } from "../types/common.js";
import { captureEnvFingerprint } from "./env.js";

export type RunResult = {
	command: string;
	cwd: string;
	exit_code: number | null;
	stdout: string;
	stderr: string;
	combined: string;
	duration_ms: number;
	timed_out: boolean;
	env_fingerprint: EnvFingerprint;
};

/**
 * Executes a shell command and captures all output, timing, and environment info.
 *
 * Uses `sh -c` to run the command, capturing stdout and stderr separately.
 * Handles timeouts by killing the process and setting timed_out = true.
 *
 * @param command - The shell command to execute
 * @param options - Optional cwd, timeout, and env overrides
 * @returns Full result including output, exit code, duration, and environment fingerprint
 */
export async function runCommand(
	command: string,
	options?: {
		cwd?: string;
		timeout_ms?: number;
		env?: Record<string, string>;
		argv?: string[];
	},
): Promise<RunResult> {
	const cwd = options?.cwd ?? process.cwd();
	const timeoutMs = options?.timeout_ms ?? 120_000;

	const startTime = performance.now();
	let timedOut = false;
	let exitCode: number | null = null;
	let stdoutText = "";
	let stderrText = "";

	// argv mode: run the command directly without shell interpretation.
	// This is safer for agent workflows since no shell injection is possible.
	const spawnArgs = options?.argv ?? ["sh", "-c", command];

	const proc = Bun.spawn(spawnArgs, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: options?.env ? { ...process.env, ...options.env } : undefined,
	});

	// Set up timeout
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeoutId = setTimeout(() => {
			proc.kill();
			resolve("timeout");
		}, timeoutMs);
	});

	// Wait for process to exit or timeout
	const exitPromise = (async () => {
		const code = await proc.exited;
		return code;
	})();

	const raceResult = await Promise.race([
		exitPromise.then((code) => ({ kind: "exit" as const, code })),
		timeoutPromise.then(() => ({ kind: "timeout" as const })),
	]);

	if (raceResult.kind === "timeout") {
		timedOut = true;
		exitCode = null;
	} else {
		exitCode = raceResult.code;
	}

	// Clear the timeout if the process finished before the timeout
	if (timeoutId !== undefined) {
		clearTimeout(timeoutId);
	}

	// Read stdout and stderr — even after timeout, read what's available
	try {
		stdoutText = await new Response(proc.stdout).text();
	} catch {
		stdoutText = "";
	}

	try {
		stderrText = await new Response(proc.stderr).text();
	} catch {
		stderrText = "";
	}

	const endTime = performance.now();
	const durationMs = Math.round(endTime - startTime);

	// Build combined output by interleaving stdout and stderr.
	// Since we capture them as separate streams we cannot truly interleave
	// by timestamp, so we concatenate stdout then stderr with a separator
	// when both are non-empty.
	let combined: string;
	if (stdoutText && stderrText) {
		combined = `${stdoutText}\n--- stderr ---\n${stderrText}`;
	} else {
		combined = stdoutText || stderrText;
	}

	// Capture environment fingerprint concurrently would add latency;
	// we call it after the command finishes so it reflects the same env
	const envFingerprint = await captureEnvFingerprint();

	return {
		command,
		cwd,
		exit_code: exitCode,
		stdout: stdoutText,
		stderr: stderrText,
		combined,
		duration_ms: durationMs,
		timed_out: timedOut,
		env_fingerprint: envFingerprint,
	};
}
