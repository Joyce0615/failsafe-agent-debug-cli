import { z } from "zod";

// ---------- Rule Source & Lifecycle ----------

export const RuleSourceSchema = z.enum(["declared", "learned", "builtin"]);
export type RuleSource = z.infer<typeof RuleSourceSchema>;

export const RuleLifecycleSchema = z.enum(["active", "promoted", "stale", "disabled"]);
export type RuleLifecycle = z.infer<typeof RuleLifecycleSchema>;

export const EnforcementLevelSchema = z.enum(["auto-fix", "suggest", "block"]);
export type EnforcementLevel = z.infer<typeof EnforcementLevelSchema>;

// ---------- Matching Criteria ----------

export const MatchCriteriaSchema = z.object({
	error_type: z.string().optional(),
	error_contains: z.union([z.string(), z.array(z.string())]).optional(),
	message_regex: z.string().optional(),
	file_matches: z.string().optional(),
	status_code: z.number().optional(),
	env_matches: z.record(z.string()).optional(),
	framework: z.string().optional(),
	tags: z.array(z.string()).optional(),
});
export type MatchCriteria = z.infer<typeof MatchCriteriaSchema>;

// ---------- Declared Rule (from YAML) ----------

export const DeclaredRuleActionSchema = z.object({
	category: z.string(),
	explanation: z.string(),
	fix: z.string().optional(),
	fix_commands: z.array(z.string()).optional(),
	fix_patch: z.string().optional(),
	fix_env_vars: z.record(z.string()).optional(),
	enforcement: EnforcementLevelSchema.optional().default("suggest"),
});
export type DeclaredRuleAction = z.infer<typeof DeclaredRuleActionSchema>;

export const DeclaredRuleSchema = z.object({
	id: z.string(),
	override: z.boolean().optional(),
	pattern: MatchCriteriaSchema,
	diagnosis: DeclaredRuleActionSchema,
	confidence: z.number().min(0).max(1).optional().default(0.9),
	tags: z.array(z.string()).optional(),
});
export type DeclaredRule = z.infer<typeof DeclaredRuleSchema>;

export const RulesFileSchema = z.object({
	version: z.string().optional().default("1"),
	settings: z
		.object({
			auto_fix_threshold: z.number().optional(),
			escalation_threshold: z.number().optional(),
			max_auto_retries: z.number().optional(),
		})
		.optional(),
	rules: z.array(DeclaredRuleSchema),
});
export type RulesFile = z.infer<typeof RulesFileSchema>;

// ---------- Learned Rule (from DB) ----------

export const LearnedRuleSchema = z.object({
	rule_id: z.string(),
	signature_hash: z.string(),
	/**
	 * Drain-style fuzzy grouping key: the signature with numeric/quoted/hex
	 * literals in the file/function/test-name/message replaced by placeholders.
	 * Used as a fallback so failures differing only by an embedded id/number
	 * coalesce into one learned rule (item 26). Optional for back-compat.
	 */
	normalized_hash: z.string().optional(),
	error_type: z.string().optional(),
	error_pattern: z.string().optional(),
	file_pattern: z.string().optional(),
	category: z.string(),
	explanation: z.string(),
	fix_summary: z.string().optional(),
	fix_commands: z.array(z.string()).optional(),
	occurrence_count: z.number().int(),
	success_count: z.number().int(),
	distinct_files: z.number().int(),
	confidence: z.number().min(0).max(1),
	lifecycle: RuleLifecycleSchema,
	first_seen_at: z.string(),
	last_seen_at: z.string(),
	last_success_at: z.string().optional(),
	promoted_at: z.string().optional(),
});
export type LearnedRule = z.infer<typeof LearnedRuleSchema>;

// ---------- Rule Match Result ----------

/** A lower-tier rule that also matched but was shadowed by the winner. */
export const ShadowedMatchSchema = z.object({
	rule_id: z.string(),
	rule_source: RuleSourceSchema,
	category: z.string(),
});
export type ShadowedMatch = z.infer<typeof ShadowedMatchSchema>;

export const RuleMatchResultSchema = z.object({
	rule_id: z.string(),
	rule_source: RuleSourceSchema,
	category: z.string(),
	summary: z.string(),
	explanation: z.string(),
	confidence: z.number().min(0).max(1),
	enforcement: EnforcementLevelSchema.optional(),
	fix: z.string().optional(),
	fix_commands: z.array(z.string()).optional(),
	evidence: z.array(z.unknown()).optional(),
	uncertainty: z.array(z.string()).optional(),
	/** Lower-priority rules that also matched but lost to the winning tier. */
	shadowed_matches: z.array(ShadowedMatchSchema).optional(),
});
export type RuleMatchResult = z.infer<typeof RuleMatchResultSchema>;

// ---------- Fix Outcome ----------

export const FixOutcomeSchema = z.object({
	failure_id: z.string(),
	signature_hash: z.string(),
	resolved_at: z.string(),
	success: z.boolean(),
	fix_summary: z.string().optional(),
	fix_commands: z.array(z.string()).optional(),
	files_changed: z.array(z.string()).optional(),
});
export type FixOutcome = z.infer<typeof FixOutcomeSchema>;

// ---------- Fix Attempt (Reflexion-style episodic memory) ----------

/**
 * A recorded attempt to fix a signature and what it achieved (item 32).
 *
 * `FixOutcome` records only *successful* resolutions, so a re-diagnosis could
 * not tell an agent which fixes are already disproven. A `FixAttempt` captures
 * the failed episodes too, which is exactly Reflexion's contribution: remember
 * the dead ends so they are not retried.
 */
export const FixAttemptSchema = z.object({
	signature_hash: z.string(),
	failure_id: z.string(),
	attempted_at: z.string(),
	/** Compact description of what was changed/tried. */
	summary: z.string(),
	outcome: z.enum(["unresolved", "resolved"]),
	/** Why it did not resolve (e.g. which check still failed). */
	detail: z.string().optional(),
	files_changed: z.array(z.string()).optional(),
});
export type FixAttempt = z.infer<typeof FixAttemptSchema>;

// ---------- Flaky Record ----------

export const FlakyRecordSchema = z.object({
	signature_hash: z.string(),
	failure_count_after_fix: z.number().int(),
	first_recurrence_at: z.string(),
	last_recurrence_at: z.string(),
	marked_flaky_at: z.string().optional(),
	/**
	 * Rerun evidence (item 33). History alone only *infers* flakiness; these
	 * fields record an actual N-times rerun of the minimal repro and its
	 * verdict mix. `rerun_confirmed` is authoritative over the heuristic:
	 * `true` = mixed verdicts observed (genuinely flaky),
	 * `false` = every rerun agreed (deterministic — do NOT downgrade it),
	 * absent = never rerun.
	 */
	rerun_checked_at: z.string().optional(),
	rerun_total: z.number().int().optional(),
	rerun_passed: z.number().int().optional(),
	rerun_failed: z.number().int().optional(),
	rerun_confirmed: z.boolean().optional(),
});
export type FlakyRecord = z.infer<typeof FlakyRecordSchema>;

// ---------- Promotion Suggestion ----------

export type PromotionSuggestion = {
	rule: LearnedRule;
	yaml_snippet: string;
	success_rate: number;
};
