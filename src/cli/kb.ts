import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type CalibrationReport,
	calibrationReport,
	loadPredictions,
} from "../diagnosis/calibration.js";
import {
	type ClassifierEvaluation,
	evaluateClassifier,
	loadDatasetSamples,
} from "../diagnosis/classifier.js";
import type { FlakyRecord, LearnedRule } from "../rules/types.js";
import type { FailsafeStore } from "../storage/store.js";
import { SCHEMA_VERSION, checkSchemaCompatibility } from "../types/common.js";
import { KNOWN_DIAGNOSIS_CATEGORIES } from "../types/diagnosis.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

type KbExport = {
	schema_version?: string;
	exported_at: string;
	learned_rules: LearnedRule[];
	flaky_signatures: FlakyRecord[];
};

/** Tunable thresholds for the dataset readiness gate. */
export type DatasetThresholds = {
	/** Minimum number of labeled samples before the corpus is usable. */
	min_samples: number;
	/** Minimum distinct categories represented (class diversity). */
	min_categories: number;
	/** Maximum acceptable class-imbalance ratio (largest/smallest class). */
	max_imbalance_ratio: number;
	/** Maximum acceptable duplicate-signature rate (0..1). */
	max_dedupe_rate: number;
	/** Minimum fraction of samples that carry a category label (0..1). */
	min_labeled_fraction: number;
	/** Confidence below this counts as a low-confidence (noisy) label. */
	low_confidence: number;
};

export const DEFAULT_DATASET_THRESHOLDS: DatasetThresholds = {
	min_samples: 20,
	min_categories: 2,
	max_imbalance_ratio: 10,
	max_dedupe_rate: 0.5,
	min_labeled_fraction: 0.8,
	low_confidence: 0.6,
};

export type DatasetStats = {
	total_samples: number;
	with_diagnosis: number;
	labeled: number;
	unlabeled: number;
	success: number;
	/** Recorded fixes whose verification did not pass (noisy labels). */
	resolved_unverified: number;
	/** Per-known-category counts (every known category present, 0-filled). */
	category_counts: Record<string, number>;
	/** Labels seen that are NOT in KNOWN_DIAGNOSIS_CATEGORIES. */
	unknown_categories: Record<string, number>;
	distinct_categories: number;
	largest_class_share: number;
	imbalance_ratio: number | null;
	unique_signatures: number;
	duplicate_signatures: number;
	dedupe_rate: number;
	avg_confidence: number | null;
	low_confidence: number;
	readiness: { ready: boolean; reasons: string[] };
	thresholds: DatasetThresholds;
};

/**
 * Compute training-data quality metrics over the resolved failure/fix corpus
 * (the same rows `kb export-dataset` emits). Pure of process.exit/console so it
 * is unit-testable; the CLI wrapper maps it to output + an optional gate exit.
 */
