import { createHash } from "node:crypto";
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
): string {
	return `${SCHEMA_VERSION}|${declaredRulesFingerprint(declaredRules)}|${learnedRuleFingerprint(learnedRule)}|${signatureHash}`;
}
