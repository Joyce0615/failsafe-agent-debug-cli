/**
 * `failsafe canary trial`/`failsafe canary promote` — remediation canary
 * and rollback verification CLI entry points (item 29).
 *
 * Mirrors `orchestration.ts` (item 27): read-only, local-file, no live
 * replay harness reached over the network. The runner is file-driven —
 * a JSON array of recorded `{ outcome, metrics }` runs per arm, the exact
 * shape `CanaryRunner` needs — so this command runs the SAME
 * `runCanaryTrial` path a live sandbox/replay integration would call.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { ApprovalGrant, RemediationAction } from "../remediation/approval.js";
import {
	type CanaryReport,
	type CanaryRun,
	MIN_CANARY_REPEATS,
	type MetricTolerance,
	requestCanaryPromotion,
	runCanaryTrial,
} from "../remediation/canary.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerCanaryCommand(program: Command): void {
	const canary = program
		.command("canary")
		.description("Remediation canary trial and rollback verification");

	canary
		.command("trial")
		.description(
			"Compare baseline vs. canary pass rate and declared side-effect metrics, and emit a promote/hold/rollback verdict",
		)
		.requiredOption(
			"--runs <path>",
			'Path to a JSON object: { "baseline": CanaryRun[], "canary": CanaryRun[] }',
		)
		.option("--tolerances <path>", "Path to a JSON array of MetricTolerance records")
		.option("--repeats <n>", "Repetitions per arm", String(MIN_CANARY_REPEATS))
		.option("--out <file>", "Write the report here instead of stdout")
		.option("--format <format>", "Output format: json or text")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let runs: { baseline: CanaryRun[]; canary: CanaryRun[] };
			let tolerances: MetricTolerance[] = [];
			try {
				runs = readJson(opts.runs as string) as { baseline: CanaryRun[]; canary: CanaryRun[] };
				if (opts.tolerances) {
					tolerances = readJson(opts.tolerances as string) as MetricTolerance[];
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const repeats = Number.parseInt(opts.repeats as string, 10);
			const runner = (arm: "baseline" | "canary", attempt: number): CanaryRun => {
				const list = runs[arm] ?? [];
				return list[attempt - 1] ?? { outcome: "error" };
			};

			const report = await runCanaryTrial(runner, tolerances, repeats);

			if (opts.out) {
				writeFileSync(opts.out as string, `${JSON.stringify(report, null, 2)}\n`);
				outputResult({ status: "written", file: opts.out, verdict: report.verdict }, outOpts);
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});

	canary
		.command("promote")
		.description(
			"Request promotion of a trialed fix. Refused unless the trial's own verdict is 'promote' AND the item-77 approval gate allows it",
		)
		.requiredOption("--report <path>", "Path to a JSON CanaryReport produced by 'canary trial'")
		.requiredOption("--action <path>", "Path to a JSON RemediationAction")
		.option("--grant <path>", "Path to a JSON ApprovalGrant")
		.option("--format <format>", "Output format: json or text")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let report: CanaryReport;
			let action: RemediationAction;
			let grant: ApprovalGrant | undefined;
			try {
				report = readJson(opts.report as string) as CanaryReport;
				action = readJson(opts.action as string) as RemediationAction;
				if (opts.grant) {
					grant = readJson(opts.grant as string) as ApprovalGrant;
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const result = requestCanaryPromotion(report, action, grant);
			outputResult(result as unknown as Record<string, unknown>, outOpts);
			if (!result.ok) {
				store.close();
				process.exit(ExitCode.ERROR);
			}
			store.close();
		});
}
