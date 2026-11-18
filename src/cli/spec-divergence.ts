/**
 * `failsafe spec-divergence diagnose|reduce` — generated-SDK/handwritten
 * client spec-divergence diagnosis CLI entry point (item 45).
 *
 * Mirrors `programmatic-tool-failure.ts`'s (item 43) `attribute`/`reduce`
 * split and `capability-drift.ts`'s (item 36) read-only, local-file
 * pattern. `diagnose` reads already-captured fixtures, runs, and optional
 * per-fixture evidence, and runs the same `diagnoseSpecDivergence` path a
 * live differential-replay harness would call. `reduce` additionally
 * reduces the fixture set to the minimal subset still witnessing the same
 * classified cause, via `reduceIncompatibilityWitnesses`.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type DivergenceEvidence,
	type FixtureRun,
	type ProtocolFixture,
	diagnoseSpecDivergence,
	reduceIncompatibilityWitnesses,
	renderSpecDivergenceReport,
} from "../diagnosis/spec-divergence.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function readInputs(opts: { fixtures: string; runs: string; evidence?: string }): {
	fixtures: ProtocolFixture[];
	runs: FixtureRun[];
	evidence: Record<string, DivergenceEvidence>;
} {
	const fixtures = readJson(opts.fixtures) as ProtocolFixture[];
	const runs = readJson(opts.runs) as FixtureRun[];
	const evidence = opts.evidence
		? (readJson(opts.evidence) as Record<string, DivergenceEvidence>)
		: {};
	return { fixtures, runs, evidence };
}

export function registerSpecDivergenceCommand(program: Command): void {
	const specDivergence = program
		.command("spec-divergence")
		.description(
			"Differentially compare generated and handwritten client responses against protocol fixtures and classify incompatibility causes",
		);

	specDivergence
		.command("diagnose")
		.description(
			"Diagnose spec divergence: classify each diverging fixture as transport_defect, spec_ambiguity, runtime_defect, generator_defect, or unattributed",
		)
		.requiredOption("--fixtures <path>", "Path to a JSON ProtocolFixture[] array")
		.requiredOption("--runs <path>", "Path to a JSON FixtureRun[] array")
		.option("--evidence <path>", "Path to a JSON Record<fixture_id, DivergenceEvidence> object")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let inputs: ReturnType<typeof readInputs>;
			try {
				inputs = readInputs(opts);
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = diagnoseSpecDivergence(inputs.fixtures, inputs.runs, inputs.evidence);

			if (opts.render) {
				process.stdout.write(renderSpecDivergenceReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});

	specDivergence
		.command("reduce")
		.description(
			"Reduce the fixture set to the minimal subset that still witnesses the same classified divergence cause",
		)
		.requiredOption("--fixtures <path>", "Path to a JSON ProtocolFixture[] array")
		.requiredOption("--runs <path>", "Path to a JSON FixtureRun[] array")
		.option("--evidence <path>", "Path to a JSON Record<fixture_id, DivergenceEvidence> object")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let inputs: ReturnType<typeof readInputs>;
			try {
				inputs = readInputs(opts);
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const result = await reduceIncompatibilityWitnesses(
				inputs.fixtures,
				inputs.runs,
				inputs.evidence,
			);
			outputResult(result as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
