import type { Command } from "commander";
import {
	type Observation,
	abandonHypothesis,
	buildHypothesisTree,
	recordObservation,
	summarize,
	validateTree,
} from "../diagnosis/hypothesis.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

function parseUnit(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseFloat(raw);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * `failsafe hypotheses` — hierarchical hypothesis validation (item 43).
 *
 * Makes the reasoning behind a localization inspectable and updatable: build a
 * `module → file → function → line` tree with a competing branch, record what a
 * probe actually showed, and drop a candidate only with a stated reason.
 */
export function registerHypothesesCommand(program: Command): void {
	const cmd = program
		.command("hypotheses")
		.description("Competing root-cause hypotheses, their probes, and posterior updates");

	cmd
		.command("build <failure-id>")
		.description("Build and persist the hypothesis tree for a failure")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.option("--force", "Rebuild even if a tree is already stored")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);

			const existing = store.getHypotheses(failure.failure_id);
			if (existing && !opts.force) {
				outputResult(
					{ status: "exists", ...summarize(existing), hypotheses: existing.hypotheses },
					outOpts,
				);
				store.close();
				return;
			}

			const diagnosis = store.getDiagnosis(failure.failure_id);
			const errors = failure.parsed.flatMap((p) => p.errors);
			const repro = store.getRepro(failure.failure_id);
			const tree = buildHypothesisTree({
				failure_id: failure.failure_id,
				primary_location: failure.primary_location,
				frames: errors.flatMap((e) => e.stack_frames ?? []),
				root_cause: diagnosis?.root_cause,
				test_name: errors.find((e) => e.test_name)?.test_name,
				command: repro?.command ?? failure.command,
			});

			const structural = validateTree(tree);
			if (tree.hypotheses.length === 0) {
				outputResult(
					{
						error: true,
						message:
							"No primary location for this failure, so no hypothesis can be localized. Run 'failsafe diagnose' first.",
					},
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			store.saveHypotheses(tree);
			outputResult(
				{
					status: "built",
					...summarize(tree),
					structural_errors: structural,
					hypotheses: tree.hypotheses,
				},
				outOpts,
			);
			store.close();
		});

	cmd
		.command("list <failure-id>")
		.description("Show the stored hypothesis tree and its validation summary")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);
			const tree = store.getHypotheses(failure.failure_id);
			if (!tree) {
				outputResult(
					{
						error: true,
						message: `No hypotheses stored for ${failure.failure_id}. Run 'failsafe hypotheses build ${failure.failure_id}'.`,
					},
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			outputResult({ ...summarize(tree), hypotheses: tree.hypotheses }, outOpts);
			store.close();
		});

	cmd
		.command("observe <failure-id> <hypothesis-id>")
		.description("Record what a probe showed and update posteriors")
		.requiredOption("--outcome <outcome>", "confirms | refutes | inconclusive")
		.requiredOption("--detail <text>", "What was actually observed")
		.option("--likelihood-if-true <p>", "P(observation | hypothesis true)", "0.9")
		.option("--likelihood-if-false <p>", "P(observation | hypothesis false)", "0.2")
		.option("--format <format>", "Output format: json or text")
		.action(async (rawId: string, hypothesisId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);
			const tree = store.getHypotheses(failure.failure_id);
			if (!tree) {
				outputResult(
					{ error: true, message: `No hypotheses stored for ${failure.failure_id}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			if (!tree.hypotheses.some((h) => h.id === hypothesisId)) {
				outputResult({ error: true, message: `Unknown hypothesis: ${hypothesisId}` }, outOpts);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			const outcome = opts.outcome as Observation["outcome"];
			if (outcome !== "confirms" && outcome !== "refutes" && outcome !== "inconclusive") {
				outputResult({ error: true, message: `Invalid --outcome: ${opts.outcome}` }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			const { tree: updated, transitions } = recordObservation(tree, hypothesisId, {
				detail: opts.detail,
				outcome,
				observed_at: new Date().toISOString(),
				likelihood_if_true: parseUnit(opts.likelihoodIfTrue, 0.9),
				likelihood_if_false: parseUnit(opts.likelihoodIfFalse, 0.2),
			});
			store.saveHypotheses(updated);
			outputResult(
				{ status: "observed", transitions, ...summarize(updated), hypotheses: updated.hypotheses },
				outOpts,
			);
			store.close();
		});

	cmd
		.command("abandon <failure-id> <hypothesis-id>")
		.description("Drop a hypothesis, recording why")
		.requiredOption("--reason <text>", "Why this hypothesis is being dropped")
		.option("--format <format>", "Output format: json or text")
		.action(async (rawId: string, hypothesisId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);
			const tree = store.getHypotheses(failure.failure_id);
			if (!tree) {
				outputResult(
					{ error: true, message: `No hypotheses stored for ${failure.failure_id}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			const updated = abandonHypothesis(tree, hypothesisId, opts.reason);
			store.saveHypotheses(updated);
			outputResult(
				{ status: "abandoned", ...summarize(updated), hypotheses: updated.hypotheses },
				outOpts,
			);
			store.close();
		});
}
