import type { ContextSlice } from "../types/diagnosis.js";
import type { ParsedError } from "../types/failure.js";
import { evaluateBuiltinRules } from "./builtin.js";
import { matchDeclaredRules } from "./declared.js";
import type { DeclaredRule, LearnedRule, RuleMatchResult } from "./types.js";

export type RuleStoreInterface = {
	getLearnedRuleByHash(hash: string): LearnedRule | null;
};

/**
 * Evaluate rules in a tiered fashion:
 *
 *   Tier 1: Declared rules (from `.failsafe/rules.yaml`), first match wins.
 *   Tier 2: Learned rules (by signature hash lookup), must be active with confidence >= 0.5.
 *   Tier 3: Built-in rules (existing diagnosis templates).
 *   Tier 4: No match — returns null.
 */
export function evaluateRules(
	errors: ParsedError[],
	contextSlices: ContextSlice[],
	signatureHash: string,
	store: RuleStoreInterface,
	declaredRules: DeclaredRule[],
): RuleMatchResult | null {
	// Tier 1: Declared rules
	const declaredMatch = matchDeclaredRules(errors, declaredRules);
	if (declaredMatch) {
		return declaredMatch;
	}

	// Tier 2: Learned rules
	const learnedRule = store.getLearnedRuleByHash(signatureHash);
	if (learnedRule && learnedRule.lifecycle === "active" && learnedRule.confidence >= 0.5) {
		return {
			rule_id: learnedRule.rule_id,
			rule_source: "learned",
			category: learnedRule.category,
			summary: learnedRule.explanation.substring(0, 200),
			explanation: learnedRule.explanation,
			confidence: learnedRule.confidence,
			fix: learnedRule.fix_summary,
			fix_commands: learnedRule.fix_commands,
		};
	}

	// Tier 3: Built-in rules
	const builtinMatch = evaluateBuiltinRules(errors, contextSlices);
	if (builtinMatch) {
		return builtinMatch;
	}

	// Tier 4: No match
	return null;
}
