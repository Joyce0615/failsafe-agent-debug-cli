import { createHash } from "node:crypto";
import type { DeclaredRule } from "../rules/types.js";
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
 * Cache key for a diagnosis: schema version + declared-rule fingerprint +
 * signature hash. Folding in the schema version and rule fingerprint means a
 * schema bump or a rules edit transparently invalidates previously cached
 * packets without an explicit purge.
 */
export function diagnosisCacheKey(signatureHash: string, declaredRules: DeclaredRule[]): string {
	return `${SCHEMA_VERSION}|${declaredRulesFingerprint(declaredRules)}|${signatureHash}`;
}
