/**
 * `failsafe programmatic-tool attribute|reduce` — programmatic tool-calling
 * failure attribution and capability-preserving reduction CLI entry point
 * (item 43).
 *
 * Mirrors `capability-drift.ts` (item 36) and `orchestration.ts` (item 27):
 * read-only, local-file commands. `attribute` reads an already-captured
 * evidence JSON object and runs the same `attributeProgrammaticFailure` path
 * a live programmatic-tool-calling harness would call. `reduce` reads a
 * trace-element list plus a file-driven outcome table (the same "map a
 * missing element id to the outcome replay produces without it" shape
 * `orchestration.ts`'s `runnerFromOutcomes` already established, extended
 * with the `capabilities_used` field this item's reduction gate needs) and
 * runs `reduceProgrammaticProgram`.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type ProgramOracleResult,
	type ProgramReductionOracle,
	type ProgrammaticRunEvidence,
	attributeProgrammaticFailure,
	reduceProgrammaticProgram,
	renderProgrammaticFailureAttribution,
} from "../diagnosis/programmatic-tool-failure.js";
import type { TraceElement } from "../repro/trace-reduction.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Builds a `ProgramReductionOracle` from a file-driven outcome table: the
 * full element set reproduces with `baseline`, and removing any element
 * named as a key in `byMissingElement` reports that key's own outcome.
 */
function oracleFromOutcomes(
	elements: TraceElement[],
	baseline: ProgramOracleResult,
	byMissingElement: Record<string, ProgramOracleResult>,
): ProgramReductionOracle {
	return (ids) => {
		const present = new Set(ids);
		const missing = elements.map((e) => e.id).find((id) => !present.has(id));
		if (missing === undefined) return baseline;
		return byMissingElement[missing] ?? { reproduces: false };
	};
}

export function registerProgrammaticToolFailureCommand(program: Command): void {
	const programmaticTool = program
		.command("programmatic-tool")
		.description(
			"Attribute programmatic tool-calling failures and reduce failing orchestration programs without expanding capabilities",
		);

	programmaticTool
		.command("attribute")
		.description(
			"Attribute a programmatic tool-calling failure to environment, generated_code, proxy, schema, sandbox, tool, or cancellation",
		)
		.requiredOption("--evidence <path>", "Path to a JSON ProgrammaticRunEvidence object")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let evidence: ProgrammaticRunEvidence;
			try {
				evidence = readJson(opts.evidence as string) as ProgrammaticRunEvidence;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const attribution = attributeProgrammaticFailure(evidence);

			if (opts.render) {
				process.stdout.write(renderProgrammaticFailureAttribution(attribution));
			} else {
				outputResult(attribution as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});

	programmaticTool
		.command("reduce")
		.description(
			"Reduce a failing programmatic-tool-calling run's trace elements while rejecting any candidate that exercises a capability the original run did not",
		)
		.requiredOption("--elements <path>", "Path to a JSON TraceElement[] array")
		.requiredOption(
			"--outcomes <path>",
			'Path to a JSON object: { "baseline": ProgramOracleResult, "by_missing_element": Record<string, ProgramOracleResult> }',
		)
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let elements: TraceElement[];
			let outcomes: {
				baseline: ProgramOracleResult;
				by_missing_element: Record<string, ProgramOracleResult>;
			};
			try {
				elements = readJson(opts.elements as string) as TraceElement[];
				outcomes = readJson(opts.outcomes as string) as typeof outcomes;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const oracle = oracleFromOutcomes(elements, outcomes.baseline, outcomes.by_missing_element);
			const result = await reduceProgrammaticProgram(elements, oracle);
			outputResult(result as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
