import type { FlakyRecord } from "./types.js";

export type FlakyStore = {
	getLatestSuccessfulFix(signatureHash: string): { resolved_at: string } | null;
	countUnresolvedAfterDate(signatureHash: string, afterDate: string): number;
	getFlakySignature(hash: string): FlakyRecord | null;
	upsertFlakySignature(record: FlakyRecord): void;
	listFlakySignatures(): FlakyRecord[];
};

/**
 * Check whether a failure signature is "flaky" — i.e., it recurs after
 * supposedly being fixed. A signature is flaky if it has at least
 * `threshold` unresolved failures after its most recent successful fix.
 *
 * If the signature has never been fixed, it cannot be flaky (returns false).
 * When detected as flaky, a FlakyRecord is upserted in the store.
 */
export function checkFlaky(store: FlakyStore, signatureHash: string, threshold: number): boolean {
	// Get latest successful fix for this hash
	const latestFix = store.getLatestSuccessfulFix(signatureHash);
	if (!latestFix) {
		// Can't be flaky without a prior fix
		return false;
	}

	// Count unresolved failures after the fix date
	const unresolvedCount = store.countUnresolvedAfterDate(signatureHash, latestFix.resolved_at);

	if (unresolvedCount < threshold) {
		return false;
	}

	// Mark as flaky
	const now = new Date().toISOString();
	const existing = store.getFlakySignature(signatureHash);

	const record: FlakyRecord = {
		signature_hash: signatureHash,
		failure_count_after_fix: unresolvedCount,
		first_recurrence_at: existing?.first_recurrence_at ?? now,
		last_recurrence_at: now,
		marked_flaky_at: existing?.marked_flaky_at ?? now,
	};

	store.upsertFlakySignature(record);
	return true;
}

/**
 * List all signatures currently marked as flaky.
 */
export function listFlaky(store: FlakyStore): FlakyRecord[] {
	return store.listFlakySignatures();
}
