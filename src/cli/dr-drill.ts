/**
 * `failsafe dr-drill run` — diagnostic disaster-recovery drill CLI entry
 * point (item 50).
 *
 * Mirrors `patch-validation.ts` (item 48) and `canary.ts` (item 29):
 * read-only, local-file, no network, no live chaos injection reached by
 * this command itself. The runner is file-driven — a single JSON
 * `DrillSuiteInput`-shaped object supplying whichever of the five
 * scenario inputs the caller has already captured from a REAL drill —
 * so this command runs the SAME `runDrillSuite` path a live
 * telemetry-loss/store-corruption/key-revocation/provider-outage/
 * compromised-memory drill harness would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type DrillSuiteInput,
	renderDrillSuiteReport,
	runDrillSuite,
} from "../diagnosis/dr-drill.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerDrDrillCommand(program: Command): void {
	const drDrill = program
		.command("dr-drill")
		.description(
			"Run a diagnostic disaster-recovery drill: telemetry loss, store corruption, key revocation, provider outage, and compromised debugging memory",
		);

	drDrill
		.command("run")
		.description(
			"Compose every supplied scenario, measure RPO/RTO and attribution degradation, and refuse to report an RTO unless restoration is verified safe",
		)
		.requiredOption("--input <path>", "Path to a JSON DrillSuiteInput object")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let input: DrillSuiteInput;
			try {
				input = readJson(opts.input as string) as DrillSuiteInput;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const report = runDrillSuite(input);

			if (opts.render) {
				process.stdout.write(renderDrillSuiteReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
