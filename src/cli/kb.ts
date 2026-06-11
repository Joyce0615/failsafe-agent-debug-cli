import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { FixOutcome, FlakyRecord, LearnedRule } from "../rules/types.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

type KbExport = {
	exported_at: string;
	learned_rules: LearnedRule[];
	flaky_signatures: FlakyRecord[];
};

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
				process.exit(1);
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