export function computeDatasetStats(
	store: FailsafeStore,
	opts: { successOnly?: boolean; thresholds?: Partial<DatasetThresholds> } = {},
): DatasetStats {
	const thresholds = { ...DEFAULT_DATASET_THRESHOLDS, ...opts.thresholds };
	const outcomes = store.listFixOutcomes({ successOnly: opts.successOnly });

	const categoryCounts: Record<string, number> = {};
	for (const c of KNOWN_DIAGNOSIS_CATEGORIES) categoryCounts[c] = 0;
	const unknownCategories: Record<string, number> = {};

	let total = 0;
	let withDiagnosis = 0;
	let labeled = 0;
	let successCount = 0;
	let unverified = 0;
	let confidenceSum = 0;
	let confidenceCount = 0;
	let lowConfidence = 0;
	const signatureSeen = new Map<string, number>();

	for (const outcome of outcomes) {
		const failure = store.getFailure(outcome.failure_id);
		if (!failure) continue; // mirrors export-dataset: a row needs a backing failure
		total++;

		if (outcome.success) successCount++;
		else unverified++;

		signatureSeen.set(outcome.signature_hash, (signatureSeen.get(outcome.signature_hash) ?? 0) + 1);

		const diagnosis = store.getDiagnosis(outcome.failure_id);
		if (diagnosis) withDiagnosis++;
		const category = diagnosis?.root_cause?.category;
		if (category) {
			labeled++;
			if (category in categoryCounts) {
				categoryCounts[category]++;
			} else {
				unknownCategories[category] = (unknownCategories[category] ?? 0) + 1;
			}
		}
		const confidence = diagnosis?.root_cause?.confidence;
		if (typeof confidence === "number") {
			confidenceSum += confidence;
			confidenceCount++;
			if (confidence < thresholds.low_confidence) lowConfidence++;
		}
	}

	// Represented classes span both known and unknown labels.
	const representedCounts = [
		...Object.values(categoryCounts).filter((n) => n > 0),
		...Object.values(unknownCategories),
	];
	const distinctCategories = representedCounts.length;
	const maxClass = representedCounts.length > 0 ? Math.max(...representedCounts) : 0;
	const minClass = representedCounts.length > 0 ? Math.min(...representedCounts) : 0;
	const imbalanceRatio = minClass > 0 ? maxClass / minClass : null;
	const largestClassShare = labeled > 0 ? maxClass / labeled : 0;

	const uniqueSignatures = signatureSeen.size;
	const duplicateSignatures = total - uniqueSignatures;
	const dedupeRate = total > 0 ? duplicateSignatures / total : 0;
	const avgConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : null;
	const labeledFraction = total > 0 ? labeled / total : 0;

	// Readiness gate: collect every failing condition so the classifier work
	// (item 3) gets actionable reasons, not just a boolean.
	const reasons: string[] = [];
	if (labeled < thresholds.min_samples) {
		reasons.push(`Only ${labeled} labeled sample(s); need >= ${thresholds.min_samples}.`);
	}
	if (distinctCategories < thresholds.min_categories) {
		reasons.push(
			`Only ${distinctCategories} distinct categor(ies); need >= ${thresholds.min_categories}.`,
		);
	}
	if (labeledFraction < thresholds.min_labeled_fraction) {
		reasons.push(
			`Labeled fraction ${labeledFraction.toFixed(2)} below ${thresholds.min_labeled_fraction}.`,
		);
	}
	if (imbalanceRatio !== null && imbalanceRatio > thresholds.max_imbalance_ratio) {
		reasons.push(
			`Class imbalance ratio ${imbalanceRatio.toFixed(1)} exceeds ${thresholds.max_imbalance_ratio}.`,
		);
	}
	if (dedupeRate > thresholds.max_dedupe_rate) {
		reasons.push(
			`Duplicate-signature rate ${dedupeRate.toFixed(2)} exceeds ${thresholds.max_dedupe_rate}.`,
		);
	}

	return {
		total_samples: total,
		with_diagnosis: withDiagnosis,
		labeled,
		unlabeled: total - labeled,
		success: successCount,
		resolved_unverified: unverified,
		category_counts: categoryCounts,
		unknown_categories: unknownCategories,
		distinct_categories: distinctCategories,
		largest_class_share: largestClassShare,
		imbalance_ratio: imbalanceRatio,
		unique_signatures: uniqueSignatures,
		duplicate_signatures: duplicateSignatures,
		dedupe_rate: dedupeRate,
		avg_confidence: avgConfidence,
		low_confidence: lowConfidence,
		readiness: { ready: reasons.length === 0, reasons },
		thresholds,
	};
}

