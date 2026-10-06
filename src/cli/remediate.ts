/**
 * `failsafe remediate <failure-id>` — the durable Detect->Attribute->
 * Recover->Rerun state machine (item 96).
 *
 * Unlike `failsafe autofix` (item 35), every phase transition is persisted
 * before and after the side-effecting work for that phase, so a crash never
 * loses track of what was already attempted and never silently re-applies a
 * non-idempotent recovery side effect. Use `--resume` to continue the latest
 * open run for a failure left `in_progress` by an interrupted process,
 * instead of starting a fresh one.
 */
import type { Command } from "commander";
import { resumeDurableRemediation, startDurableRemediation } from "../remediation/durable-loop.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

export function registerRemediateCommand(program: Command): void {
	program
		.command("remediate <failure-id>")
		.description(
			"Durable Detect->Attribute->Recover->Rerun state machine; crash-safe, resumable with --resume",
		)
		.option("--max-attempts <n>", "Maximum fix/verify attempts", "2")
		.option("--timeout <seconds>", "Per-command timeout in seconds", "120")
		.option(
			"--resume",
			"Resume the latest in-progress run for this failure instead of starting one",
		)
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

			const timeoutMs = Number.parseInt(opts.timeout, 10) * 1000;
			const maxAttempts = Number.parseInt(opts.maxAttempts, 10);

			const result = opts.resume
				? await resumeDurableRemediation(rawId, store, config, { timeoutMs })
				: await (async () => {
						const { failure } = resolveFailureOrExit(rawId, store, outOpts);
						return startDurableRemediation(failure, store, config, { maxAttempts, timeoutMs });
					})();

			if (opts.resume && result === null) {
				outputResult(
					{
						error: true,
						exit_code: ExitCode.NO_INPUT,
						message: `No in-progress remediation run found for ${rawId}. Start one without --resume.`,
					},
					outOpts,
					() => `[REMEDIATE] ${rawId}: NO OPEN RUN TO RESUME`,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			if (!result) {
				store.close();
				return;
			}

			outputResult(result.run, outOpts, () => {
				const r = result.run;
				const lines = [`[REMEDIATE] ${r.failure_id}: ${r.status.toUpperCase()} (run ${r.run_id})`];
				if (r.message) lines.push(`  ${r.message}`);
				for (const a of r.attempts) {
					lines.push(
						`  attempt ${a.attempt} (${a.fix_source}) -> ${a.effects.length} effect(s), re-run: ${a.rerun_status}`,
					);
				}
				return lines.join("\n");
			});

			store.close();
			if (result.exit_code !== ExitCode.OK) process.exit(result.exit_code);
		});
}
