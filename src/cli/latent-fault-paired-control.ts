/**
 * `failsafe latent-fault diagnose` — paired-control latent fault
 * diagnosis CLI entry point (item 56).
 *
 * Mirrors `mrtr.ts`'s (item 51) and `shared-state-race.ts`'s (item 53)
 * read-only, local-JSON-file pattern. A caller supplies one already-
 * captured failing `PairedControlTrajectory` and exactly one paired
 * no-fault reference trajectory of the SAME task; this command runs
 * the SAME `diagnoseLatentFaults` path a live comparison would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type PairedControlTrajectory,
	diagnoseLatentFaults,
	renderLatentFaultReport,
} from "../diagnosis/latent-fault-paired-control.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerLatentFaultCommand(program: Command): void {
	const latentFault = program
		.command("latent-fault")
		.description(
			"Diagnose latent faults with a paired no-fault control: semantic corruption, guardrail bypass, and ambiguous delegation invisible in surface telemetry",
		);

	latentFault
		.command("diagnose")
		.description(
			"Align a failing trajectory against exactly one paired no-fault control trajectory",
		)
		.requiredOption("--failing <path>", "Path to the failing PairedControlTrajectory JSON")
		.requiredOption(
			"--control <path>",
			"Path to the paired no-fault control PairedControlTrajectory JSON",
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let failing: PairedControlTrajectory;
			let control: PairedControlTrajectory;
			try {
				failing = readJson(opts.failing as string) as PairedControlTrajectory;
				control = readJson(opts.control as string) as PairedControlTrajectory;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const report = diagnoseLatentFaults(failing, control);

			if (opts.render) {
				process.stdout.write(renderLatentFaultReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
