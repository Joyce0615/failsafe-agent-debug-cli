import { SCHEMA_VERSION } from "../types/common.js";
import type { FailureRecord } from "../types/failure.js";
import type { FailureSignature, ReproRecord } from "../types/repro.js";
import { reproId } from "../utils/id.js";
import { extractSelector } from "./selectors.js";
import { computeSignature } from "./signatures.js";
import { verifyRepro } from "./verifier.js";

type StoreInterface = {
	getRepro(failureId: string): ReproRecord | null;
	saveRepro(repro: ReproRecord): void;
};

export async function generateRepro(
	failure: FailureRecord,
	store: StoreInterface,
	options: { verify?: boolean; timeout_ms?: number; cwd?: string } = {},
): Promise<ReproRecord> {
	const shouldVerify = options.verify ?? true;

	// Check if we already have a repro cached
	const existing = store.getRepro(failure.failure_id);
	if (existing && existing.status === "verified") {
		return existing;
	}

	// Collect all parsed errors
	const allErrors = failure.parsed.flatMap((p) => p.errors);

	// Compute the original failure signature
	const originalSignature = computeSignature(allErrors, failure.primary_location);

	// Extract test selector
	const selector = extractSelector(allErrors, failure.command);

	if (!selector) {
		// No selector found — return a file-level repro attempt
		const repro: ReproRecord = {
			schema_version: SCHEMA_VERSION,
			repro_id: reproId(),
			failure_id: failure.failure_id,
			created_at: new Date().toISOString(),
			status: "failed",
			kind: "command_reduction",
			command: failure.command,
			confidence: 0,
			reduction: {},
			signature: originalSignature,
			next: [
				{
					command: `failsafe diagnose ${failure.failure_id}`,
					reason: "No test selector found — try diagnosis instead",
				},
			],
		};
		store.saveRepro(repro);
		return repro;
	}

	// Build the repro record
	const repro: ReproRecord = {
		schema_version: SCHEMA_VERSION,
		repro_id: reproId(),
		failure_id: failure.failure_id,
		created_at: new Date().toISOString(),
		status: "created",
		kind: selector.test_name ? "test_selector" : "file_selector",
		command: selector.command,
		confidence: selector.confidence,
		reduction: {
			original_tests: failure.parsed[0]?.test_summary?.total,
			repro_tests: selector.test_name ? 1 : undefined,
		},
		signature: originalSignature,
		next: [
			{
				command: `failsafe debug ${failure.failure_id} --break primary`,
				reason: "Debug only the minimal failing path",
			},
		],
	};

	// Optionally verify the repro
	if (shouldVerify) {
		const result = await verifyRepro(selector.command, originalSignature, {
			timeout_ms: options.timeout_ms,
			cwd: options.cwd ?? failure.cwd,
		});

		if (result.verified) {
			repro.status = "verified";
			repro.verified_at = new Date().toISOString();
			repro.reduction.repro_runtime_ms = result.duration_ms;
			if (failure.duration_ms > 0) {
				repro.reduction.original_runtime_ms = failure.duration_ms;
			}
		} else {
			repro.status = "failed";
			repro.confidence = Math.max(0, repro.confidence - 0.3);
			repro.next = [
				{
					command: `failsafe diagnose ${failure.failure_id}`,
					reason: result.reason ?? "Repro verification failed",
				},
			];
		}
	}

	store.saveRepro(repro);
	return repro;
}
