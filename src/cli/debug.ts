import type { Command } from "commander";
import { checkRuntimeCapability } from "../debug/adapters/index.js";
import { DebugController } from "../debug/controller.js";
import { detectRuntime } from "../debug/launch.js";
import { extractSourceSlice } from "../diagnosis/context.js";
import type { SourceLocation } from "../types/common.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { createStore, loadConfig, resolveFailureId } from "./shared.js";

export function registerDebugCommand(program: Command): void {
	program
		.command("debug <failure-id>")
		.description("[experimental] Launch a debugger around a failure or reproduction")
		.option("--format <format>", "Output format: json or text")
		.option("--break <location>", "Breakpoint location: 'primary' or file:line", "primary")
		.option("--watch <expressions>", "Comma-separated watch expressions")
		.option("--runtime <runtime>", "Override runtime detection: python or node")
		.action(async (rawId: string, opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const outOpts = resolveOutputOptions(opts);

			const failureId = resolveFailureId(rawId, store);
			if (!failureId) {
				outputResult({ error: true, message: "No failure found" }, outOpts);
				process.exit(1);
			}

			const failure = store.getFailure(failureId);
			if (!failure) {
				outputResult({ error: true, message: `Failure not found: ${failureId}` }, outOpts);
				process.exit(1);
			}

			// Determine breakpoint
			let breakpoints: SourceLocation[] = [];
			if (opts.break === "primary") {
				if (failure.primary_location) {
					breakpoints = [failure.primary_location];
				} else {
					outputResult(
						{ error: true, message: "No primary location for this failure. Use --break file:line" },
						outOpts,
					);
					process.exit(1);
				}
			} else {
				const match = opts.break.match(/^(.+):(\d+)$/);
				if (match) {
					breakpoints = [{ file: match[1], line: Number.parseInt(match[2], 10) }];
				} else {
					outputResult(
						{ error: true, message: `Invalid breakpoint format: ${opts.break}. Use file:line` },
						outOpts,
					);
					process.exit(1);
				}
			}

			// Check if we have a repro command
			const repro = store.getRepro(failureId);
			const command = repro?.command ?? failure.command;
			const runtime = opts.runtime ?? detectRuntime(command);

			// Capability gate: check if this runtime is supported before attempting debug
			const capability = checkRuntimeCapability(runtime, failure.failure_id);
			if (!capability.supported) {
				outputResult(
					{
						error: true,
						unsupported_runtime: true,
						runtime: capability.runtime,
						reason: capability.reason,
						future_debugger: capability.future_debugger,
						install_hint: capability.install_hint,
						next: capability.next_best,
					},
					outOpts,
				);
				process.exit(1);
			}

			const watchExpressions = opts.watch ? opts.watch.split(",").map((e: string) => e.trim()) : [];

			const controller = new DebugController(store);

			// Check if the adapter is available (installed)
			const adapterAvailable = await capability.adapter.isAvailable();
			if (!adapterAvailable) {
				outputResult(
					{
						error: true,
						adapter_missing: true,
						runtime: capability.runtime,
						adapter: capability.adapter.name,
						install_hint: capability.adapter.installHint,
						next: [
							{
								command: `failsafe diagnose ${failure.failure_id}`,
								reason: "Get diagnosis without debugging",
							},
						],
					},
					outOpts,
				);
				process.exit(1);
			}

			try {
				const session = await controller.startSession({
					failureId: failure.failure_id,
					reproId: repro?.repro_id,
					command,
					runtime,
					breakpoints,
					watchExpressions,
					cwd: failure.cwd,
				});

				// Get source context at paused location
				let sourceContext: string | undefined;
				if (session.last_state_snapshot) {
					const slice = await extractSourceSlice(session.last_state_snapshot.location, 5);
					if (slice) sourceContext = slice.text;
				}

				const output: Record<string, unknown> = {
					debug_session_id: session.debug_session_id,
					runtime: session.runtime,
					adapter: session.adapter,
					status: session.status,
					pause_reason: "breakpoint",
				};

				if (session.last_state_snapshot) {
					output.location = session.last_state_snapshot.location;
				}

				if (sourceContext) {
					output.source_context = sourceContext;
				}

				output.next = [
					{
						command: `failsafe inspect vars --session ${session.debug_session_id}`,
						reason: "Read local variables",
					},
					{
						command: `failsafe step --session ${session.debug_session_id} --over --summary delta`,
						reason: "Advance and report changed state",
					},
				];

				outputResult(output, outOpts);
			} catch (err) {
				outputResult(
					{
						error: true,
						message: `Debug session failed: ${err instanceof Error ? err.message : String(err)}`,
					},
					outOpts,
				);
				process.exit(1);
			}

			// Note: don't close store here — debug session is still active
		});
}
