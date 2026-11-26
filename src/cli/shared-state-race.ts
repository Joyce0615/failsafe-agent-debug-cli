/**
 * `failsafe shared-state-race diagnose` — shared-state read/write race
 * reconstruction CLI entry point (item 53).
 *
 * Mirrors `async-lifecycle-race.ts`'s (item 47) composition pipeline: a
 * caller supplies the raw, already-captured timestamped events (for
 * `timeline.ts`'s `normalizeTimeline`), the causal links between them
 * (for `partial-order.ts`'s `reconstructPartialOrder`, item 8), and the
 * versioned read/write labeling of a subset of those same event ids
 * (`ResourceOperation`'s resource_id/kind/version/based_on_version) that
 * `shared-state-race.ts` reads. This command composes all three
 * UNMODIFIED, exactly the pipeline a live file/artifact/resource
 * integration would run.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { type CausalLink, reconstructPartialOrder } from "../diagnosis/partial-order.js";
import {
	type ResourceOperation,
	diagnoseSharedStateRaces,
	renderSharedStateRaceReport,
} from "../diagnosis/shared-state-race.js";
import { type RawEvent, normalizeTimeline } from "../diagnosis/timeline.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function readInputs(opts: { events: string; operations: string; links?: string }): {
	events: RawEvent[];
	operations: ResourceOperation[];
	links: CausalLink[];
} {
	const events = readJson(opts.events) as RawEvent[];
	const operations = readJson(opts.operations) as ResourceOperation[];
	const links = opts.links ? (readJson(opts.links) as CausalLink[]) : [];
	return { events, operations, links };
}

export function registerSharedStateRaceCommand(program: Command): void {
	const sharedStateRace = program
		.command("shared-state-race")
		.description(
			"Reconstruct shared-state read/write races: stale reads, lost updates, write skew, and structural races",
		);

	sharedStateRace
		.command("diagnose")
		.description(
			"Diagnose stale_read, lost_update, write_skew, and structural_race findings, abstaining on pairs whose relative order is genuinely undetermined",
		)
		.requiredOption("--events <path>", "Path to a JSON RawEvent[] array (timeline.ts)")
		.requiredOption(
			"--operations <path>",
			"Path to a JSON ResourceOperation[] array labeling a subset of --events' ids with resource_id/kind/version/based_on_version",
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
				return;
			}

			const timeline = normalizeTimeline(inputs.events);
			const order = reconstructPartialOrder(timeline.events, inputs.links);
			const report = diagnoseSharedStateRaces(inputs.operations, order);

			if (opts.render) {
				process.stdout.write(renderSharedStateRaceReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
