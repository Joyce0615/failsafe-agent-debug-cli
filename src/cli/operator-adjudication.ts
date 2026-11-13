/**
 * `failsafe adjudication` — operator-adjudication calibration CLI entry
 * point (item 39).
 *
 * Mirrors `replay-validation.ts` (item 38), `advisories.ts` (item 37), and
 * `capability-drift.ts` (item 36): read-only, local-file. Reads a JSON array
 * of recorded `OperatorAdjudication` rows and runs the SAME
 * `buildCalibrationSetFromAdjudications`/`classDrift` path a live
 * adjudication store would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { calibrationReport } from "../diagnosis/calibration.js";
import {
	type OperatorAdjudication,
	type PolicyApprovalGrant,
	type PolicyChangeRequest,
	buildCalibrationSetFromAdjudications,
	classDrift,
	gateePolicyChange,
} from "../diagnosis/operator-adjudication.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerOperatorAdjudicationCommand(program: Command): void {
	const adjudication = program
		.command("adjudication")
		.description("Calibrate diagnoses from blinded operator adjudication");

	adjudication
		.command("calibrate")
		.description(
			"Build a calibration report from recorded operator adjudications, and detect accept-rate drift between a baseline and a recent batch",
		)
		.requiredOption(
			"--baseline <path>",
			"Path to a JSON array of baseline OperatorAdjudication rows",
		)
		.requiredOption("--recent <path>", "Path to a JSON array of recent OperatorAdjudication rows")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let baseline: OperatorAdjudication[];
			let recent: OperatorAdjudication[];
			try {
				baseline = readJson(opts.baseline as string) as OperatorAdjudication[];
				recent = readJson(opts.recent as string) as OperatorAdjudication[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const drift = classDrift(baseline, recent);
			const calibration = calibrationReport(
				buildCalibrationSetFromAdjudications([...baseline, ...recent]),
			);

			outputResult({ drift, calibration } as unknown as Record<string, unknown>, outOpts);
			store.close();
		});

	adjudication
		.command("gate")
		.description(
			"Check whether a learned-ranking or stopping-policy change may proceed, given an approval grant",
		)
		.requiredOption("--request <path>", "Path to a JSON PolicyChangeRequest object")
		.option("--grant <path>", "Path to a JSON PolicyApprovalGrant object")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let request: PolicyChangeRequest;
			let grant: PolicyApprovalGrant | undefined;
			try {
				request = readJson(opts.request as string) as PolicyChangeRequest;
				grant = opts.grant ? (readJson(opts.grant as string) as PolicyApprovalGrant) : undefined;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const decision = gateePolicyChange(request, grant);
			outputResult(decision as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
