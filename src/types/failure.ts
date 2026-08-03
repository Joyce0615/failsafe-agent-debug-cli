import { z } from "zod";
import {
	ArtifactRefSchema,
	EnvFingerprintSchema,
	SCHEMA_VERSION,
	SourceLocationSchema,
	TokenBudgetSchema,
} from "./common.js";

export const StackFrameSchema = z.object({
	file: z.string(),
	line: z.number().int(),
	column: z.number().int().optional(),
	function: z.string().optional(),
	is_application: z.boolean(),
	/**
	 * When set, this is a fold marker standing in for `collapsed` contiguous
	 * non-application (dependency/internal) frames, not a real frame. Emitted by
	 * `collapseFrames` so long node_modules/traceback chains don't inflate the
	 * evidence list. Always `is_application:false`.
	 */
	collapsed: z.number().int().optional(),
});
export type StackFrame = z.infer<typeof StackFrameSchema>;

export const AssertionDiffSchema = z.object({
	expected: z.string().optional(),
	actual: z.string().optional(),
	operator: z.string().optional(),
});
export type AssertionDiff = z.infer<typeof AssertionDiffSchema>;

export const ParsedErrorSchema = z.object({
	message: z.string(),
	error_type: z.string().optional(),
	location: SourceLocationSchema.optional(),
	stack_frames: z.array(StackFrameSchema).optional(),
	assertion_diff: AssertionDiffSchema.optional(),
	test_name: z.string().optional(),
	test_file: z.string().optional(),
	/**
	 * Set only by the Drain-style last-resort miner (`drain-template`, item 27)
	 * when no registered parser matched: the mined log template, how many
	 * scanned lines matched it, and the size of the scanned window.
	 */
	log_template: z
		.object({
			template: z.string(),
			occurrences: z.number().int(),
			scanned_lines: z.number().int(),
		})
		.optional(),
});
export type ParsedError = z.infer<typeof ParsedErrorSchema>;

export const TestSummarySchema = z.object({
	total: z.number().int(),
	passed: z.number().int(),
	failed: z.number().int(),
	skipped: z.number().int(),
	errored: z.number().int().optional(),
});
export type TestSummary = z.infer<typeof TestSummarySchema>;

export const ParsedFailureSchema = z.object({
	parser: z.string(),
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
	errors: z.array(ParsedErrorSchema),
	test_summary: TestSummarySchema.optional(),
});
export type ParsedFailure = z.infer<typeof ParsedFailureSchema>;

export const FailureStatusSchema = z.enum(["failed", "passed", "timeout", "interrupted"]);
export type FailureStatus = z.infer<typeof FailureStatusSchema>;

export const FailureRecordSchema = z.object({
	schema_version: z.literal(SCHEMA_VERSION),
	failure_id: z.string(),
	created_at: z.string(),
	workspace: z.string(),
	command: z.string(),
	cwd: z.string(),
	env_fingerprint: EnvFingerprintSchema,
	status: FailureStatusSchema,
	exit_code: z.number().nullable(),
	duration_ms: z.number(),
	stdout_path: z.string(),
	stderr_path: z.string(),
	combined_log_path: z.string(),
	parsed: z.array(ParsedFailureSchema),
	primary_location: SourceLocationSchema.optional(),
	related_locations: z.array(SourceLocationSchema),
	raw_artifacts: z.array(ArtifactRefSchema),
	token_budget: TokenBudgetSchema.optional(),
});
export type FailureRecord = z.infer<typeof FailureRecordSchema>;
