import { TEMPLATES } from "../diagnosis/templates.js";
import type { ContextSlice } from "../types/diagnosis.js";
import type { ParsedError } from "../types/failure.js";
import type { RuleMatchResult } from "./types.js";

/**
 * Evaluate built-in diagnosis templates against the given errors.
 * Templates are evaluated in order; the first match wins.
 * The template's `diagnose()` result is wrapped as a RuleMatchResult
 * with `rule_source: "builtin"`.
 */
export function evaluateBuiltinRules(
	errors: ParsedError[],
	contextSlices: ContextSlice[],
): RuleMatchResult | null {
	for (const template of TEMPLATES) {
		if (!template.match(errors)) {
			continue;
		}

		const result = template.diagnose(errors, contextSlices);

		return {
			rule_id: template.id,
			rule_source: "builtin",
			category: template.category,
			summary: result.summary,
			explanation: result.explanation,
			confidence: result.confidence,
			evidence: result.evidence,
			uncertainty: result.uncertainty,
		};
	}

	return null;
}
