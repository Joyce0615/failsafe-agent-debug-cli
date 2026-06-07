import type { Command } from "commander";
import { analyzeCommand } from "../core/operations.js";
import type { FailureRecord } from "../types/failure.js";
import { formatFailureText } from "../utils/format.js";
import { computeTokenBudget } from "../utils/tokens.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { createStore, loadConfig } from "./shared.js";

export function registerRunCommand(program: Command): void {
	program
		.command("run <command>")
		.description("Run a command, capture output, and store a failure record")
		.option("--format <format>", "Output format: json or text")
		.option("--timeout <seconds>", "Command timeout in seconds", "120")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--raw", "Include raw output in response")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.option("--shell", "Run via 'sh -c' to allow shell syntax (operators, globs, pipes)")
		.option("--no-policy", "Skip command safety policy check")
		.action(async (command: string, opts) => {
			const config = loadConfig();
			const maxBytes = opts.maxBytes ? Number.parseInt(opts.maxBytes, 10) : undefined;
			const outOpts = resolveOutputOptions(
				{ ...opts, maxBytes },
				config.default_format,
				config.token_budget.max_output_bytes,
			);

			const store = createStore(config);
			const timeoutMs = Number.parseInt(opts.timeout, 10) * 1000;

			// Shared core: policy check, argv-vs-shell decision, capture, parse, store.
			const result = await analyzeCommand(command, config, store, {
				timeoutMs,
				shell: opts.shell,
				noPolicy: opts.policy === false,
			});

			if (!result.ok) {
				outputResult(result.error, outOpts);
				store.close();
				process.exit(result.error.exit_code);
			}

			const output = result.data;
			const id = output.failure_id as string;

			// --raw: append (possibly truncated) raw output read back from disk.
			if (opts.raw) {
				const redactedStdout = store.getRawOutput(id, "stdout") ?? "";
				const redactedStderr = store.getRawOutput(id, "stderr") ?? "";
				const rawFieldLimit = outOpts.maxBytes ? Math.floor(outOpts.maxBytes / 2) : undefined;
				if (rawFieldLimit && Buffer.byteLength(redactedStdout) > rawFieldLimit) {
					output.raw_stdout = Buffer.from(redactedStdout)
						.subarray(0, rawFieldLimit)
						.toString("utf-8");
					output.raw_stdout_truncated = true;
					output.raw_stdout_full_bytes = Buffer.byteLength(redactedStdout);
				} else {
					output.raw_stdout = redactedStdout;
				}
				if (rawFieldLimit && Buffer.byteLength(redactedStderr) > rawFieldLimit) {
					output.raw_stderr = Buffer.from(redactedStderr)
						.subarray(0, rawFieldLimit)
						.toString("utf-8");
					output.raw_stderr_truncated = true;
					output.raw_stderr_full_bytes = Buffer.byteLength(redactedStderr);
				} else {
					output.raw_stderr = redactedStderr;
				}
			}

			// Recompute token_budget.returned_bytes after the final output shape.
			const tb = output.token_budget as { raw_output_bytes: number } | undefined;
			if (tb) {
				const finalBytes = Buffer.byteLength(JSON.stringify(output));
				output.token_budget = computeTokenBudget(tb.raw_output_bytes, finalBytes);
			}

			outputResult(output, outOpts, () => {
				const record = store.getFailure(id);
				return record ? formatFailureText(record) : JSON.stringify(output, null, 2);
			});
			store.close();
		});
}
