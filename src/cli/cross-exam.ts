/**
 * `failsafe cross-exam` — cross-examination diagnosis sessions (item 33).
 *
 * Mirrors `hypotheses.ts`'s own `plan`/`stop` commands: a failure's stored
 * hypothesis tree (`store.getHypotheses`) drives everything, and a
 * cross-examination session is persisted as a local JSON file the caller
 * passes to each subsequent subcommand with `--session <file>` — the same
 * read-then-write-back local-file pattern `bundle.ts`/`approval.ts` already
 * use for other multi-step, stateful CLI flows. This is the first CLI
 * entry point for `diagnosis/cross-examination.ts` ever wired to a command.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { CausalEvidence } from "../diagnosis/causal-construction.js";
import type { CausalNode } from "../diagnosis/causal-graph.js";
import {
	type CrossExamSpend,
	type CrossExaminationSession,
	challengeCausalClaim,
	crossExaminationVerdict,
	newCrossExaminationSession,
	recordCrossExamObservation,
	requestDiscriminatingEvidence,
} from "../diagnosis/cross-examination.js";
import type { Experiment } from "../diagnosis/experiments.js";
import type { Observation } from "../diagnosis/hypothesis.js";
import type { InvestigationState } from "../diagnosis/stopping.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function registerCrossExamCommand(program: Command): void {
	const cmd = program
		.command("cross-exam")
		.description(
			"Cross-examination diagnosis sessions: discriminating evidence, causal challenges, convergence or abstention under fixed budgets",
		);

	cmd
		.command("start <failure-id>")
		.description("Start a cross-examination session over this failure's stored hypotheses")
		.requiredOption("--session <file>", "Path to write the new session JSON")
		.requiredOption("--max-turns <n>", "Turn budget for this session")
		.requiredOption("--epsilon <n>", "Total differential-privacy epsilon budget")
		.requiredOption("--effects <n>", "Total effect budget")
		.option("--format <format>", "Output format: json or text")
		.action(async (rawId: string, opts) => {
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
			const session = newCrossExaminationSession(tree, {
				max_turns: Number.parseInt(opts.maxTurns, 10),
				epsilon_total: Number.parseFloat(opts.epsilon),
				effects_total: Number.parseFloat(opts.effects),
			});
			writeFileSync(opts.session, JSON.stringify(session, null, 2));
			outputResult(session as unknown as Record<string, unknown>, outOpts);
			store.close();
		});

	cmd
		.command("request-evidence")
		.description("Plan discriminating experiments against the session's current belief")
		.requiredOption("--session <file>", "Path to the session JSON")
		.requiredOption("--catalogue <file>", "Path to a JSON array of Experiment records")
		.option("--budget <n>", "Cost budget for the plan", "10")
		.option("--format <format>", "Output format: json or text")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);
			const session = readJson<CrossExaminationSession>(opts.session);
			const experiments = readJson<Experiment[]>(opts.catalogue);
			try {
				const plan = requestDiscriminatingEvidence(
					session,
					experiments,
					Number.parseFloat(opts.budget),
				);
				outputResult({ belief: plan.belief, ...plan.plan }, outOpts);
			} catch (err) {
				outputResult({ error: true, message: (err as Error).message }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}
			store.close();
		});

	cmd
		.command("observe <hypothesis-id>")
		.description(
			"Record an observation against one hypothesis, spending one turn and both the privacy and effect budgets",
		)
		.requiredOption("--session <file>", "Path to the session JSON")
		.requiredOption("--observation <file>", "Path to a JSON Observation record")
		.requiredOption("--epsilon <n>", "Epsilon to spend on this observation")
		.requiredOption("--effect <n>", "Effect units to spend on this observation")
		.option("--format <format>", "Output format: json or text")
		.action((hypothesisId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const session = readJson<CrossExaminationSession>(opts.session);
			const observation = readJson<Observation>(opts.observation);
			const spend: CrossExamSpend = {
				epsilon: Number.parseFloat(opts.epsilon),
				effect: Number.parseFloat(opts.effect),
			};
			const result = recordCrossExamObservation(session, hypothesisId, observation, spend);
			if (!result.ok) {
				outputResult({ error: true, message: result.reason }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}
			writeFileSync(opts.session, JSON.stringify(result.session, null, 2));
			outputResult(
				{ calibrated: result.calibrated, session: result.session } as unknown as Record<
					string,
					unknown
				>,
				outOpts,
			);
			store.close();
		});

	cmd
		.command("challenge")
		.description("Challenge an existing causal claim with new intervention evidence")
		.requiredOption("--nodes <file>", "Path to a JSON array of CausalNode")
		.requiredOption("--interventions <file>", "Path to a JSON array of InterventionFact")
		.option("--evidence <file>", "Path to additional JSON CausalEvidence (data_flow/dependencies)")
		.option("--format <format>", "Output format: json or text")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);
			const nodes = readJson<CausalNode[]>(opts.nodes);
			const interventions = readJson<CausalEvidence["interventions"]>(opts.interventions);
			const other = opts.evidence
				? readJson<Omit<CausalEvidence, "interventions">>(opts.evidence)
				: {};
			const result = challengeCausalClaim(nodes, interventions, other);
			outputResult(result as unknown as Record<string, unknown>, outOpts);
			store.close();
		});

	cmd
		.command("verdict")
		.description("Decide whether a cross-examination session should converge or abstain")
		.requiredOption("--session <file>", "Path to the session JSON")
		.requiredOption(
			"--state <file>",
			"Path to a partial JSON InvestigationState (remaining_actions, step_gains)",
		)
		.option("--format <format>", "Output format: json or text")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);
			const session = readJson<CrossExaminationSession>(opts.session);
			const partialState = readJson<Pick<InvestigationState, "remaining_actions" | "step_gains">>(
				opts.state,
			);
			const verdict = crossExaminationVerdict(session, partialState);
			outputResult(verdict as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
