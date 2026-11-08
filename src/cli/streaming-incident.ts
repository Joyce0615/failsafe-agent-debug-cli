/**
 * `failsafe stream` — streaming incident diagnosis session CLI entry points
 * (item 35).
 *
 * Mirrors `cross-exam.ts` (item 33): a failure's stored hypothesis tree
 * (`store.getHypotheses`) seeds the session, and the session itself is
 * persisted as a local JSON file the caller passes to each subsequent
 * subcommand with `--session <file>` — the same read-then-write-back
 * local-file pattern.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type AlertChurnBudget,
	type StreamEvent,
	type StreamingSession,
	ingestLiveEvent,
	newStreamingSession,
	streamingSnapshot,
} from "../diagnosis/streaming-incident.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function registerStreamingIncidentCommand(program: Command): void {
	const cmd = program
		.command("stream")
		.description(
			"Streaming incident diagnosis: update partial-order hypotheses as live events arrive, retract superseded conclusions, bound alert churn, and preserve a reproducible final snapshot",
		);

	cmd
		.command("start <failure-id>")
		.description("Start a streaming diagnosis session over this failure's stored hypotheses")
		.requiredOption("--session <file>", "Path to write the new session JSON")
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
			const session = newStreamingSession(failure.failure_id, tree);
			writeFileSync(opts.session, JSON.stringify(session, null, 2));
			outputResult(session as unknown as Record<string, unknown>, outOpts);
			store.close();
		});

	cmd
		.command("ingest")
		.description(
			"Fold one live event into the session: update hypotheses, recompute the partial order, and emit/retract/suppress alerts under the churn budget",
		)
		.requiredOption("--session <file>", "Path to the session JSON")
		.requiredOption("--event <file>", "Path to a JSON StreamEvent")
		.option("--max-alerts <n>", "Alert churn budget: maximum alerts ever emitted", "5")
		.option("--cooldown-events <n>", "Alert churn budget: minimum events between alerts", "1")
		.option("--format <format>", "Output format: json or text")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);
			const session = readJson<StreamingSession>(opts.session);
			const event = readJson<StreamEvent>(opts.event);
			const budget: AlertChurnBudget = {
				max_alerts: Number.parseInt(opts.maxAlerts, 10),
				cooldown_events: Number.parseInt(opts.cooldownEvents, 10),
			};
			const next = ingestLiveEvent(session, event, budget);
			writeFileSync(opts.session, JSON.stringify(next, null, 2));
			outputResult(next as unknown as Record<string, unknown>, outOpts);
			store.close();
		});

	cmd
		.command("snapshot")
		.description("Produce a reproducible final snapshot of the session's accumulated state")
		.requiredOption("--session <file>", "Path to the session JSON")
		.option("--format <format>", "Output format: json or text")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);
			const session = readJson<StreamingSession>(opts.session);
			const snapshot = streamingSnapshot(session);
			outputResult(snapshot as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