export function registerKbCommand(program: Command): void {
	const kbCmd = program
		.command("kb")
		.description("Export and import the knowledge base (learned rules and flaky signatures)");

	// failsafe kb export [--output kb.json] [--min-confidence 0.5]
	kbCmd
		.command("export")
		.description("Export learned rules and flaky signatures to a JSON file")
		.option("--output <file>", "Output file path", "kb.json")
		.option("--min-confidence <n>", "Minimum confidence for learned rules", "0.5")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const minConfidence = Number.parseFloat(opts.minConfidence);
			const outputFile = opts.output as string;

			const learnedRules = store.listLearnedRules({ minConfidence });
			const flakySignatures = store.listFlakySignatures();

			const kbData: KbExport = {
				schema_version: SCHEMA_VERSION,
				exported_at: new Date().toISOString(),
				learned_rules: learnedRules,
				flaky_signatures: flakySignatures,
			};

			writeFileSync(outputFile, JSON.stringify(kbData, null, 2), "utf-8");

			outputResult(
				{
					exported_to: outputFile,
					learned_rules_count: learnedRules.length,
					flaky_signatures_count: flakySignatures.length,
					min_confidence: minConfidence,
				},
				outOpts,
				(d) => {
					const data = d as {
						exported_to: string;
						learned_rules_count: number;
						flaky_signatures_count: number;
					};
					return [
						`Exported knowledge base to ${data.exported_to}`,
						`  Learned rules: ${data.learned_rules_count}`,
						`  Flaky signatures: ${data.flaky_signatures_count}`,
					].join("\n");
				},
			);

			store.close();
		});

	// failsafe kb export-dataset [--output dataset.jsonl] [--success-only]
	// Emits resolved failure -> diagnosis -> fix training pairs (JSONL), the
	// prerequisite dataset for any future local diagnosis model.
	kbCmd
		.command("export-dataset")
		.description("Export resolved failure/fix pairs as JSONL training data")
		.option("--output <file>", "Output JSONL file path", "dataset.jsonl")
		.option("--success-only", "Only include successful fixes")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);
			const outputFile = opts.output as string;
			const successOnly = opts.successOnly === true;

			const outcomes = store.listFixOutcomes({ successOnly });
			const lines: string[] = [];
			let withDiagnosis = 0;

			for (const outcome of outcomes) {
				const failure = store.getFailure(outcome.failure_id);
				if (!failure) continue;
				const diagnosis = store.getDiagnosis(outcome.failure_id);
				if (diagnosis) withDiagnosis++;

				const firstError = failure.parsed.flatMap((p) => p.errors)[0];
				const sample = {
					signature_hash: outcome.signature_hash,
					// Input features (the "error")
					command: failure.command,
					failure_type: failure.parsed[0]?.failure_type ?? "unknown",
					error_type: firstError?.error_type,
					error_message: firstError?.message,
					primary_location: failure.primary_location,
					// Target label (the "diagnosis")
					category: diagnosis?.root_cause?.category,
					explanation: diagnosis?.root_cause?.explanation,
					confidence: diagnosis?.root_cause?.confidence,
					rule_source: diagnosis?.rule_source,
					// Outcome (the "fix")
					fix_summary: outcome.fix_summary,
					fix_commands: outcome.fix_commands,
					files_changed: outcome.files_changed,
					success: outcome.success,
					resolved_at: outcome.resolved_at,
				};
				lines.push(JSON.stringify(sample));
			}

			writeFileSync(outputFile, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf-8");

			outputResult(
				{
					exported_to: outputFile,
					samples: lines.length,
					with_diagnosis: withDiagnosis,
					success_only: successOnly,
				},
				outOpts,
				(d) => {
					const data = d as { exported_to: string; samples: number; with_diagnosis: number };
					return [
						`Exported ${data.samples} training sample(s) to ${data.exported_to}`,
						`  With diagnosis labels: ${data.with_diagnosis}`,
					].join("\n");
				},
			);

			store.close();
		});

	// failsafe kb dataset-stats [--success-only] [--gate] [thresholds...]
	// Reports corpus health for the classifier dataset (item 27): class balance
	// across KNOWN_DIAGNOSIS_CATEGORIES, dedupe rate, label confidence, and a
	// readiness gate the classifier work (item 3) can consume in CI.
	kbCmd
		.command("dataset-stats")
		.description("Report training-data quality metrics and a classifier readiness gate")
		.option("--success-only", "Only count successful fixes")
		.option("--gate", "Exit non-zero when the corpus is not classifier-ready")
		.option("--min-samples <n>", "Minimum labeled samples for readiness")
		.option("--min-categories <n>", "Minimum distinct categories for readiness")
		.option("--max-imbalance <n>", "Maximum class-imbalance ratio for readiness")
		.option("--max-dedupe-rate <n>", "Maximum duplicate-signature rate (0..1) for readiness")
		.option("--min-labeled-fraction <n>", "Minimum labeled fraction (0..1) for readiness")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			const thresholds: Partial<DatasetThresholds> = {};
			if (opts.minSamples !== undefined)
				thresholds.min_samples = Number.parseInt(opts.minSamples, 10);
			if (opts.minCategories !== undefined)
				thresholds.min_categories = Number.parseInt(opts.minCategories, 10);
			if (opts.maxImbalance !== undefined)
				thresholds.max_imbalance_ratio = Number.parseFloat(opts.maxImbalance);
			if (opts.maxDedupeRate !== undefined)
				thresholds.max_dedupe_rate = Number.parseFloat(opts.maxDedupeRate);
			if (opts.minLabeledFraction !== undefined)
				thresholds.min_labeled_fraction = Number.parseFloat(opts.minLabeledFraction);

			const stats = computeDatasetStats(store, {
				successOnly: opts.successOnly === true,
				thresholds,
			});

			outputResult(stats as unknown as Record<string, unknown>, outOpts, (d) => {
				const s = d as DatasetStats;
				const lines = [
					`[DATASET] ${s.labeled}/${s.total_samples} labeled sample(s), ${s.distinct_categories} categor(ies)`,
					`  ready: ${s.readiness.ready ? "yes" : "no"}`,
					`  dedupe_rate: ${s.dedupe_rate.toFixed(2)}  imbalance: ${s.imbalance_ratio === null ? "n/a" : s.imbalance_ratio.toFixed(1)}  avg_confidence: ${s.avg_confidence === null ? "n/a" : s.avg_confidence.toFixed(2)}`,
					`  resolved_unverified: ${s.resolved_unverified}  low_confidence: ${s.low_confidence}`,
				];
				const present = Object.entries(s.category_counts).filter(([, n]) => n > 0);
				if (present.length > 0) {
					lines.push("  categories:");
					for (const [c, n] of present) lines.push(`    ${c}: ${n}`);
				}
				for (const reason of s.readiness.reasons) lines.push(`  - ${reason}`);
				return lines.join("\n");
			});

			store.close();
			if (opts.gate === true && !stats.readiness.ready) process.exit(ExitCode.ERROR);
		});

	// failsafe kb classify-eval [--dataset dataset.jsonl] [--folds 5] [--seed 1]
	// Evaluation prototype (item 3): compare a tiny offline Naive Bayes classifier
	// against template/builtin matching via k-fold cross-validation on the
	// `kb export-dataset` corpus, and report whether the model is worth promoting.
	kbCmd
		.command("classify-eval")
		.description("Evaluate the prototype diagnosis classifier vs template matching")
		.option("--dataset <file>", "JSONL dataset from 'kb export-dataset'", "dataset.jsonl")
		.option("--folds <n>", "Cross-validation folds", "5")
		.option("--seed <n>", "Deterministic shuffle seed", "1")
		.option("--gate", "Exit non-zero unless the classifier beats the baseline")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);
			// The corpus comes from a file, not the live store; close it promptly.
			store.close();

			const datasetFile = opts.dataset as string;
			let jsonl: string;
			try {
				jsonl = readFileSync(datasetFile, "utf-8");
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read dataset: ${(err as Error).message}` },
					outOpts,
				);
				process.exit(ExitCode.NO_INPUT);
			}

			const samples = loadDatasetSamples(jsonl);
			if (samples.length === 0) {
				outputResult(
					{
						error: true,
						message: `No labeled samples in ${datasetFile}; run 'failsafe kb export-dataset' after resolving some failures.`,
					},
					outOpts,
				);
				process.exit(ExitCode.NO_INPUT);
			}

			const evaluation = evaluateClassifier(samples, {
				folds: Number.parseInt(opts.folds, 10),
				seed: Number.parseInt(opts.seed, 10),
			});

			outputResult(evaluation as unknown as Record<string, unknown>, outOpts, (d) => {
				const e = d as ClassifierEvaluation;
				return [
					`[CLASSIFY-EVAL] ${e.samples} sample(s), ${e.classes} class(es), ${e.folds}-fold`,
					`  classifier accuracy: ${(e.classifier.accuracy * 100).toFixed(1)}%`,
					`  baseline accuracy:   ${(e.baseline.accuracy * 100).toFixed(1)}%`,
					`  improvement: ${(e.improvement * 100).toFixed(1)} pts  ->  ${e.verdict}`,
					`  ${e.recommendation}`,
				].join("\n");
			});

			if (opts.gate === true && evaluation.verdict !== "classifier_wins") {
				process.exit(ExitCode.ERROR);
			}
		});

	// failsafe kb calibration --predictions <file>
	kbCmd
		.command("calibration")
		.description("Report localization confidence calibration, top-k coverage, and OOD slices")
		.option(
			"--predictions <file>",
			"JSONL of {id, level, confidence, ranked[], truth, slice?}",
			"predictions.jsonl",
		)
		.option("--bins <n>", "Reliability-curve bin count", "10")
		.option("--gate", "Exit non-zero when confidences are overconfident")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);
			// The corpus comes from a file, not the live store; close it promptly.
			store.close();

			const file = opts.predictions as string;
			let jsonl: string;
			try {
				jsonl = readFileSync(file, "utf-8");
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read predictions: ${(err as Error).message}` },
					outOpts,
				);
				process.exit(ExitCode.NO_INPUT);
			}

			const predictions = loadPredictions(jsonl);
			if (predictions.length === 0) {
				outputResult(
					{ error: true, message: `No usable localization predictions in ${file}` },
					outOpts,
				);
				process.exit(ExitCode.NO_INPUT);
			}

			const report = calibrationReport(predictions, {
				bins: Number.parseInt(opts.bins, 10),
			});

			outputResult(report as unknown as Record<string, unknown>, outOpts, (d) => {
				const r = d as CalibrationReport;
				const lines = [
					`[CALIBRATION] ${r.samples} prediction(s) -> ${r.verdict}`,
					`  accuracy: ${(r.overall.accuracy * 100).toFixed(1)}%  ECE: ${r.overall.reliability.expected_calibration_error.toFixed(3)}  MCE: ${r.overall.reliability.maximum_calibration_error.toFixed(3)}  Brier: ${r.overall.reliability.brier_score.toFixed(3)}`,
					`  MRR: ${r.overall.coverage.mean_reciprocal_rank.toFixed(3)}  recall@1/3/5: ${[1, 3, 5]
						.map((k) => ((r.overall.coverage.recall_at_k[k] ?? 0) * 100).toFixed(0))
						.join("/")}%`,
					`  abstained: ${(r.overall.abstention.abstention_rate * 100).toFixed(1)}%  selective gain: ${(r.overall.abstention.selective_gain * 100).toFixed(1)} pts`,
				];
				for (const level of r.by_level) {
					lines.push(
						`  ${level.level.padEnd(8)} n=${level.samples} acc=${(level.accuracy * 100).toFixed(0)}% MRR=${level.coverage.mean_reciprocal_rank.toFixed(2)}`,
					);
				}
				for (const slice of r.slices) {
					lines.push(
						`  slice ${slice.key}=${slice.value}: n=${slice.samples} acc=${(slice.accuracy * 100).toFixed(0)}% ECE=${slice.expected_calibration_error.toFixed(3)}`,
					);
				}
				lines.push(`  ${r.recommendation}`);
				return lines.join("\n");
			});

			if (opts.gate === true && report.verdict === "overconfident") {
				process.exit(ExitCode.ERROR);
			}
		});

	// failsafe kb import <file> [--dry-run]
	kbCmd
		.command("import <file>")
		.description("Import learned rules and flaky signatures from a JSON file")
		.option("--dry-run", "Preview what would be imported without making changes")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (file: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const dryRun = opts.dryRun === true;

			let kbData: KbExport;
			try {
				const raw = readFileSync(file, "utf-8");
				kbData = JSON.parse(raw) as KbExport;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read KB file: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			// Schema compatibility gate: reject incompatible major versions with a
			// clear reason; accept same-major (including legacy/no-version) best-effort.
			const compat = checkSchemaCompatibility(kbData.schema_version);
			if (compat.action === "reject") {
				outputResult(
					{
						error: true,
						schema_incompatible: true,
						message: compat.reason,
						file_version: compat.version,
						expected_version: compat.current,
					},
					outOpts,
				);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			const learnedRules = kbData.learned_rules ?? [];
			const flakySignatures = kbData.flaky_signatures ?? [];

			let rulesImported = 0;
			let rulesSkipped = 0;
			let flakyImported = 0;
			const flakySkipped = 0;

			if (!dryRun) {
				for (const rule of learnedRules) {
					const existing = store.getLearnedRuleByHash(rule.signature_hash);
					if (existing) {
						// Merge: keep higher confidence, higher counts
						if (
							rule.confidence > existing.confidence ||
							rule.occurrence_count > existing.occurrence_count
						) {
							store.updateLearnedRule(existing.rule_id, {
								confidence: Math.max(rule.confidence, existing.confidence),
								occurrence_count: Math.max(rule.occurrence_count, existing.occurrence_count),
								success_count: Math.max(rule.success_count, existing.success_count),
								distinct_files: Math.max(rule.distinct_files, existing.distinct_files),
								fix_summary: rule.fix_summary ?? existing.fix_summary,
								fix_commands: rule.fix_commands ?? existing.fix_commands,
								last_seen_at:
									rule.last_seen_at > existing.last_seen_at
										? rule.last_seen_at
										: existing.last_seen_at,
							});
							rulesImported++;
						} else {
							rulesSkipped++;
						}
					} else {
						store.insertLearnedRule(rule);
						rulesImported++;
					}
				}

				for (const record of flakySignatures) {
					const existing = store.getFlakySignature(record.signature_hash);
					if (existing) {
						// Merge: keep the higher count, earliest first_recurrence, latest last_recurrence
						store.upsertFlakySignature({
							signature_hash: record.signature_hash,
							failure_count_after_fix: Math.max(
								record.failure_count_after_fix,
								existing.failure_count_after_fix,
							),
							first_recurrence_at:
								record.first_recurrence_at < existing.first_recurrence_at
									? record.first_recurrence_at
									: existing.first_recurrence_at,
							last_recurrence_at:
								record.last_recurrence_at > existing.last_recurrence_at
									? record.last_recurrence_at
									: existing.last_recurrence_at,
							marked_flaky_at: existing.marked_flaky_at ?? record.marked_flaky_at,
						});
						flakyImported++;
					} else {
						store.upsertFlakySignature(record);
						flakyImported++;
					}
				}
			} else {
				// Dry run: just count what would happen
				for (const rule of learnedRules) {
					const existing = store.getLearnedRuleByHash(rule.signature_hash);
					if (existing) {
						if (
							rule.confidence > existing.confidence ||
							rule.occurrence_count > existing.occurrence_count
						) {
							rulesImported++;
						} else {
							rulesSkipped++;
						}
					} else {
						rulesImported++;
					}
				}
				for (const record of flakySignatures) {
					const existing = store.getFlakySignature(record.signature_hash);
					if (existing) {
						flakyImported++;
					} else {
						flakyImported++;
					}
				}
			}

			outputResult(
				{
					source_file: file,
					dry_run: dryRun,
					learned_rules: {
						imported: rulesImported,
						skipped: rulesSkipped,
						total_in_file: learnedRules.length,
					},
					flaky_signatures: {
						imported: flakyImported,
						skipped: flakySkipped,
						total_in_file: flakySignatures.length,
					},
				},
				outOpts,
				(d) => {
					const data = d as {
						source_file: string;
						dry_run: boolean;
						learned_rules: { imported: number; skipped: number; total_in_file: number };
						flaky_signatures: { imported: number; skipped: number; total_in_file: number };
					};
					const prefix = data.dry_run ? "[DRY RUN] " : "";
					const lines = [
						`${prefix}Import from ${data.source_file}`,
						`  Learned rules: ${data.learned_rules.imported} imported, ${data.learned_rules.skipped} skipped (${data.learned_rules.total_in_file} in file)`,
						`  Flaky signatures: ${data.flaky_signatures.imported} imported, ${data.flaky_signatures.skipped} skipped (${data.flaky_signatures.total_in_file} in file)`,
					];
					return lines.join("\n");
				},
			);

			store.close();
		});
}
