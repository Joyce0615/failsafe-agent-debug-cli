/**
 * `failsafe trusted-state-contamination diagnose` — forensic
 * trusted-state contamination detection CLI entry point (item 55).
 *
 * Mirrors `mrtr.ts`'s (item 51) and `oauth-misbinding.ts`'s (item 54)
 * read-only, local-JSON-file pattern. A caller supplies already-captured
 * `RepairAttempt[]` records plus two optional reference id lists
 * (independently pre-trusted checkpoints, and checkpoints the trajectory
 * had already recorded earlier); this command runs the SAME
 * `diagnoseRepairAttempts` path a live time-travel/recovery-packet
 * integration would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type RepairAttempt,
	diagnoseRepairAttempts,
	renderContaminationReport,
} from "../diagnosis/trusted-state-contamination.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function readIdSet(path: string | undefined): Set<string> {
	if (!path) return new Set();
	return new Set(readJson(path) as string[]);
}

export function registerTrustedStateContaminationCommand(program: Command): void {
	const contamination = program
		.command("trusted-state-contamination")
		.description(
			"Forensically detect trusted-state contamination: distinguish genuine containment from recovery that merely injects an oracle or already-trusted snapshot",
		);

	contamination
		.command("diagnose")
		.description(
			"Classify every repair attempt in trajectory order and name the first contaminated one",
		)
		.requiredOption("--attempts <path>", "Path to a JSON RepairAttempt[] array")
		.option(
			"--trusted-checkpoints <path>",
			"Path to a JSON string[] of checkpoint ids trusted independently of these repair attempts",
		)
		.option(
			"--prior-checkpoints <path>",
			"Path to a JSON string[] of checkpoint ids this trajectory already recorded before these repair attempts",
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let attempts: RepairAttempt[];
			let trusted: Set<string>;
			let prior: Set<string>;
			try {
				attempts = readJson(opts.attempts as string) as RepairAttempt[];
				trusted = readIdSet(opts.trustedCheckpoints as string | undefined);
				prior = readIdSet(opts.priorCheckpoints as string | undefined);
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const report = diagnoseRepairAttempts(attempts, trusted, prior);

			if (opts.render) {
				process.stdout.write(renderContaminationReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
