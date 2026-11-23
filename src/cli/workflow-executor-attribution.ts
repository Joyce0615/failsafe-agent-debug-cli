/**
 * `failsafe workflow-executor-attribution diagnose` — workflow-author
 * vs. executor defect attribution CLI entry point (item 57).
 *
 * Mirrors `mrtr.ts`'s (item 51) and `latent-fault-paired-control.ts`'s
 * (item 56) read-only, local-JSON-file pattern. A caller supplies every
 * already-captured `WorkflowExecutorRun` across the whole 2×2 matrix
 * of workflows and executors it wants to reason over, plus the one
 * `run_id` to attribute; this command runs the SAME `attributeDefect`
 * path a live multi-workflow/multi-executor test matrix would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type WorkflowExecutorRun,
	attributeDefect,
	renderAttributionReport,
} from "../diagnosis/workflow-executor-attribution.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerWorkflowExecutorAttributionCommand(program: Command): void {
	const attribution = program
		.command("workflow-executor-attribution")
		.description(
			"Separate workflow-author defects from executor defects using a same-workflow/different-executor and same-executor/different-workflow 2x2 matrix",
		);

	attribution
		.command("diagnose")
		.description(
			"Attribute one target run's outcome to a decomposition, execution, or interaction effect",
		)
		.requiredOption("--runs <path>", "Path to a JSON WorkflowExecutorRun[] array")
		.requiredOption("--target <runId>", "The run_id to attribute")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let runs: WorkflowExecutorRun[];
			try {
				runs = readJson(opts.runs as string) as WorkflowExecutorRun[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			let result: ReturnType<typeof attributeDefect>;
			try {
				result = attributeDefect(opts.target as string, runs);
			} catch (err) {
				outputResult({ error: true, message: (err as Error).message }, outOpts);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			if (opts.render) {
				process.stdout.write(renderAttributionReport(result));
			} else {
				outputResult(result as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
