/**
 * `failsafe orchestration localize` — orchestration-plan fault localization
 * CLI entry point (item 27).
 *
 * Mirrors `trace.ts` (item 21) and `incidents.ts` (item 22): a read-only,
 * local-file command. Rather than reaching out to a live replay harness over
 * a network, this command reads an already-recorded, layer-tagged trace plus
 * a simulated-counterfactual outcome table (the exact shape
 * `diagnosis/orchestration-fault.ts`'s `ReplayRunner` needs) and optionally a
 * JSON array of healthy `Trajectory` baselines, then runs the SAME
 * `localizeOrchestrationFault` path a live replay-harness integration would
 * call.
 *
 * The outcome table is a JSON object mapping an ablated event id to the
 * outcome ("failed" | "passed" | "error") that replay produces with exactly
 * that event removed — the deterministic seam `ReplayRunner` already defines,
 * made file-driven for a caller with no live harness.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { ReplayOutcome, ReplayRunner } from "../diagnosis/fault-localization.js";
import {
	type OrchestrationEvent,
	localizeOrchestrationFault,
} from "../diagnosis/orchestration-fault.js";
import type { Trajectory } from "../diagnosis/trajectory-diff.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function runnerFromOutcomes(
	baseline: ReplayOutcome,
	byEvent: Record<string, ReplayOutcome>,
): ReplayRunner {
	return (replayed) => {
		const ids = new Set(replayed.map((e) => e.id));
		const missing = Object.keys(byEvent).find((id) => !ids.has(id));
		if (missing === undefined) return baseline;
		return byEvent[missing] ?? "error";
	};
}

export function registerOrchestrationCommand(program: Command): void {
	const orchestration = program
		.command("orchestration")
		.description(
			"Orchestration-plan fault localization: planner vs worker/tool/transport/environment",
		);

	orchestration
		.command("localize")
		.description(
			"Localize a failing orchestration run to planner/worker/tool/transport/environment, by combining a counterfactual ablation sweep with an optional trajectory-baseline diff",
		)
		.requiredOption(
			"--events <path>",
			"Path to a JSON array of layer-tagged OrchestrationEvent records",
		)
		.requiredOption(
			"--outcomes <path>",
			'Path to a JSON object: { "baseline": ReplayOutcome, "by_event": { eventId: ReplayOutcome } }',
		)
		.option("--healthy <path>", "Path to a JSON array of healthy Trajectory baselines")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let events: OrchestrationEvent[];
			let outcomes: { baseline: ReplayOutcome; by_event: Record<string, ReplayOutcome> };
			let healthy: Trajectory[] = [];
			try {
				events = readJson(opts.events as string) as OrchestrationEvent[];
				outcomes = readJson(opts.outcomes as string) as {
					baseline: ReplayOutcome;
					by_event: Record<string, ReplayOutcome>;
				};
				if (opts.healthy) {
					healthy = readJson(opts.healthy as string) as Trajectory[];
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const runner = runnerFromOutcomes(outcomes.baseline, outcomes.by_event ?? {});
			const report = await localizeOrchestrationFault(events, runner, healthy);

			outputResult(report, outOpts);
			store.close();
		});
}
