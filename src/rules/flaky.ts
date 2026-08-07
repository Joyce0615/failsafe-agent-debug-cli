import type { FlakyRecord } from "./types.js";

export type FlakyStore = {
	getLatestSuccessfulFix(signatureHash: string): { resolved_at: string } | null;
	countUnresolvedAfterDate(signatureHash: string, afterDate: string): number;
	getFlakySignature(hash: string): FlakyRecord | null;
	upsertFlakySignature(record: FlakyRecord): void;
	listFlakySignatures(): FlakyRecord[];
};

/**
 * Check whether a failure signature is "flaky".
 *
 * Evidence beats inference (item 33): if the minimal repro has actually been
 * re-run N times (`failsafe verify --flaky-check N`), that verdict is
 * authoritative — mixed pass/fail confirms flakiness, and unanimous verdicts
 * *refute* it, so a deterministically broken test can no longer be mislabeled
 * flaky and have its diagnosis confidence capped.
 *
 * With no rerun evidence this falls back to the original history heuristic: a
 * signature is flaky if it has at least `threshold` unresolved failures after
 * its most recent successful fix. Without a prior fix it cannot be flaky.
 * When detected as flaky, a FlakyRecord is upserted in the store.
 */
export function checkFlaky(store: FlakyStore, signatureHash: string, threshold: number): boolean {
	const evidence = store.getFlakySignature(signatureHash);
	if (evidence?.rerun_confirmed !== undefined) {
		return evidence.rerun_confirmed;
	}

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

/** One rerun's verdict. `passed` is exit code 0. */
export type RerunOutcome = { passed: boolean; duration_ms?: number };

/** Executes the minimal repro once. Injected so the logic stays testable. */
export type RerunFn = (attempt: number) => Promise<RerunOutcome>;

export type FlakyCheckResult = {
	runs: number;
	passed: number;
	failed: number;
	/**
	 * `flaky` — verdicts disagreed across reruns (the empirical definition);
	 * `deterministic_failure` — every rerun failed;
	 * `deterministic_pass` — every rerun passed (the failure no longer
	 * reproduces at all, which `verify` already reports, so it is deliberately
	 * NOT treated as flaky evidence either way).
	 */
	verdict: "flaky" | "deterministic_failure" | "deterministic_pass";
	confirmed_flaky: boolean;
	note: string;
};

/**
 * Confirm or refute flakiness by actually re-running the minimal repro `runs`
 * times and looking for a verdict change (pytest-rerunfailures / CANNIER's
 * method), then persisting that evidence on the signature's `FlakyRecord`.
 *
 * The executor is injected, so this function performs no I/O itself.
 */
export async function confirmFlakyByRerun(
	store: FlakyStore,
	signatureHash: string,
	runs: number,
	rerun: RerunFn,
): Promise<FlakyCheckResult> {
	const total = Math.max(1, Math.floor(runs));
	let passed = 0;
	let failed = 0;
	for (let i = 0; i < total; i++) {
		const outcome = await rerun(i);
		if (outcome.passed) passed++;
		else failed++;
	}

	const mixed = passed > 0 && failed > 0;
	const verdict: FlakyCheckResult["verdict"] = mixed
		? "flaky"
		: failed === total
			? "deterministic_failure"
			: "deterministic_pass";

	const now = new Date().toISOString();
	const existing = store.getFlakySignature(signatureHash);

	// A unanimous PASS says the failure stopped reproducing — that could be the
	// fix working rather than non-determinism, so it records the counts without
	// asserting a verdict (leaving the heuristic in charge).
	const rerunConfirmed = verdict === "deterministic_pass" ? undefined : mixed;

	store.upsertFlakySignature({
		signature_hash: signatureHash,
		failure_count_after_fix: existing?.failure_count_after_fix ?? failed,
		first_recurrence_at: existing?.first_recurrence_at ?? now,
		last_recurrence_at: now,
		marked_flaky_at: mixed ? (existing?.marked_flaky_at ?? now) : existing?.marked_flaky_at,
		rerun_checked_at: now,
		rerun_total: total,
		rerun_passed: passed,
		rerun_failed: failed,
		rerun_confirmed: rerunConfirmed,
	});

	const note = mixed
		? `Verdict changed across reruns (${passed} passed / ${failed} failed of ${total}): confirmed flaky.`
		: verdict === "deterministic_failure"
			? `All ${total} reruns failed: the failure is deterministic, NOT flaky — treat the diagnosis at face value.`
			: `All ${total} reruns passed: the failure no longer reproduces. This may be a completed fix rather than flakiness, so no flaky verdict was recorded.`;

	return { runs: total, passed, failed, verdict, confirmed_flaky: mixed, note };
}
