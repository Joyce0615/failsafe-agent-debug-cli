import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { DeclaredRule, LearnedRule } from "../rules/types.js";
import { SCHEMA_VERSION } from "../types/common.js";

/**
 * Stable fingerprint of the declared-rule set. Two rule sets that would produce
 * the same diagnosis hash to the same value; any edit (add/remove/change a rule)
 * changes the fingerprint and therefore the cache key, invalidating stale
 * cached diagnoses.
 */
export function declaredRulesFingerprint(rules: DeclaredRule[]): string {
	if (rules.length === 0) return "none";
	return createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 12);
}

/**
 * Fingerprint of the learned-rule state for a signature. Folds in exactly the
 * mutable fields that decide whether the learned tier wins and with what output
 * — `lifecycle` (promotion state), `occurrence_count` (drives sample-size
 * confidence calibration), `success_count`, and the calibrated `confidence` —
 * plus the rule id. When a learned rule is promoted (lifecycle → active),
 * accrues occurrences, or is boosted by a successful fix, this fingerprint
 * changes, so a prior cached diagnosis for the same signature is invalidated
 * and the now-stronger learned diagnosis is recomputed instead of masked.
 */
export function learnedRuleFingerprint(rule: LearnedRule | null | undefined): string {
	if (!rule) return "none";
	const material = [
		rule.rule_id,
		rule.lifecycle,
		rule.occurrence_count,
		rule.success_count,
		rule.confidence,
	].join("|");
	return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

/**
 * Cache key for a diagnosis: schema version + declared-rule fingerprint +
 * learned-rule fingerprint + signature hash. Folding in the schema version,
 * declared-rule fingerprint, and learned-rule state means a schema bump, a
 * rules edit, or a learned-rule promotion/boost transparently invalidates
 * previously cached packets without an explicit purge.
 */
export function diagnosisCacheKey(
	signatureHash: string,
	declaredRules: DeclaredRule[],
	learnedRule?: LearnedRule | null,
	memoryFingerprint?: string,
): string {
	const memory = memoryFingerprint ? `|${memoryFingerprint}` : "";
	return `${SCHEMA_VERSION}|${declaredRulesFingerprint(declaredRules)}|${learnedRuleFingerprint(learnedRule)}|${signatureHash}${memory}`;
}

/**
 * Fingerprint of the project-memory inputs a cached diagnosis embedded
 * (item 36): the index file's mtime+size (a cheap stat, no parse) and the
 * failed-fix-attempt count that biases retrieval. A rebuilt index or a new
 * disproven fix therefore invalidates the packet whose `retrieval` block was
 * derived from the old state. Returns undefined when memory is disabled, which
 * keeps the key byte-identical to the pre-item-36 form.
 */
export function memoryFingerprint(
	indexPath: string | null,
	failedAttemptCount: number,
): string | undefined {
	if (!indexPath) return undefined;
	try {
		const st = statSync(indexPath);
		return `mem:${Math.round(st.mtimeMs)}:${st.size}:${failedAttemptCount}`;
	} catch {
		return `mem:none:${failedAttemptCount}`;
	}
}
