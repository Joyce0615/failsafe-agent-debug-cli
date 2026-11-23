/**
 * `failsafe evidence-sufficiency challenge` — evidence-sufficiency
 * challenge-set CLI entry point (item 60).
 *
 * This is a self-contained property harness, not a wrapper around an
 * existing Failsafe diagnoser -- there is no single "the" diagnoser
 * this item names, by design (the module is meant to be reusable
 * against any future diagnoser). The CLI therefore runs the harness
 * against the project's own published reference diagnoser
 * (`assessEvidenceSufficiency`) and the published default fixture
 * (`DEFAULT_EVIDENCE_BUNDLE`) by default, demonstrating the harness end
 * to end, while still accepting a caller-supplied bundle file for a
 * different fixture.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	DEFAULT_EVIDENCE_BUNDLE,
	type EvidenceBundle,
	assessEvidenceSufficiency,
	renderChallengeReport,
	runEvidenceSufficiencyChallenge,
} from "../testing/evidence-sufficiency.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerEvidenceSufficiencyCommand(program: Command): void {
	const evidence = program
		.command("evidence-sufficiency")
		.description(
			"Mutate an evidence bundle five ways and verify a diagnoser lowers confidence or abstains rather than becoming more certain",
		);

	evidence
		.command("challenge")
		.description(
			"Run the five standard challenges against the reference diagnoser (or a supplied bundle)",
		)
		.option(
			"--bundle <path>",
			"Path to a JSON EvidenceBundle to challenge instead of the published default fixture",
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let bundle: EvidenceBundle = DEFAULT_EVIDENCE_BUNDLE;
			if (opts.bundle) {
				try {
					bundle = readJson(opts.bundle as string) as EvidenceBundle;
				} catch (err) {
					outputResult(
						{ error: true, message: `Failed to read input: ${(err as Error).message}` },
						outOpts,
					);
					store.close();
					process.exit(ExitCode.NO_INPUT);
					return;
				}
			}

			const report = runEvidenceSufficiencyChallenge(assessEvidenceSufficiency, bundle);

			if (opts.render) {
				process.stdout.write(renderChallengeReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
