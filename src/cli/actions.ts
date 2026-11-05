/**
 * `failsafe actions validate`/`failsafe actions grade` — process-oriented
 * agent action log CLI entry points (item 31).
 *
 * Mirrors `orchestration.ts` (item 27) and `drift.ts` (item 30): read-only,
 * local-file. Reads an already-recorded JSONL action log (the exact shape
 * `ActionRecorder.actions()`/`toJsonl` produce) and runs the SAME
 * `validateActionLog`/`gradeActionLog` path a live MCP/A2A/tool/file/process
 * recorder integration would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type ActionRecord,
	fromJsonl,
	gradeActionLog,
	validateActionLog,
} from "../debug/action-log.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

export function registerActionsCommand(program: Command): void {
	const actions = program
		.command("actions")
		.description("Process-oriented agent action log validation and grading");

	actions
		.command("validate <log-file>")
		.description("Check causal_id integrity of a recorded action log (JSONL)")
		.option("--format <format>", "Output format: json or text")
		.action((logFile: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			let records: ActionRecord[];
			try {
				records = fromJsonl(readFileSync(logFile, "utf-8"));
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read action log: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			const result = validateActionLog(records);
			outputResult(result as unknown as Record<string, unknown>, outOpts);
			store.close();
			if (!result.valid) process.exit(ExitCode.ERROR);
		});

	actions
		.command("grade <log-file>")
		.description(
			"Deterministically grade a recorded action log's evidence completeness so diagnosis can grade how a result was produced",
		)
		.option("--format <format>", "Output format: json or text")
		.action((logFile: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			let records: ActionRecord[];
			try {
				records = fromJsonl(readFileSync(logFile, "utf-8"));
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read action log: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			const report = gradeActionLog(records);
			outputResult(report as unknown as Record<string, unknown>, outOpts);
			store.close();
		});
}
