import type { Command } from "commander";
import { TEMPLATES } from "../diagnosis/templates.js";
import { evaluateBuiltinRules } from "../rules/builtin.js";
import {
	loadDeclaredRules,
	reloadDeclaredRules,
	validateDeclaredRules,
} from "../rules/declared.js";
import { listFlaky } from "../rules/flaky.js";
import { disableRule } from "../rules/lifecycle.js";
import type { DeclaredRule, LearnedRule } from "../rules/types.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { initCommand, loadConfig } from "./shared.js";

export function registerRulesCommand(program: Command): void {
	const rulesCmd = program
		.command("rules")
		.description("Manage diagnosis rules (declared, learned, and builtin)");

	// failsafe rules list [--source declared|learned|builtin] [--format json|text]
	rulesCmd
		.command("list")
		.description("List all diagnosis rules")
		.option("--source <source>", "Filter by source: declared, learned, or builtin")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const source = opts.source as string | undefined;

			const allRules: Array<Record<string, unknown>> = [];

			// Declared rules
			if (!source || source === "declared") {
				const rulesFilePath = `${process.cwd()}/${config.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
				const declared = loadDeclaredRules(rulesFilePath);
				for (const rule of declared) {
					allRules.push({
						rule_id: rule.id,
						source: "declared",
						category: rule.diagnosis.category,
						confidence: rule.confidence,
						enforcement: rule.diagnosis.enforcement,
						explanation: rule.diagnosis.explanation.substring(0, 120),
					});
				}
			}

			// Learned rules
			if (!source || source === "learned") {
				const learned = store.listLearnedRules();
				for (const rule of learned) {
					allRules.push({
						rule_id: rule.rule_id,
						source: "learned",
						category: rule.category,
						confidence: rule.confidence,
						lifecycle: rule.lifecycle,
						occurrence_count: rule.occurrence_count,
						success_count: rule.success_count,
						explanation: rule.explanation.substring(0, 120),
					});
				}
			}

			// Builtin rules
			if (!source || source === "builtin") {
				for (const template of TEMPLATES) {
					allRules.push({
						rule_id: template.id,
						source: "builtin",
						category: template.category,
					});
				}
			}

			outputResult({ rules: allRules, total: allRules.length }, outOpts, (d) => {
				const data = d as { rules: Array<Record<string, unknown>>; total: number };
				if (data.rules.length === 0) return "No rules found.";
				const lines = [`Rules (${data.total}):`];
				for (const r of data.rules) {
					const parts = [`  [${r.source}] ${r.rule_id}`];
					if (r.category) parts.push(`(${r.category})`);
					if (r.confidence !== undefined) parts.push(`conf=${r.confidence}`);
					if (r.lifecycle) parts.push(`[${r.lifecycle}]`);
					lines.push(parts.join(" "));
					if (r.explanation) {
						lines.push(`    ${r.explanation}`);
					}
				}
				return lines.join("\n");
			});

			store.close();
		});

	// failsafe rules show <rule-id> [--format json|text]
	rulesCmd
		.command("show <rule-id>")
		.description("Show details for a specific rule")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (ruleId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

			// Try declared rules first
			const rulesFilePath = `${process.cwd()}/${config.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
			const declared = loadDeclaredRules(rulesFilePath);
			const declaredMatch = declared.find((r) => r.id === ruleId);
			if (declaredMatch) {
				outputResult({ source: "declared", rule: declaredMatch }, outOpts, (d) =>
					formatDeclaredRule((d as { rule: DeclaredRule }).rule),
				);
				store.close();
				return;
			}

			// Try learned rules
			const learnedMatch = store.getLearnedRule(ruleId);
			if (learnedMatch) {
				outputResult({ source: "learned", rule: learnedMatch }, outOpts, (d) =>
					formatLearnedRule((d as { rule: LearnedRule }).rule),
				);
				store.close();
				return;
			}

			// Try builtin
			const builtinMatch = TEMPLATES.find((t) => t.id === ruleId);
			if (builtinMatch) {
				outputResult(
					{ source: "builtin", rule: { id: builtinMatch.id, category: builtinMatch.category } },
					outOpts,
					(d) => {
						const data = d as { rule: { id: string; category: string } };
						return `[builtin] ${data.rule.id}\nCategory: ${data.rule.category}`;
					},
				);
				store.close();
				return;
			}

			outputResult({ error: true, message: `Rule not found: ${ruleId}` }, outOpts);
			store.close();
			process.exit(1);
		});

	// failsafe rules validate [--format json|text]
	rulesCmd
		.command("validate")
		.description("Validate declared rules file for errors")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const config = loadConfig();
			const outOpts = resolveOutputOptions(
				opts,
				config.default_format,
				config.token_budget.max_output_bytes,
			);

			const rulesFilePath = `${process.cwd()}/${config.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
			let declared: DeclaredRule[];
			try {
				declared = loadDeclaredRules(rulesFilePath);
			} catch (err) {
				outputResult(
					{
						valid: false,
						errors: [
							{ rule_id: "N/A", message: `Failed to parse rules file: ${(err as Error).message}` },
						],
					},
					outOpts,
					(d) => {
						const data = d as { errors: Array<{ message: string }> };
						return `INVALID: ${data.errors[0].message}`;
					},
				);
				process.exit(1);
			}

			const errors = validateDeclaredRules(declared);

			outputResult(
				{ valid: errors.length === 0, rules_count: declared.length, errors },
				outOpts,
				(d) => {
					const data = d as {
						valid: boolean;
						rules_count: number;
						errors: Array<{ rule_id: string; message: string }>;
					};
					if (data.valid) {
						return `Valid: ${data.rules_count} rule(s), no errors.`;
					}
					const lines = [`INVALID: ${data.errors.length} error(s) in ${data.rules_count} rule(s):`];
					for (const e of data.errors) {
						lines.push(`  [${e.rule_id}] ${e.message}`);
					}
					return lines.join("\n");
				},
			);

			if (errors.length > 0) {
				process.exit(1);
			}
		});

	// failsafe rules reload [--format json|text]
	rulesCmd
		.command("reload")
		.description("Force a re-read of the declared rules file (hot-reload without restart)")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const config = loadConfig();
			const outOpts = resolveOutputOptions(
				opts,
				config.default_format,
				config.token_budget.max_output_bytes,
			);

			const rulesFilePath = `${process.cwd()}/${config.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
			const declared = reloadDeclaredRules(rulesFilePath);

			outputResult(
				{ reloaded: true, rules_file: rulesFilePath, rules_count: declared.length },
				outOpts,
				(d) => {
					const data = d as { rules_file: string; rules_count: number };
					return `Reloaded ${data.rules_count} declared rule(s) from ${data.rules_file}`;
				},
			);
		});

	// failsafe rules export-learned [--min-confidence 0.5] [--format json|text]
	rulesCmd
		.command("export-learned")
		.description("Export learned rules as YAML snippets for promotion")
		.option("--min-confidence <n>", "Minimum confidence threshold", "0.5")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const minConfidence = Number.parseFloat(opts.minConfidence);

			const learned = store.listLearnedRules({ minConfidence });
			const exported = learned.map((rule) => ({
				rule_id: rule.rule_id,
				signature_hash: rule.signature_hash,
				category: rule.category,
				explanation: rule.explanation,
				confidence: rule.confidence,
				occurrence_count: rule.occurrence_count,
				success_count: rule.success_count,
				fix_summary: rule.fix_summary,
				fix_commands: rule.fix_commands,
				lifecycle: rule.lifecycle,
			}));

			outputResult(
				{ rules: exported, total: exported.length, min_confidence: minConfidence },
				outOpts,
				(d) => {
					const data = d as { rules: typeof exported; total: number; min_confidence: number };
					if (data.rules.length === 0)
						return `No learned rules with confidence >= ${data.min_confidence}.`;
					const lines = [`Learned rules (${data.total}, min confidence ${data.min_confidence}):`];
					for (const r of data.rules) {
						lines.push(
							`  ${r.rule_id} [${r.category}] conf=${r.confidence} (${r.occurrence_count} occurrences, ${r.success_count} fixes)`,
						);
						lines.push(`    ${r.explanation.substring(0, 120)}`);
						if (r.fix_summary) lines.push(`    Fix: ${r.fix_summary}`);
					}
					return lines.join("\n");
				},
			);

			store.close();
		});

	// failsafe rules disable <rule-id>
	rulesCmd
		.command("disable <rule-id>")
		.description("Disable a learned rule")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (ruleId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

			const rule = store.getLearnedRule(ruleId);
			if (!rule) {
				outputResult({ error: true, message: `Learned rule not found: ${ruleId}` }, outOpts);
				store.close();
				process.exit(1);
			}

			disableRule(store, ruleId);

			outputResult(
				{ rule_id: ruleId, previous_lifecycle: rule.lifecycle, new_lifecycle: "disabled" },
				outOpts,
				() => `Disabled rule: ${ruleId} (was: ${rule.lifecycle})`,
			);

			store.close();
		});

	// failsafe rules flaky [--format json|text]
	rulesCmd
		.command("flaky")
		.description("List failure signatures marked as flaky")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const { config, store, outOpts } = initCommand(opts);

			const flakyRecords = listFlaky(store);

			outputResult({ flaky_signatures: flakyRecords, total: flakyRecords.length }, outOpts, (d) => {
				const data = d as { flaky_signatures: typeof flakyRecords; total: number };
				if (data.flaky_signatures.length === 0) return "No flaky signatures found.";
				const lines = [`Flaky signatures (${data.total}):`];
				for (const r of data.flaky_signatures) {
					lines.push(
						`  ${r.signature_hash} — ${r.failure_count_after_fix} recurrence(s) after fix`,
					);
					lines.push(`    First recurrence: ${r.first_recurrence_at}`);
					lines.push(`    Last recurrence: ${r.last_recurrence_at}`);
					if (r.marked_flaky_at) lines.push(`    Marked flaky: ${r.marked_flaky_at}`);
				}
				return lines.join("\n");
			});

			store.close();
		});
}

