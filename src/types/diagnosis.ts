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
		"project_memory",
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

/**
 * The cheapest active probe that would confirm or refute a low-confidence root
 * cause before any code is patched (item 31; DESIGN §5.4 Observability Gap).
 */
export const ConfirmingInterventionSchema = z.object({
	kind: z.enum(["debugger_breakpoint", "assertion_probe"]),
	/** Why confirmation is warranted, naming the confidence and the location. */
	reason: z.string(),
	/** The confidence that triggered the intervention. */
	confidence: z.number().min(0).max(1),
	/** Ready-to-run probe command. */
	command: z.string(),
	/** `file:line` the probe observes. */
	location: z.string(),
	/** Concrete expressions to inspect at that location. */
	watch: z.array(z.string()),
	/** What the agent should conclude from what it sees. */
	expected_observation: z.string(),
	/** Human-readable cost of running the probe. */
	cost: z.string(),
});
export type ConfirmingIntervention = z.infer<typeof ConfirmingInterventionSchema>;

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
			/** Recorded fixes that were tried and did not resolve it (item 32). */
			failed_fix_attempts: z.number().int().optional(),
			reason: z.string(),
			recommendation: z.string(),
		})
		.optional(),
	/**
	 * Attached when the root cause is not confident enough to act on: one
	 * specific probe that validates the hypothesis at runtime (item 31).
	 */
	confirming_intervention: ConfirmingInterventionSchema.optional(),
	/**
	 * Provenance for project-memory retrieval (item 36): which index entries
	 * were pulled, with their scores and the byte budget they were held to.
	 * Absent unless `config.memory.enabled` and an index exists.
	 */
	retrieval: z
		.object({
			source: z.literal("project_index"),
			index_version: z.number().int(),
			budget_bytes: z.number().int(),
			used_bytes: z.number().int(),
			considered: z.number().int(),
			entries: z.array(z.object({ id: z.string(), score: z.number(), reason: z.string() })),
		})
		.optional(),
});
export type FailureDiagnosis = z.infer<typeof FailureDiagnosisSchema>;
