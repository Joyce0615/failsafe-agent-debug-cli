/**
 * `failsafe replay validate` — replay-from-scratch recovery validation CLI
 * entry point (item 38).
 *
 * Mirrors `advisories.ts` (item 37) and `capability-drift.ts` (item 36):
 * read-only, local-file. Reads recorded/rebuilt environment fingerprints, a
 * recorded failure signature, pre-fix/post-fix rerun results, and declared
 * acceptance criteria, then runs the SAME `validateReplayFromScratch` path a
 * live isolated-rebuild integration would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type AcceptanceCriteria,
	type ReplayInputs,
	renderReplayValidationResult,
	validateReplayFromScratch,
} from "../diagnosis/replay-validation.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerReplayValidationCommand(program: Command): void {
	const replay = program
		.command("replay")
		.description("Validate replay-from-scratch recovery against declared acceptance criteria");

	replay
		.command("validate")
		.description(
			"Rebuild evidence comparison: compare recorded/rebuilt environment provenance, confirm the rebuild reproduced the original failure, and accept a fix only when the regenerated evidence matches declared criteria",
		)
		.requiredOption("--inputs <path>", "Path to a JSON ReplayInputs object")
		.requiredOption("--criteria <path>", "Path to a JSON AcceptanceCriteria object")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let inputs: ReplayInputs;
			let criteria: AcceptanceCriteria;
			try {
				inputs = readJson(opts.inputs as string) as ReplayInputs;
				criteria = readJson(opts.criteria as string) as AcceptanceCriteria;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const result = validateReplayFromScratch(inputs, criteria);

			if (opts.render) {
				process.stdout.write(renderReplayValidationResult(result));
			} else {
				outputResult(result as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