function formatDeclaredRule(rule: DeclaredRule): string {
	const lines: string[] = [];
	lines.push(`[declared] ${rule.id}`);
	lines.push(`Category: ${rule.diagnosis.category}`);
	lines.push(`Confidence: ${rule.confidence}`);
	lines.push(`Enforcement: ${rule.diagnosis.enforcement}`);
	lines.push(`Explanation: ${rule.diagnosis.explanation}`);
	if (rule.diagnosis.fix) lines.push(`Fix: ${rule.diagnosis.fix}`);
	if (rule.diagnosis.fix_commands && rule.diagnosis.fix_commands.length > 0) {
		lines.push("Fix commands:");
		for (const cmd of rule.diagnosis.fix_commands) {
			lines.push(`  $ ${cmd}`);
		}
	}
	lines.push("Pattern:");
	if (rule.pattern.error_type) lines.push(`  error_type: ${rule.pattern.error_type}`);
	if (rule.pattern.error_contains)
		lines.push(`  error_contains: ${JSON.stringify(rule.pattern.error_contains)}`);
	if (rule.pattern.message_regex) lines.push(`  message_regex: ${rule.pattern.message_regex}`);
	if (rule.pattern.file_matches) lines.push(`  file_matches: ${rule.pattern.file_matches}`);
	if (rule.tags && rule.tags.length > 0) lines.push(`Tags: ${rule.tags.join(", ")}`);
	return lines.join("\n");
}

