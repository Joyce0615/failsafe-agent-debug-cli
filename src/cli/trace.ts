/**
 * `failsafe trace diagnose` — OpenTelemetry trace conformance ingestion +
 * diagnosis (item 21).
 *
 * This is the first CLI entry point for `trace/diagnose.ts` (item 40) and
 * `trace/conformance.ts` (item 21) ever wired to a command — confirmed by
 * grep before this file existed: `diagnoseTrace`/`TraceSource`/
 * `BACKEND_ADAPTERS` appeared only in `trace/diagnose.ts` itself and in
 * `tests/trace/ingest.test.ts`. An agent could not retrieve a failing trace
 * through this CLI at all; it could only run `failsafe run`/`diagnose`
 * against a locally captured command.
 *
 * Fetching stays read-only and local-file-based deliberately: this command
 * does not reach out to a live Jaeger/Tempo endpoint over HTTP (that is a
 * credentialed, network-reaching integration this item does not add). It
 * reads an already-exported trace payload JSON file — the exact shape
 * `fromJaeger`/`fromTempo` already parse — plus an optional correlated-logs
 * file, and runs the SAME conformance-gated diagnosis path a live backend
 * integration would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { LogRecord } from "../trace/conformance.js";
import { diagnoseTraceConformant } from "../trace/diagnose.js";
import type { BackendKind } from "../trace/normalize.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerTraceCommand(program: Command): void {
	const trace = program.command("trace").description("OpenTelemetry trace ingestion and diagnosis");

	trace
		.command("diagnose <trace-id>")
		.description(
			"Normalize a locally-exported Jaeger/Tempo trace, validate OTel conformance, and diagnose it",
		)
		.requiredOption("--backend <backend>", "Trace backend shape: jaeger or tempo")
		.requiredOption("--file <path>", "Path to the exported trace payload JSON")
		.option("--logs <path>", "Path to a JSON array of correlated OTel log records")
		.option("--max-spans <n>", "Span cap for this query")
		.option("--lookback-ms <ms>", "Lookback window ceiling in ms")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (traceId: string, opts) => {
			const { store, outOpts } = initCommand(opts);

			const backend = opts.backend as string;
			if (backend !== "jaeger" && backend !== "tempo") {
				outputResult(
					{ error: true, message: `--backend must be 'jaeger' or 'tempo', got '${backend}'` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			let payload: unknown;
			let logs: LogRecord[] = [];
			try {
				payload = readJson(opts.file as string);
				if (opts.logs) {
					logs = readJson(opts.logs as string) as LogRecord[];
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read trace input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const result = await diagnoseTraceConformant(
				{
					kind: backend as BackendKind,
					name: opts.file as string,
					fetchTrace: async () => payload,
				},
				{
					trace_id: traceId,
					...(opts.maxSpans ? { max_spans: Number.parseInt(opts.maxSpans as string, 10) } : {}),
					...(opts.lookbackMs
						? { lookback_ms: Number.parseInt(opts.lookbackMs as string, 10) }
						: {}),
				},
				logs,
			);

			if (!result.ok) {
				outputResult({ ...result.error, conformance: result.conformance }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			outputResult({ ...result.data, conformance: result.conformance }, outOpts);
			store.close();
		});
}
