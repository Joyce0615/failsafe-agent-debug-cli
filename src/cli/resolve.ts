import type { Command } from "commander";
import { checkFlaky } from "../rules/flaky.js";
import {
	boostConfidence,
	checkPromotionEligibility,
	computeSignatureHash,
} from "../rules/learned.js";
import type { FixOutcome } from "../rules/types.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

export function registerResolveCommand(program: Command): void {
	program
		.command("resolve <failure-id>")
		.description("Record fix outcome for a failure and update learned rules")
		.option("--success", "Mark fix as successful")
		.option("--fail", "Mark fix as unsuccessful")
		.option("--fix-summary <summary>", "Description of the fix applied")
		.option("--files-changed <files>", "Comma-separated list of changed files")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

			const { failureId, failure } = resolveFailureOrExit(rawId, store, outOpts);

			// Determine success/fail
			const success = opts.success === true;
			if (!opts.success && !opts.fail) {
				outputResult({ error: true, message: "Specify --success or --fail" }, outOpts);
				process.exit(ExitCode.ERROR);
			}

			// Compute signature hash from the failure's parsed errors
			const allErrors = failure.parsed.flatMap((p) => p.errors);
			const primaryLocation = failure.primary_location;
			const signatureHash = computeSignatureHash(allErrors, primaryLocation);

			const filesChanged = opts.filesChanged
				? (opts.filesChanged as string).split(",").map((f: string) => f.trim())
				: [];

			// Record fix outcome
			const now = new Date().toISOString();
			const outcome: FixOutcome = {
				failure_id: failureId,
				signature_hash: signatureHash,
				resolved_at: now,
				success,
				fix_summary: opts.fixSummary,
				files_changed: filesChanged.length > 0 ? filesChanged : undefined,
			};
			store.insertFixOutcome(outcome);

			// If success: boost learned rule confidence, mark signature as resolved
			if (success) {
				boostConfidence(store, signatureHash, outcome);
				store.markSignatureResolved(failureId, opts.fixSummary ?? "", filesChanged);
			}

			// Check flaky detection
			const flakyThreshold = config.rules?.flaky_recurrence_threshold ?? 3;
			const isFlaky = checkFlaky(store, signatureHash, flakyThreshold);

			// Check promotion eligibility
			let promotionSuggestion: string | undefined;
			const learnedRule = store.getLearnedRuleByHash(signatureHash);
			if (learnedRule) {
				const promotion = checkPromotionEligibility(learnedRule, config);
				if (promotion) {
					promotionSuggestion = promotion.yaml_snippet;
				}
			}

			const result: Record<string, unknown> = {
				failure_id: failureId,
				signature_hash: signatureHash,
				success,
				fix_summary: opts.fixSummary,
				files_changed: filesChanged.length > 0 ? filesChanged : undefined,
				is_flaky: isFlaky,
			};

			if (promotionSuggestion) {
				result.promotion_eligible = true;
				result.promotion_yaml = promotionSuggestion;
			}

			outputResult(result, outOpts, (d) => {
				const data = d as typeof result;
				const lines: string[] = [];
				lines.push(`[RESOLVE] ${data.failure_id}`);
				lines.push(`Outcome: ${data.success ? "SUCCESS" : "FAIL"}`);
				lines.push(`Signature: ${data.signature_hash}`);
				if (data.fix_summary) {
					lines.push(`Fix: ${data.fix_summary}`);
				}
				if (data.files_changed && (data.files_changed as string[]).length > 0) {
					lines.push(`Files changed: ${(data.files_changed as string[]).join(", ")}`);
				}
				if (data.is_flaky) {
					lines.push("WARNING: This failure is marked as FLAKY (recurs after fix)");
				}
				if (data.promotion_eligible) {
					lines.push("\nPromotion eligible! Add to .failsafe/rules.yaml:");
					lines.push(data.promotion_yaml as string);
				}
				return lines.join("\n");
			});

			store.close();
		});
}
