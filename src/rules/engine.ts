import type { ContextSlice } from "../types/diagnosis.js";
import type { ParsedError } from "../types/failure.js";
import { evaluateBuiltinRules } from "./builtin.js";
import { calibrateConfidence } from "./confidence.js";
import { matchDeclaredRules } from "./declared.js";
import type { DeclaredRule, LearnedRule, RuleMatchResult, ShadowedMatch } from "./types.js";

export type RuleStoreInterface = {
	getLearnedRuleByHash(hash: string): LearnedRule | null;
};

/**
 * Evaluate rules across all tiers and pick the winner by strict precedence:
 *
 *   Tier 1: Declared rules (from `.failsafe/rules.yaml`).
 *   Tier 2: Learned rules (by signature hash, active, confidence >= 0.5).
 *   Tier 3: Built-in rules (diagnosis templates).
 *   Tier 4: No match — returns null.
 *
 * Unlike a short-circuit first-match, this evaluates every tier so it can
 * report which lower-priority rules ALSO matched but were shadowed by the
 * winner. The winner carries a `shadowed_matches` list for transparency, which
 * the diagnosis surfaces as uncertainty. This makes precedence auditable:
 * a declared rule overriding a learned/builtin match is visible, not silent.
 */
export function evaluateRules(
	errors: ParsedError[],
	contextSlices: ContextSlice[],
	signatureHash: string,
	store: RuleStoreInterface,
	declaredRules: DeclaredRule[],
): RuleMatchResult | null {
	// Evaluate every tier independently. Each tier's raw confidence is
	// calibrated so values are comparable across tiers before precedence and
	// gating decisions are made (see confidence.ts for the calibration model).
	const declaredMatch = matchDeclaredRules(errors, declaredRules);
	if (declaredMatch) {
		declaredMatch.confidence = calibrateConfidence("declared", declaredMatch.confidence);
	}

	const learnedRule = store.getLearnedRuleByHash(signatureHash);
	// Calibrate BEFORE gating: a learned rule corroborated by few occurrences is
	// down-weighted, so the >= 0.5 floor applies to the calibrated value.
	const learnedConfidence = learnedRule
		? calibrateConfidence("learned", learnedRule.confidence, {
				occurrenceCount: learnedRule.occurrence_count,
			})
		: 0;
	const learnedMatch: RuleMatchResult | null =
		learnedRule && learnedRule.lifecycle === "active" && learnedConfidence >= 0.5
			? {
					rule_id: learnedRule.rule_id,
					rule_source: "learned",
					category: learnedRule.category,
					summary: learnedRule.explanation.substring(0, 200),
					explanation: learnedRule.explanation,
					confidence: learnedConfidence,
					fix: learnedRule.fix_summary,
					fix_commands: learnedRule.fix_commands,
				}
			: null;

	const builtinMatch = evaluateBuiltinRules(errors, contextSlices);
	if (builtinMatch) {
		builtinMatch.confidence = calibrateConfidence("builtin", builtinMatch.confidence);
	}

	// Ordered by precedence (highest first).
	const tiers: Array<RuleMatchResult | null> = [declaredMatch, learnedMatch, builtinMatch];
	const winnerIndex = tiers.findIndex((t) => t !== null);
	if (winnerIndex === -1) return null;

	const winner = tiers[winnerIndex]!;
	// Record any lower-priority tiers that also matched.
	const shadowed: ShadowedMatch[] = [];
	for (let i = winnerIndex + 1; i < tiers.length; i++) {
		const t = tiers[i];
		if (t) {
			shadowed.push({ rule_id: t.rule_id, rule_source: t.rule_source, category: t.category });
		}
	}
	if (shadowed.length > 0) {
		return { ...winner, shadowed_matches: shadowed };
	}
	return winner;
}
