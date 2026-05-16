import type { LearnedRule } from "./types.js";

export type LifecycleStore = {
	listLearnedRules(opts?: { lifecycle?: string }): LearnedRule[];
	updateLearnedRule(ruleId: string, updates: Partial<LearnedRule>): void;
	markStaleRules(beforeDate: string): number;
};

/**
 * Mark learned rules as stale if they haven't been seen within `staleDays` days.
 * Returns the number of rules marked stale.
 */
export function markStaleRules(store: LifecycleStore, staleDays: number): number {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - staleDays);
	const cutoffIsoDate = cutoff.toISOString();
	return store.markStaleRules(cutoffIsoDate);
}

/**
 * Disable a learned rule by setting its lifecycle to "disabled".
 */
export function disableRule(store: LifecycleStore, ruleId: string): void {
	store.updateLearnedRule(ruleId, { lifecycle: "disabled" });
}

/**
 * Re-enable a learned rule by setting its lifecycle back to "active".
 */
export function enableRule(store: LifecycleStore, ruleId: string): void {
	store.updateLearnedRule(ruleId, { lifecycle: "active" });
}
