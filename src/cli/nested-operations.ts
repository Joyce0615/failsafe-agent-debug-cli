/**
 * `failsafe nested-operations diagnose` — nested agent-operation failure
 * diagnosis CLI entry point (item 42).
 *
 * Mirrors `capability-drift.ts` (item 36) and `trace-gaps.ts` (item 32):
 * read-only, local-file. Reads an already-normalized `GenAiSpan[]` JSON
 * array (the exact shape `trace/genai-normalize.ts`'s `normalizeGenAiTrace`
 * already produces from a live backend poll) and runs the SAME
 * `diagnoseNestedOperations` path a live trace-ingestion integration would
 * call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	diagnoseNestedOperations,
	renderNestedOperationReport,
} from "../diagnosis/nested-agent-operations.js";
import type { GenAiSpan } from "../trace/genai-normalize.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerNestedOperationsCommand(program: Command): void {
	const nestedOperations = program
		.command("nested-operations")
		.description(
			"Diagnose nested agent-operation failures: lost parents, duplicate recording, misattributed cost, authority drift",
		);

	nestedOperations
		.command("diagnose")
		.description(
			"Reconstruct the client/internal agent, workflow, plan, retrieval, memory, and tool nesting tree from already-normalized GenAI spans and report lost parents, duplicate recording, misattributed cost, and authority drift",
		)
		.requiredOption(
			"--spans <path>",
			"Path to a JSON GenAiSpan[] array (see trace/genai-normalize.ts)",
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let spans: GenAiSpan[];
			try {
				spans = readJson(opts.spans as string) as GenAiSpan[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = diagnoseNestedOperations(spans);

			if (opts.render) {
				process.stdout.write(renderNestedOperationReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
