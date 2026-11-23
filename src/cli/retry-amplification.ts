/**
 * `failsafe retry-amplification diagnose` — retry-induced fault
 * persistence and cascade-amplification CLI entry point (item 58).
 *
 * Mirrors `mrtr.ts`'s (item 51) and `workflow-executor-attribution.ts`'s
 * (item 57) read-only, local-JSON-file pattern. A caller supplies every
 * already-diagnosed `RetryAttempt` of one retry loop (each with its own
 * `Incident` and causal-graph `blast_radius`); this command runs the
 * same `diagnoseRetryPersistence` path a live retry-tracking pipeline
 * would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type RetryAttempt,
	diagnoseRetryPersistence,
	renderRetryPersistenceReport,
} from "../diagnosis/retry-amplification.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerRetryAmplificationCommand(program: Command): void {
	const retry = program
		.command("retry-amplification")
		.description(
			"Trace retry-induced fault persistence and amplification across a retry loop's attempts",
		);

	retry
		.command("diagnose")
		.description("Compare causal signatures and blast radii across consecutive retry attempts")
		.requiredOption("--attempts <path>", "Path to a JSON RetryAttempt[] array")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let attempts: RetryAttempt[];
			try {
				attempts = readJson(opts.attempts as string) as RetryAttempt[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const report = diagnoseRetryPersistence(attempts);

			if (opts.render) {
				process.stdout.write(renderRetryPersistenceReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
