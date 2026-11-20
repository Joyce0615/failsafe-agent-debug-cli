/**
 * `failsafe leakage-trace sweep` — prompt-variable / structured-result
 * leakage detection CLI entry point (item 46).
 *
 * Mirrors `spec-divergence.ts`'s (item 45) and `authorization-drift.ts`'s
 * (item 44) read-only, local-JSON-file pattern: a caller has already
 * captured what each surface (span/log/exception/cache/bundle/
 * model_visible_result) actually recorded for each tracked value, and this
 * command runs the same `sweepLeakage` path a live capture pipeline would
 * call against that already-captured evidence.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type TrackedValueCapture,
	renderLeakageSweepReport,
	sweepLeakage,
} from "../diagnosis/leakage-trace.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerLeakageTraceCommand(program: Command): void {
	const leakageTrace = program
		.command("leakage-trace")
		.description(
			"Trace prompt-variable and structured-result values across spans, logs, exceptions, caches, bundles, and model-visible results for leakage",
		);

	leakageTrace
		.command("sweep")
		.description(
			"Classify each tracked value's surface captures as schema_metadata_only, compliant, leaked, or inconsistent_transform against the shared data-class policy",
		)
		.requiredOption(
			"--captures <path>",
			"Path to a JSON TrackedValueCapture[] array ({ value: TrackedValue, captures: SurfaceCapture[] }[])",
		)
		.option("--salt <salt>", "PII hash salt, overriding FAILSAFE_PII_SALT")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let valuesWithCaptures: TrackedValueCapture[];
			try {
				valuesWithCaptures = readJson(opts.captures) as TrackedValueCapture[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const report = sweepLeakage(valuesWithCaptures, opts.salt ? { salt: opts.salt } : {});

			if (opts.render) {
				process.stdout.write(renderLeakageSweepReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
