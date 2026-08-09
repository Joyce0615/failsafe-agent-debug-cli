/**
 * Benchmark manifests + dataset adapters (item 39).
 *
 * Debug-Gym can load several benchmarks; Failsafe's item-35 trajectory harness
 * defines how ONE episode is recorded but says nothing about *which* instances
 * to run, how they are pinned, or how results from different backends compare.
 *
 * This module normalizes SWE-bench-debug, SWE-smith, and R2E-Gym rows into one
 * canonical, versioned manifest of pinned instances. It is pure — no network,
 * no dataset download — because fetching a benchmark corpus is a consequential
 * external action: a user exports rows (however they obtain them) and the
 * adapters map them into the canonical shape. Benchmark payloads therefore
 * never enter the repo or a release tar.
 */
import { z } from "zod";

export const BENCH_MANIFEST_VERSION = "0.1";

export const BenchmarkKindSchema = z.enum(["swe-bench-debug", "swe-smith", "r2e-gym", "custom"]);
export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>;

export const BenchInstanceSchema = z.object({
	/** Unique within a manifest. */
	instance_id: z.string().min(1),
	repo: z.string().min(1),
	/** Pinned commit — a moving ref makes results incomparable. */
	base_commit: z.string().min(1),
	/** Pinned container image (digest or explicit tag), when the harness uses one. */
	image: z.string().optional(),
	/** The command whose failure the agent must debug. */
	command: z.string().min(1),
	/** Natural-language task/problem statement, when the dataset provides one. */
	task: z.string().optional(),
	/** Test(s) that must pass for the instance to count as resolved. */
	expected_pass: z.array(z.string()).default([]),
});
export type BenchInstance = z.infer<typeof BenchInstanceSchema>;

export const BenchBudgetSchema = z.object({
	max_steps: z.number().int().positive().optional(),
	max_tokens: z.number().int().positive().optional(),
	max_ms: z.number().int().positive().optional(),
});
export type BenchBudget = z.infer<typeof BenchBudgetSchema>;

export const BenchmarkManifestSchema = z.object({
	schema_version: z.literal(BENCH_MANIFEST_VERSION),
	benchmark: BenchmarkKindSchema,
	/** Dataset version/revision this manifest was exported from. */
	dataset_version: z.string().min(1),
	created_at: z.string(),
	/** Budget every backend is held to, so runs are comparable. */
	budget: BenchBudgetSchema.default({}),
	instances: z.array(BenchInstanceSchema),
});
export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

export type ManifestIssue = { instance_id: string; problem: string };

/**
 * Reject manifests that cannot produce comparable results: duplicate ids,
 * unpinned revisions, and floating image tags (`latest`/no tag).
 */
export function validateManifest(manifest: BenchmarkManifest): ManifestIssue[] {
	const issues: ManifestIssue[] = [];
	const seen = new Set<string>();

	for (const instance of manifest.instances) {
		if (seen.has(instance.instance_id)) {
			issues.push({ instance_id: instance.instance_id, problem: "duplicate instance_id" });
		}
		seen.add(instance.instance_id);

		if (!/^[0-9a-f]{7,40}$/i.test(instance.base_commit)) {
			issues.push({
				instance_id: instance.instance_id,
				problem: `base_commit is not a pinned revision: ${instance.base_commit}`,
			});
		}
		if (instance.image) {
			const floating = /(:latest$)|(^[^:@]+$)/.test(instance.image);
			if (floating) {
				issues.push({
					instance_id: instance.instance_id,
					problem: `image is not pinned (use a digest or explicit tag): ${instance.image}`,
				});
			}
		}
	}
	return issues;
}

function nowIso(): string {
	return new Date().toISOString();
}

type Row = Record<string, unknown>;