function formatLearnedRule(rule: LearnedRule): string {
	const lines: string[] = [];
	lines.push(`[learned] ${rule.rule_id}`);
	lines.push(`Signature hash: ${rule.signature_hash}`);
	lines.push(`Category: ${rule.category}`);
	lines.push(`Lifecycle: ${rule.lifecycle}`);
	lines.push(`Confidence: ${rule.confidence}`);
	lines.push(`Occurrences: ${rule.occurrence_count}`);
	lines.push(`Successful fixes: ${rule.success_count}`);
	lines.push(`Distinct files: ${rule.distinct_files}`);
	lines.push(`Explanation: ${rule.explanation}`);
	if (rule.error_type) lines.push(`Error type: ${rule.error_type}`);
	if (rule.error_pattern) lines.push(`Error pattern: ${rule.error_pattern}`);
	if (rule.file_pattern) lines.push(`File pattern: ${rule.file_pattern}`);
	if (rule.fix_summary) lines.push(`Fix: ${rule.fix_summary}`);
	if (rule.fix_commands && rule.fix_commands.length > 0) {
		lines.push("Fix commands:");
		for (const cmd of rule.fix_commands) {
			lines.push(`  $ ${cmd}`);
		}
	}
	lines.push(`First seen: ${rule.first_seen_at}`);
	lines.push(`Last seen: ${rule.last_seen_at}`);
	if (rule.last_success_at) lines.push(`Last success: ${rule.last_success_at}`);
	if (rule.promoted_at) lines.push(`Promoted: ${rule.promoted_at}`);
	return lines.join("\n");
}
