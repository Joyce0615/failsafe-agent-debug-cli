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
