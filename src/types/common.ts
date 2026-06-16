import { z } from "zod";

export const SCHEMA_VERSION = "0.1" as const;

/**
 * Schema versioning policy for persisted/exported Failsafe artifacts
 * (failure records, diagnoses, knowledge-base exports).
 *
 * Versions are `MAJOR.MINOR`:
 *  - Same MAJOR  => compatible. Minor bumps are additive (new optional
 *    fields only); older readers ignore unknown fields, newer readers
 *    tolerate missing-but-optional fields. A record with a newer MINOR than
 *    the current build is read on a best-effort basis ("migrate": accept).
 *  - Different MAJOR => breaking. The record is rejected with a clear reason;
 *    a future build may provide an explicit migration.
 *  - Missing/empty version => treated as legacy and accepted best-effort.
 */
export type SchemaCompatibility = {
	action: "ok" | "migrate" | "reject";
	reason: string;
	version: string;
	current: string;
};

function major(version: string): number {
	const n = Number.parseInt(version.split(".")[0] ?? "", 10);
	return Number.isNaN(n) ? Number.NaN : n;
}

function minor(version: string): number {
	const n = Number.parseInt(version.split(".")[1] ?? "0", 10);
	return Number.isNaN(n) ? 0 : n;
}

/**
 * Determine how to handle an artifact declaring `version` against the
 * current SCHEMA_VERSION. Never throws.
 */
export function checkSchemaCompatibility(
	version: string | undefined | null,
	current: string = SCHEMA_VERSION,
): SchemaCompatibility {
	if (!version) {
		return {
			action: "migrate",
			reason: "Artifact has no schema_version; treating as legacy and reading best-effort.",
			version: "(none)",
			current,
		};
	}
	const vMajor = major(version);
	const cMajor = major(current);
	if (Number.isNaN(vMajor)) {
		return {
			action: "reject",
			reason: `Malformed schema_version '${version}'.`,
			version,
			current,
		};
	}
	if (vMajor !== cMajor) {
		return {
			action: "reject",
			reason: `Incompatible schema major version: artifact is '${version}', this build expects '${current}' (major ${cMajor}). A breaking migration is required.`,
			version,
			current,
		};
	}
	if (version === current) {
		return { action: "ok", reason: "Schema version matches.", version, current };
	}
	// Same major, different minor: additive-only changes are compatible.
	const newer = minor(version) > minor(current);
	return {
		action: "migrate",
		reason: newer
			? `Artifact schema '${version}' is newer than this build '${current}' (same major); reading additive fields best-effort.`
			: `Artifact schema '${version}' is older than this build '${current}' (same major); compatible.`,
		version,
		current,
	};
}

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
