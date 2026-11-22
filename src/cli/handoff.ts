/**
 * `failsafe handoff receive` — causal-continuity-across-handoffs CLI entry
 * point (item 49).
 *
 * Mirrors `adjudication.ts` (item 39) and `canary.ts` (item 29): read-only,
 * local-file, no network. Reads a JSON `HandoffPackage` built by a
 * sender and a receiver's declared options, then runs the SAME
 * `receiveHandoff` path a live agent/operator handoff integration would
 * call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type HandoffPackage,
	type ReceiveHandoffOptions,
	receiveHandoff,
	renderHandoffReceipt,
} from "../diagnosis/handoff-continuity.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerHandoffCommand(program: Command): void {
	const handoff = program
		.command("handoff")
		.description(
			"Preserve incident hypotheses, rejected causes, evidence budgets, privacy decisions, ownership, and recovery state across agent/operator handoffs",
		);

	handoff
		.command("receive")
		.description(
			"Receive a HandoffPackage, cap stale-confidence inheritance, and refuse any continuity violation (revived rejected cause, loosened privacy, unchanged ownership, or rewound recovery state)",
		)
		.requiredOption("--package <path>", "Path to a JSON HandoffPackage")
		.requiredOption("--now <ms>", "Current time in ms since epoch")
		.requiredOption("--staleness-threshold <ms>", "Staleness threshold in ms")
		.option(
			"--new-hypotheses <path>",
			"Path to a JSON array of candidate hypotheses the receiver proposes",
		)
		.option(
			"--declared-privacy-floor <path>",
			"Path to a JSON object: Partial<Record<DataClass, CaptureAction>> the receiver declares",
		)
		.option("--declared-recovery-phase <phase>", "The receiver's own recovery-phase claim")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let pkg: HandoffPackage;
			const receiveOpts: ReceiveHandoffOptions = {
				now_ms: Number(opts.now),
				staleness_threshold_ms: Number(opts.stalenessThreshold),
			};
			try {
				pkg = readJson(opts.package as string) as HandoffPackage;
				if (opts.newHypotheses) {
					receiveOpts.new_hypotheses = readJson(
						opts.newHypotheses as string,
					) as ReceiveHandoffOptions["new_hypotheses"];
				}
				if (opts.declaredPrivacyFloor) {
					receiveOpts.declared_privacy_floor = readJson(
						opts.declaredPrivacyFloor as string,
					) as ReceiveHandoffOptions["declared_privacy_floor"];
				}
				if (opts.declaredRecoveryPhase) {
					receiveOpts.declared_recovery_phase =
						opts.declaredRecoveryPhase as ReceiveHandoffOptions["declared_recovery_phase"];
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const result = receiveHandoff(pkg, receiveOpts);

			if (opts.render) {
				process.stdout.write(renderHandoffReceipt(result));
			} else {
				outputResult(result as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
