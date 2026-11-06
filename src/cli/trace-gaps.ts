/**
 * `failsafe trace gaps` — detect and explain distributed telemetry gaps
 * (item 32).
 *
 * Mirrors `trace.ts` (item 21)/`drift.ts` (item 30): read-only, local-file.
 * Reads already-computed inputs (an `IntegritySpan[]`, a
 * `ContinueResult[]`, a `RetentionDecision[]`, and/or a `NormalizationReport`
 * — exactly the shapes `checkIntegrity`/`continueTrace`/`applyBudget`/
 * `normalizeGenAiTrace` already produce) and runs the SAME
 * `detectTelemetryGaps` path a live ingestion pipeline would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { type TelemetryGapInputs, detectTelemetryGaps } from "../trace/telemetry-gaps.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerTraceGapsCommand(program: Command): void {
	program
		.command("trace-gaps")
		.description(
			"Detect and explain distributed telemetry gaps: missing spans, broken context, clock uncertainty, sampling loss, and provider translation",
		)
		.option("--spans <path>", "Path to a JSON array of IntegritySpan")
		.option("--propagation <path>", "Path to a JSON array of ContinueResult")
		.option("--retention <path>", "Path to a JSON array of RetentionDecision")
		.option("--genai <path>", "Path to a JSON NormalizationReport")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			if (!opts.spans && !opts.propagation && !opts.retention && !opts.genai) {
				outputResult(
					{
						error: true,
						message: "At least one of --spans, --propagation, --retention, --genai is required",
					},
					outOpts,
				);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			let inputs: TelemetryGapInputs;
			try {
				inputs = {
					...(opts.spans ? { spans: readJson(opts.spans as string) as never } : {}),
					...(opts.propagation
						? { propagation_restarts: readJson(opts.propagation as string) as never }
						: {}),
					...(opts.retention ? { retention: readJson(opts.retention as string) as never } : {}),
					...(opts.genai ? { genai: readJson(opts.genai as string) as never } : {}),
				};
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read telemetry gap input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = detectTelemetryGaps(inputs);
			outputResult(report as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
