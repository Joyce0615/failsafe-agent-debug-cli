import type { Command } from "commander";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureId } from "./shared.js";

export function registerExplainCommand(program: Command): void {
	program
		.command("explain <failure-id>")
		.description("Combine all evidence into a compact explanation")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

			const failureId = resolveFailureId(rawId, store);
			if (!failureId) {
				outputResult({ error: true, message: "No failure found" }, outOpts);
				process.exit(1);
			}

			const failure = store.getFailure(failureId);
			if (!failure) {
				outputResult({ error: true, message: `Failure not found: ${failureId}` }, outOpts);
				process.exit(1);
			}

			// Collect all available evidence
			const diagnosis = store.getDiagnosis(failureId);
			const repro = store.getRepro(failureId);

			const evidence: string[] = [];
			const fixOptions: Array<{ title: string; risk: string; files: string[]; rationale: string }> =
				[];

			// From diagnosis
			if (diagnosis) {
				for (const e of diagnosis.evidence) {
					evidence.push(`${e.location ? `${e.location}: ` : ""}${e.value}`);
				}
			}

			// From repro
			if (repro && repro.status === "verified") {
				evidence.push(`Minimal repro: ${repro.command}`);
			}

			// Generate summary
			const summary =
				diagnosis?.summary ?? failure.parsed[0]?.errors[0]?.message ?? "Unknown failure";

			// Suggest fix options based on diagnosis category
			if (diagnosis?.root_cause) {
				const cat = diagnosis.root_cause.category;
				if (cat === "null_reference" || cat === "key_error" || cat === "attribute_error") {
					fixOptions.push({
						title: "Add null/undefined guard",
						risk: "low",
						files: failure.primary_location ? [failure.primary_location.file] : [],
						rationale: "Prevent access to undefined values",
					});
					fixOptions.push({
						title: "Validate input before usage",
						risk: "low",
						files: failure.primary_location ? [failure.primary_location.file] : [],
						rationale: "Reject invalid data early",
					});
				} else if (cat === "import_error") {
					fixOptions.push({
						title: "Install missing dependency",
						risk: "low",
						files: ["package.json"],
						rationale: "Module needs to be installed",
					});
					fixOptions.push({
						title: "Fix import path",
						risk: "low",
						files: failure.primary_location ? [failure.primary_location.file] : [],
						rationale: "Import path may be incorrect",
					});
				} else if (cat === "assertion_mismatch") {
					fixOptions.push({
						title: "Fix the code to produce expected output",
						risk: "medium",
						files: failure.primary_location ? [failure.primary_location.file] : [],
						rationale: "Code behavior doesn't match test expectations",
					});
					fixOptions.push({
						title: "Update test expectations",
						risk: "medium",
						files: failure.parsed[0]?.errors[0]?.test_file
							? [failure.parsed[0].errors[0].test_file]
							: [],
						rationale: "Test expectations may be outdated",
					});
				}
			}

			const output: Record<string, unknown> = {
				failure_id: failureId,
				summary,
				evidence,
			};

			if (fixOptions.length > 0) {
				output.fix_options = fixOptions;
				output.recommended_fix = fixOptions[0].title;
			}

			output.verify = { command: `failsafe verify ${failureId}` };

			outputResult(output, outOpts, () => {
				const lines = [`[EXPLAIN] ${failureId}`, `Summary: ${summary}`, "", "Evidence:"];
				for (const e of evidence) {
					lines.push(`  - ${e}`);
				}
				if (fixOptions.length > 0) {
					lines.push("", "Fix options:");
					for (const f of fixOptions) {
						lines.push(`  [${f.risk}] ${f.title}`);
						lines.push(`    ${f.rationale}`);
					}
				}
				lines.push("", `Verify: failsafe verify ${failureId}`);
				return lines.join("\n");
			});

			store.close();
		});
}