function str(row: Row, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function strArray(row: Row, ...keys: string[]): string[] {
	for (const key of keys) {
		const value = row[key];
		if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
		if (typeof value === "string" && value.trim().startsWith("[")) {
			try {
				const parsed = JSON.parse(value);
				if (Array.isArray(parsed)) {
					return parsed.filter((v): v is string => typeof v === "string");
				}
			} catch {}
		}
	}
	return [];
}

/**
 * SWE-bench(-debug) rows: `instance_id`, `repo`, `base_commit`,
 * `FAIL_TO_PASS` (JSON-encoded list), optional `problem_statement` and
 * `environment_setup_commit`/image.
 */
export function fromSweBench(rows: Row[], datasetVersion: string): BenchmarkManifest {
	const instances = rows.map((row) => {
		const failToPass = strArray(row, "FAIL_TO_PASS", "fail_to_pass");
		return BenchInstanceSchema.parse({
			instance_id: str(row, "instance_id", "id") ?? "unknown",
			repo: str(row, "repo") ?? "unknown",
			base_commit: str(row, "base_commit", "commit") ?? "",
			image: str(row, "image", "docker_image"),
			// SWE-bench does not ship a failing command; the FAIL_TO_PASS tests are it.
			command: str(row, "command") ?? `pytest ${failToPass.join(" ")}`.trim(),
			task: str(row, "problem_statement", "task"),
			expected_pass: failToPass,
		});
	});
	return BenchmarkManifestSchema.parse({
		schema_version: BENCH_MANIFEST_VERSION,
		benchmark: "swe-bench-debug",
		dataset_version: datasetVersion,
		created_at: nowIso(),
		instances,
	});
}

/**
 * SWE-smith rows: synthetic task instances keyed by `instance_id` with a
 * `repo`/`base_commit` and a `test_command`/`fail_to_pass` set.
 */
export function fromSweSmith(rows: Row[], datasetVersion: string): BenchmarkManifest {
	const instances = rows.map((row) =>
		BenchInstanceSchema.parse({
			instance_id: str(row, "instance_id", "id") ?? "unknown",
			repo: str(row, "repo") ?? "unknown",
			base_commit: str(row, "base_commit", "commit") ?? "",
			image: str(row, "image", "docker_image"),
			command: str(row, "test_command", "command") ?? "pytest",
			task: str(row, "problem_statement", "task", "issue"),
			expected_pass: strArray(row, "fail_to_pass", "FAIL_TO_PASS"),
		}),
	);
	return BenchmarkManifestSchema.parse({
		schema_version: BENCH_MANIFEST_VERSION,
		benchmark: "swe-smith",
		dataset_version: datasetVersion,
		created_at: nowIso(),
		instances,
	});
}

/**
 * R2E-Gym rows: `docker_image`, `commit`/`base_commit`, and an
 * `expected_output_json`/`test_command` describing the executable environment.
 */
export function fromR2eGym(rows: Row[], datasetVersion: string): BenchmarkManifest {
	const instances = rows.map((row) =>
		BenchInstanceSchema.parse({
			instance_id: str(row, "instance_id", "id", "docker_image") ?? "unknown",
			repo: str(row, "repo", "repo_name") ?? "unknown",
			base_commit: str(row, "base_commit", "commit") ?? "",
			image: str(row, "docker_image", "image"),
			command: str(row, "test_command", "command", "run_command") ?? "pytest",
			task: str(row, "problem_statement", "task", "prompt"),
			expected_pass: strArray(row, "expected_pass", "fail_to_pass"),
		}),
	);
	return BenchmarkManifestSchema.parse({
		schema_version: BENCH_MANIFEST_VERSION,
		benchmark: "r2e-gym",
		dataset_version: datasetVersion,
		created_at: nowIso(),
		instances,
	});
}

/** Adapter lookup so a caller can select a backend by name. */
export const ADAPTERS: Record<
	Exclude<BenchmarkKind, "custom">,
	(rows: Row[], datasetVersion: string) => BenchmarkManifest
> = {
	"swe-bench-debug": fromSweBench,
	"swe-smith": fromSweSmith,
	"r2e-gym": fromR2eGym,
};

/** Parse a manifest from JSON text, validating the schema. */
export function parseManifest(text: string): BenchmarkManifest {
	return BenchmarkManifestSchema.parse(JSON.parse(text));
}
