import { z } from "zod";
import { EnforcementLevelSchema, RuleSourceSchema } from "../rules/types.js";
import { NextActionSchema, SCHEMA_VERSION, TokenBudgetSchema } from "./common.js";

export const KNOWN_DIAGNOSIS_CATEGORIES = [
	"null_reference",
	"type_error",
	"import_error",
	"assertion_mismatch",
	"syntax_error",
	"key_error",
	"attribute_error",
	"index_error",
	"lint_violation",
	"timeout",
	"permission_error",
	"connection_error",
	"unknown",
] as const;
export const DiagnosisCategorySchema = z.string();
export type DiagnosisCategory = z.infer<typeof DiagnosisCategorySchema>;

export const EvidenceItemSchema = z.object({
	kind: z.enum([
		"stack_frame",
		"test_input",
		"source_slice",
		"assertion_diff",
		"git_diff",
		"history_match",
		"error_message",
		"log_template",
	]),
	location: z.string().optional(),
	value: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const ContextSliceSchema = z.object({
	file: z.string(),
	start_line: z.number().int(),
	end_line: z.number().int(),
	text: z.string(),
	/**
	 * Name of the enclosing declaration when the slice is a syntactic unit
	 * rather than a line window (item 29).
	 */
	symbol: z.string().optional(),
	unit_kind: z.enum(["function", "method", "class", "module", "block"]).optional(),
	/**
	 * Set when the enclosing unit was too large to return whole, so the slice
	 * is a window clamped inside that unit's boundaries.
	 */
	truncated_unit: z.boolean().optional(),
});
export type ContextSlice = z.infer<typeof ContextSliceSchema>;

export const SeveritySchema = z.enum(["blocker", "error", "warning", "flaky"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FailureDiagnosisSchema = z.object({
	schema_version: z.literal(SCHEMA_VERSION),
	diagnosis_id: z.string(),
	failure_id: z.string(),
	failure_type: z.enum([
		"test_failure",
		"build_error",
		"lint_error",
		"type_error",
		"runtime_exception",
		"timeout",
		"tool_error",
		"unknown",
	]),
	severity: SeveritySchema,
	summary: z.string(),
	root_cause: z
		.object({
			category: DiagnosisCategorySchema,
			explanation: z.string(),
			confidence: z.number().min(0).max(1),
		})
		.optional(),
	evidence: z.array(EvidenceItemSchema),
	uncertainty: z.array(z.string()),
	minimal_context: z.array(ContextSliceSchema),
	suggested_next_actions: z.array(NextActionSchema),
	token_budget: TokenBudgetSchema.optional(),
	rule_source: RuleSourceSchema.optional(),
	rule_id: z.string().optional(),
	enforcement: EnforcementLevelSchema.optional(),
	/**
	 * Emitted when the same failure signature keeps recurring unresolved past a
	 * threshold: a signal to stop blind patching and confirm the root cause at
	 * runtime via the debugger instead (DESIGN §11.3).
	 */
	loop_warning: z
		.object({
			detected: z.literal(true),
			occurrences: z.number().int(),
			reason: z.string(),
			recommendation: z.string(),
		})
		.optional(),
});
export type FailureDiagnosis = z.infer<typeof FailureDiagnosisSchema>;
