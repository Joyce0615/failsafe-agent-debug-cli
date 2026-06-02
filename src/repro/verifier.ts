import { runCommand } from "../capture/runner.js";
import { detectAndParse } from "../parsers/index.js";
import { getDefaultPolicy, validateCommand } from "../security/policy.js";
import type { FailureSignature } from "../types/repro.js";
import { computeSignature } from "./signatures.js";
import { signaturesMatch } from "./signatures.js";

export type VerifyResult = {
	verified: boolean;
	new_signature?: FailureSignature;
	exit_code: number | null;
	duration_ms: number;
	reason?: string;
};

export async function verifyRepro(
	candidateCommand: string,
	originalSignature: FailureSignature,
	options: { timeout_ms?: number; cwd?: string } = {},
): Promise<VerifyResult> {
	// Re-validate the command against policy before execution
	const policy = getDefaultPolicy();
	const validation = validateCommand(candidateCommand, policy);
	if (!validation.allowed) {
		return {
			verified: false,
			exit_code: null,
			duration_ms: 0,
			reason: `Command blocked by policy: ${validation.reason}`,
		};
	}

	const result = await runCommand(candidateCommand, {
		cwd: options.cwd,
		timeout_ms: options.timeout_ms ?? 60_000,
	});

	// If it passed, it's not a valid repro
	if (result.exit_code === 0) {
		return {
			verified: false,
			exit_code: result.exit_code,
			duration_ms: result.duration_ms,
			reason: "Candidate command passed (exit code 0) — does not reproduce the failure",
		};
	}

	// Parse the output and compute signature
	const parsed = detectAndParse(result.stdout, result.stderr, candidateCommand);
	const allErrors = parsed.flatMap((p) => p.errors);
	const newSignature = computeSignature(allErrors);

	// Compare signatures
	const similarity = signaturesMatch(originalSignature, newSignature);

	if (similarity >= 0.5) {
		return {
			verified: true,
			new_signature: newSignature,
			exit_code: result.exit_code,
			duration_ms: result.duration_ms,
		};
	}

	return {
		verified: false,
		new_signature: newSignature,
		exit_code: result.exit_code,
		duration_ms: result.duration_ms,
		reason: `Failure signature mismatch (similarity: ${Math.round(similarity * 100)}%)`,
	};
}
