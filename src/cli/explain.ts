import type { Command } from "commander";
import { type ExplainFixOption, explainFailure } from "../core/operations.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

export function registerExplainCommand(program: Command): void {
	program
		.command("explain <failure-id>")
		.description("Combine all evidence into a compact explanation")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);

			const result = explainFailure(rawId, store);
			if (!result.ok) {
				outputResult({ error: true, message: result.error.message }, outOpts);
				store.close();
				process.exit(result.error.exit_code);
			}

			const output = result.data;
			const summary = output.summary as string;
			const evidence = output.evidence as string[];
			const fixOptions = (output.fix_options as ExplainFixOption[] | undefined) ?? [];
			const failureId = output.failure_id as string;

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
