import { z } from "zod";

export const SCHEMA_VERSION = "0.1" as const;

export const SourceLocationSchema = z.object({
	file: z.string(),
	line: z.number().int().positive(),
	column: z.number().int().positive().optional(),
	symbol: z.string().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const TokenBudgetSchema = z.object({
	raw_output_bytes: z.number(),
	returned_bytes: z.number(),
	compression_ratio: z.number(),
	estimated_raw_tokens: z.number().optional(),
	estimated_returned_tokens: z.number().optional(),
	estimated_tokens_saved: z.number().optional(),
});
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;

export const NextActionSchema = z.object({
	command: z.string(),
	reason: z.string(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

export const ArtifactRefSchema = z.object({
	kind: z.enum(["stdout", "stderr", "combined"]),
	path: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const EnvFingerprintSchema = z.object({
	node_version: z.string().optional(),
	python_version: z.string().optional(),
	bun_version: z.string().optional(),
	os: z.string(),
	arch: z.string(),
	cwd: z.string(),
	git_branch: z.string().optional(),
	git_commit_short: z.string().optional(),
});
export type EnvFingerprint = z.infer<typeof EnvFingerprintSchema>;
