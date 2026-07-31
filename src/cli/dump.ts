/**
 * `failsafe dump <failure-id> [--stdout|--stderr|--combined] [--max-bytes N]`
 * (item 22) — explicit raw retrieval, the final step of progressive disclosure.
 *
 * Streams a failure's REDACTED stored log (secrets were scrubbed before the log
 * was written on `run`, so this never leaks) via `store.getRawOutput`. A byte
 * cap truncates the tail and attaches a `token_budget` + truncation note so an
 * agent knows the output was clipped. Failsafe mediates raw access rather than
 * making agents read `raw_paths.*` files directly.
 */
import type { Command } from "commander";
import { computeTokenBudget, truncateToByteLimit } from "../utils/tokens.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

type Stream = "stdout" | "stderr" | "combined";

export function registerDumpCommand(program: Command): void {
	program
		.command("dump <failure-id>")
		.description("Retrieve a failure's redacted raw log (stdout/stderr/combined)")
		.option("--stdout", "Dump stdout (default)")
		.option("--stderr", "Dump stderr")
		.option("--combined", "Dump the combined stdout+stderr log")
		.option("--max-bytes <bytes>", "Cap the returned log to this many bytes")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.action((rawId: string, opts) => {
			// `dump` returns raw content on request, so the stream cap below is
			// authoritative — disable the global output-byte cap that would
			// otherwise re-truncate the whole packet (and strip `content`).
			const { store, outOpts } = initCommand({ format: opts.format, quiet: opts.quiet });
			outOpts.maxBytes = undefined;
			const { failureId } = resolveFailureOrExit(rawId, store, outOpts);

			// Exactly one stream; stdout is the default.
			let stream: Stream = "stdout";
			if (opts.stderr) stream = "stderr";
			else if (opts.combined) stream = "combined";

			const raw = store.getRawOutput(failureId, stream) ?? "";
			const rawBytes = Buffer.byteLength(raw);

			const maxBytes = opts.maxBytes ? Number.parseInt(opts.maxBytes, 10) : undefined;
			let content = raw;
			let truncated = false;
			if (maxBytes !== undefined && rawBytes > maxBytes) {
				content = truncateToByteLimit(raw, maxBytes);
				truncated = true;
			}

			const output: Record<string, unknown> = {
				failure_id: failureId,
				stream,
				truncated,
				content,
				token_budget: computeTokenBudget(rawBytes, Buffer.byteLength(content)),
			};
			if (truncated) {
				output.note = `Output truncated to ${maxBytes} bytes of ${rawBytes}. Re-run with a larger --max-bytes for more.`;
			}

			outputResult(output, outOpts, () => content);
			store.close();
			if (raw.length === 0) process.exit(ExitCode.OK);
		});
}
