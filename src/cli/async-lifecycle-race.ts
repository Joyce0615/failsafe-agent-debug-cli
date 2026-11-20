/**
 * `failsafe async-lifecycle-race diagnose|schedule` — asynchronous Task
 * lifecycle race diagnosis CLI entry point (item 47).
 *
 * Mirrors `authorization-drift.ts`'s (item 44) and `spec-divergence.ts`'s
 * (item 45) read-only, local-JSON-file pattern. A caller supplies the raw,
 * already-captured timestamped events (for `timeline.ts`'s
 * `normalizeTimeline`, item 47's own clock-skew machinery), the causal
 * links between them (for `partial-order.ts`'s `reconstructPartialOrder`,
 * item 8), and the Task-lifecycle labeling of a subset of those same event
 * ids (kind/task_id/effect_applied) that `async-lifecycle-race.ts` reads.
 * This command composes all three UNMODIFIED, exactly the pipeline a live
 * orchestration integration would run.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type LifecycleEvent,
	diagnoseAsyncLifecycleRaces,
	reconstructTaskSchedule,
	renderAsyncLifecycleRaceReport,
} from "../diagnosis/async-lifecycle-race.js";
import { type CausalLink, reconstructPartialOrder } from "../diagnosis/partial-order.js";
import { type RawEvent, normalizeTimeline } from "../diagnosis/timeline.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function readInputs(opts: { events: string; lifecycle: string; links?: string }): {
	events: RawEvent[];
	lifecycle: LifecycleEvent[];
	links: CausalLink[];
} {
	const events = readJson(opts.events) as RawEvent[];
	const lifecycle = readJson(opts.lifecycle) as LifecycleEvent[];
	const links = opts.links ? (readJson(opts.links) as CausalLink[]) : [];
	return { events, lifecycle, links };
}

export function registerAsyncLifecycleRaceCommand(program: Command): void {
	const asyncLifecycleRace = program
		.command("async-lifecycle-race")
		.description(
			"Diagnose asynchronous Task lifecycle races across retries, webhooks, subscriptions, expiry, and cancellation",
		);

	asyncLifecycleRace
		.command("diagnose")
		.description(
			"Diagnose duplicate-delivery and boundary races: retry/webhook/subscription duplication and cancellation/expiry races against a task's own effect",
		)
		.requiredOption("--events <path>", "Path to a JSON RawEvent[] array (timeline.ts)")
		.requiredOption(
			"--lifecycle <path>",
			"Path to a JSON LifecycleEvent[] array labeling a subset of --events' ids with task_id/kind/effect_applied",
		)
		.option("--links <path>", "Path to a JSON CausalLink[] array (partial-order.ts)")
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

			const timeline = normalizeTimeline(inputs.events);
			const order = reconstructPartialOrder(timeline.events, inputs.links);
			const report = diagnoseAsyncLifecycleRaces(inputs.lifecycle, order);

			if (opts.render) {
				process.stdout.write(renderAsyncLifecycleRaceReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});

	asyncLifecycleRace
		.command("schedule")
		.description(
			"Reconstruct one deterministic linear schedule for a single task's lifecycle events, naming every tie it had to break arbitrarily",
		)
		.requiredOption("--events <path>", "Path to a JSON RawEvent[] array (timeline.ts)")
		.requiredOption(
			"--lifecycle <path>",
			"Path to a JSON LifecycleEvent[] array labeling a subset of --events' ids with task_id/kind/effect_applied",
		)
		.option("--links <path>", "Path to a JSON CausalLink[] array (partial-order.ts)")
		.requiredOption("--task <task_id>", "Which task_id's events to schedule")
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

			const taskEvents = inputs.lifecycle.filter((e) => e.task_id === opts.task);
			if (taskEvents.length === 0) {
				outputResult(
					{ error: true, message: `No lifecycle events found for task_id '${opts.task}'` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const timeline = normalizeTimeline(inputs.events);
			const order = reconstructPartialOrder(timeline.events, inputs.links);
			const schedule = reconstructTaskSchedule(taskEvents, order);
			outputResult(schedule as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
