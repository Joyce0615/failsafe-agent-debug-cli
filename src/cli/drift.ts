/**
 * `failsafe drift report` — longitudinal diagnostic drift report CLI entry
 * point (item 30).
 *
 * Mirrors `orchestration.ts` (item 27) and `incidents.ts` (item 22):
 * read-only, local-file. Reads a JSON object of per-dimension observation
 * series (the exact shape `LongitudinalSeries` needs) plus an optional JSON
 * array of revisions, and runs the SAME `buildLongitudinalDriftReport` path
 * a live metrics-pipeline integration would call.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { Revision } from "../diagnosis/change-point.js";
import {
	DRIFT_DIMENSIONS,
	type LongitudinalSeries,
	buildLongitudinalDriftReport,
	renderLongitudinalDriftReport,
} from "../diagnosis/longitudinal-drift.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerDriftCommand(program: Command): void {
	const drift = program.command("drift").description("Longitudinal diagnostic drift reporting");

	drift
		.command("report")
		.description(
			"Publish a longitudinal drift report tracking attribution, remediation, abstention, privacy loss, cost, and latency across providers and releases, with statistically supported regression explanations",
		)
		.requiredOption(
			"--series <path>",
			'Path to a JSON object: { "attribution": [...], "remediation": [...], "abstention": [...], "privacy_loss": [...], "cost": [...], "latency": [...] }, each an array of { at_ms, value, provider }',
		)
		.option("--revisions <path>", "Path to a JSON array of Revision records")
		.option("--out <file>", "Write the report here instead of stdout")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let series: LongitudinalSeries;
			let revisions: Revision[] = [];
			try {
				const rawSeries = readJson(opts.series as string) as Partial<LongitudinalSeries>;
				series = {} as LongitudinalSeries;
				for (const dimension of DRIFT_DIMENSIONS) {
					series[dimension] = rawSeries[dimension] ?? [];
				}
				if (opts.revisions) {
					revisions = readJson(opts.revisions as string) as Revision[];
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = buildLongitudinalDriftReport({ series, revisions });

			if (opts.render) {
				const rendered = renderLongitudinalDriftReport(report);
				if (opts.out) {
					writeFileSync(opts.out as string, rendered);
					outputResult({ status: "written", file: opts.out }, outOpts);
				} else {
					process.stdout.write(rendered);
				}
			} else if (opts.out) {
				writeFileSync(opts.out as string, `${JSON.stringify(report, null, 2)}\n`);
				outputResult(
					{ status: "written", file: opts.out, regressed_dimensions: report.regressed_dimensions },
					outOpts,
				);
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
