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
		.option("--evidence-only", "Omit suggested fixes and next actions; keep evidence only")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);

			const result = explainFailure(rawId, store);
			if (!result.ok) {
				outputResult({ error: true, message: result.error.message }, outOpts);
				store.close();
				process.exit(result.error.exit_code);
			}

			const output = result.data;
			const failureId = output.failure_id as string;

			// Render from the packet handed to the formatter, not the original,
			// so --evidence-only also drops fix options from the text view.
			outputResult(output, outOpts, (d) => {
				const packet = d as Record<string, unknown>;
				const summary = packet.summary as string;
				const evidence = (packet.evidence as string[] | undefined) ?? [];
				const fixOptions = (packet.fix_options as ExplainFixOption[] | undefined) ?? [];
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
