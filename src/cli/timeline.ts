import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { ClockAnchor, RawEvent } from "../diagnosis/timeline.js";
import { rankTimelineCauses } from "../diagnosis/timeline.js";
import type { FailureRecord } from "../types/failure.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

/**
 * Seed a timeline from what the store already knows about a failure.
 *
 * The run's own clock is the reference: it is the one Failsafe stamped itself
 * and therefore the only one whose skew is zero by definition.
 */
function eventsFromFailure(failure: FailureRecord): RawEvent[] {
	const startedAt = Date.parse(failure.created_at);
	const start = Number.isFinite(startedAt) ? startedAt : 0;
	const duration = failure.duration_ms ?? 0;
	const events: RawEvent[] = [
		{
			id: "run:start",
			source: "output",
			clock: "failsafe",
			ts_ms: start,
			label: `run started: ${failure.command}`,
		},
	];

	let i = 0;
	for (const parsed of failure.parsed) {
		for (const error of parsed.errors) {
			events.push({
				id: `error:${i++}`,
				source: error.test_name ? "test" : "output",
				clock: "failsafe",
				// The parser cannot recover per-error timestamps, so every error is
				// placed at the run's end with the run's duration as its
				// uncertainty. Pretending to a millisecond here is exactly the kind
				// of false precision this module exists to avoid.
				ts_ms: start + duration,
				precision_ms: Math.max(1, duration),
				label: error.test_name ? `${error.test_name}: ${error.message}` : error.message,
				failed: true,
				...(error.location?.file ? { component: error.location.file } : {}),
			});
		}
	}
	return events;
}

type EventsFile = { events?: RawEvent[]; anchors?: ClockAnchor[] };

/**
 * `failsafe timeline <failure-id>` — clock-aware cross-artifact causal
 * timeline (item 47).
 */
export function registerTimelineCommand(program: Command): void {
	program
		.command("timeline <failure-id>")
		.description("Normalize cross-artifact events into a clock-aware causal timeline")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON")
		.option("--events <file>", "JSON {events:[], anchors:[]} of trace/config/diff artifacts")
		.option("--reference <clock>", "Clock all stamps are normalized into", "failsafe")
		.option("--dedupe-window <ms>", "Window within which identical labels are one event")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);

			let external: EventsFile = {};
			if (opts.events) {
				try {
					external = JSON.parse(readFileSync(opts.events as string, "utf-8")) as EventsFile;
				} catch (err) {
					outputResult(
						{ error: true, message: `Failed to read events: ${(err as Error).message}` },
						outOpts,
					);
					store.close();
					process.exit(ExitCode.NO_INPUT);
				}
			}

			const events = [...eventsFromFailure(failure), ...(external.events ?? [])];
			const window = opts.dedupeWindow
				? Number.parseInt(opts.dedupeWindow as string, 10)
				: undefined;
			const result = rankTimelineCauses(events, {
				reference: opts.reference as string,
				anchors: external.anchors ?? [],
				...(window !== undefined && Number.isFinite(window) ? { dedupe_window_ms: window } : {}),
			});

			outputResult(
				{
					failure_id: failure.failure_id,
					events: result.timeline.events,
					clocks: result.timeline.clocks,
					duplicates_collapsed: result.timeline.duplicates_collapsed,
					redacted_events: result.timeline.redacted_events,
					concurrency_groups: result.timeline.concurrency_groups,
					edges: result.edges,
					root_causes: result.ranking.root_causes,
					uncertainty: result.ranking.uncertainty,
				},
				outOpts,
			);
			store.close();
		});
}
