/**
 * `failsafe kb dataset-stats` core (computeDatasetStats) tests.
 *
 * Seeds a real temp store with failure/diagnosis/fix-outcome triples (the same
 * rows `kb export-dataset` emits) and asserts the corpus-health metrics: class
 * balance across KNOWN_DIAGNOSIS_CATEGORIES, the dedupe rate, label confidence,
 * resolved-but-unverified counts, and the readiness gate with its reasons.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDatasetStats } from "../../src/cli/kb.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import { DEFAULT_CONFIG, type FailsafeConfig } from "../../src/types/config.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { FailureRecord } from "../../src/types/failure.js";

let workDir: string;
let store: FailsafeStore;
let config: FailsafeConfig;

function seedSample(opts: {
	id: string;
	hash: string;
	category?: string;
	confidence?: number;
	success?: boolean;
}): void {
	const failure: FailureRecord = {
		schema_version: SCHEMA_VERSION,
		failure_id: opts.id,
		created_at: new Date().toISOString(),
		workspace: workDir,
		command: "pytest tests/",
		cwd: workDir,
		env_fingerprint: { os: "linux", arch: "x64", cwd: workDir },
		status: "failed",
		exit_code: 1,
		duration_ms: 1,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed: [{ parser: "pytest", failure_type: "test_failure", errors: [{ message: "boom" }] }],
		primary_location: undefined,
		related_locations: [],
		raw_artifacts: [],
	};
	store.saveRun(failure, "", "", "");

	if (opts.category) {
		const diag: FailureDiagnosis = {
			schema_version: SCHEMA_VERSION,
			diagnosis_id: `diag_${opts.id}`,
			failure_id: opts.id,
			failure_type: "test_failure",
			severity: "error",
			summary: "seeded",
			root_cause: {
				category: opts.category,
				explanation: "seeded",
				confidence: opts.confidence ?? 0.9,
			},
			evidence: [],
			uncertainty: [],
			minimal_context: [],
			suggested_next_actions: [],
		};
		store.saveDiagnosis(diag);
	}

	store.insertFixOutcome({
		failure_id: opts.id,
		signature_hash: opts.hash,
		resolved_at: new Date().toISOString(),
		success: opts.success ?? true,
	});
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-dstats-"));
	config = { ...DEFAULT_CONFIG, storage_dir: join(workDir, ".failsafe") };
	store = new FailsafeStore(config, workDir);
});

afterEach(() => {
	store.close();
	rmSync(workDir, { recursive: true, force: true });
});

describe("computeDatasetStats", () => {
	test("an empty corpus is not ready and reports null ratios", () => {
		const stats = computeDatasetStats(store);
		expect(stats.total_samples).toBe(0);
		expect(stats.labeled).toBe(0);
		expect(stats.imbalance_ratio).toBeNull();
		expect(stats.avg_confidence).toBeNull();
		expect(stats.readiness.ready).toBe(false);
		expect(stats.readiness.reasons.length).toBeGreaterThan(0);
	});

	test("a balanced, well-labeled corpus passes the readiness gate", () => {
		seedSample({ id: "a", hash: "h1", category: "type_error" });
		seedSample({ id: "b", hash: "h2", category: "key_error" });
		seedSample({ id: "c", hash: "h3", category: "import_error" });

		const stats = computeDatasetStats(store, {
			thresholds: { min_samples: 3, min_categories: 2 },
		});

		expect(stats.total_samples).toBe(3);
		expect(stats.labeled).toBe(3);
		expect(stats.with_diagnosis).toBe(3);
		expect(stats.distinct_categories).toBe(3);
		expect(stats.category_counts.type_error).toBe(1);
		expect(stats.category_counts.key_error).toBe(1);
		expect(stats.imbalance_ratio).toBe(1);
		expect(stats.dedupe_rate).toBe(0);
		expect(stats.readiness.ready).toBe(true);
		expect(stats.readiness.reasons).toEqual([]);
	});

	test("duplicate signatures raise the dedupe rate and block readiness", () => {
		// Two of three samples share a signature hash.
		seedSample({ id: "a", hash: "dup", category: "type_error" });
		seedSample({ id: "b", hash: "dup", category: "type_error" });
		seedSample({ id: "c", hash: "h3", category: "key_error" });

		const stats = computeDatasetStats(store, {
			thresholds: { min_samples: 1, min_categories: 1, max_dedupe_rate: 0.1 },
		});

		expect(stats.unique_signatures).toBe(2);
		expect(stats.duplicate_signatures).toBe(1);
		expect(stats.dedupe_rate).toBeCloseTo(1 / 3, 5);
		expect(stats.readiness.ready).toBe(false);
		expect(stats.readiness.reasons.some((r) => r.includes("Duplicate-signature"))).toBe(true);
	});

	test("unverified fixes are counted and excluded by success-only", () => {
		seedSample({ id: "a", hash: "h1", category: "type_error", success: true });
		seedSample({ id: "b", hash: "h2", category: "key_error", success: false });

		const all = computeDatasetStats(store);
		expect(all.total_samples).toBe(2);
		expect(all.success).toBe(1);
		expect(all.resolved_unverified).toBe(1);

		const ok = computeDatasetStats(store, { successOnly: true });
		expect(ok.total_samples).toBe(1);
		expect(ok.resolved_unverified).toBe(0);
	});

	test("a label outside the known set lands in unknown_categories", () => {
		seedSample({ id: "a", hash: "h1", category: "type_error", confidence: 0.4 });
		seedSample({ id: "b", hash: "h2", category: "made_up_category", confidence: 0.95 });

		const stats = computeDatasetStats(store);

		expect(stats.category_counts.type_error).toBe(1);
		expect(stats.unknown_categories.made_up_category).toBe(1);
		expect(stats.distinct_categories).toBe(2);
		// Low-confidence (< 0.6 default) labels are flagged.
		expect(stats.low_confidence).toBe(1);
		expect(stats.avg_confidence).toBeCloseTo((0.4 + 0.95) / 2, 5);
	});
});
