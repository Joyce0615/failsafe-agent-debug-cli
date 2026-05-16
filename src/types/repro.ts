import { z } from "zod";
import { NextActionSchema, SCHEMA_VERSION } from "./common.js";

export const FailureSignatureSchema = z.object({
	exception_type: z.string().optional(),
	top_frame_file: z.string().optional(),
	top_frame_line: z.number().int().optional(),
	top_frame_function: z.string().optional(),
	test_name: z.string().optional(),
	assertion_key: z.string().optional(),
	compiler_code: z.string().optional(),
	lint_rule: z.string().optional(),
	file: z.string().optional(),
	line: z.number().int().optional(),
});
export type FailureSignature = z.infer<typeof FailureSignatureSchema>;

export const ReproReductionSchema = z.object({
	original_tests: z.number().int().optional(),
	repro_tests: z.number().int().optional(),
	original_runtime_ms: z.number().optional(),
	repro_runtime_ms: z.number().optional(),
});
export type ReproReduction = z.infer<typeof ReproReductionSchema>;

export const ReproRecordSchema = z.object({
	schema_version: z.literal(SCHEMA_VERSION),
	repro_id: z.string(),
	failure_id: z.string(),
	created_at: z.string(),
	status: z.enum(["created", "verified", "failed", "stale"]),
	kind: z.enum(["test_selector", "file_selector", "command_reduction"]),
	command: z.string(),
	confidence: z.number().min(0).max(1),
	reduction: ReproReductionSchema,
	signature: FailureSignatureSchema.optional(),
	verified_at: z.string().optional(),
	next: z.array(NextActionSchema),
});
export type ReproRecord = z.infer<typeof ReproRecordSchema>;
