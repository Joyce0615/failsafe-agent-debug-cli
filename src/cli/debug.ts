import type { Command } from "commander";
import { checkRuntimeCapability } from "../debug/adapters/index.js";
import { detectRuntime } from "../debug/launch.js";
import { extractSourceSlice } from "../diagnosis/context.js";
import type { SourceLocation } from "../types/common.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureId } from "./shared.js";

/**
 * Build an interactive debugpy launch command for a Python command.
 * The agent/human runs this in a terminal; debugpy waits for an IDE/DAP
 * client to attach, then execution stops at the breakpoint.
 */
function buildDebugpyLaunchCommand(command: string, port: number): string {
	const pytestMatch = command.match(/(?:python3?\s+-m\s+)?pytest\s+(.+)/);
	const listen = `--listen 127.0.0.1:${port} --wait-for-client`;
	if (pytestMatch) {
		return `python3 -m debugpy ${listen} -m pytest ${pytestMatch[1]}`;
	}
	const moduleMatch = command.match(/python3?\s+-m\s+(\S+)(?:\s+(.+))?/);
	if (moduleMatch) {
		const args = moduleMatch[2] ? ` ${moduleMatch[2]}` : "";
		return `python3 -m debugpy ${listen} -m ${moduleMatch[1]}${args}`;
	}
	const scriptMatch = command.match(/python3?\s+(\S+\.py)(?:\s+(.+))?/);
	if (scriptMatch) {
		const args = scriptMatch[2] ? ` ${scriptMatch[2]}` : "";
		return `python3 -m debugpy ${listen} ${scriptMatch[1]}${args}`;
	}
	// Fallback: strip a leading python/python3 so we don't double the interpreter.
	const rest = command.replace(/^python3?\s+/, "");
	return `python3 -m debugpy ${listen} ${rest}`;
}

export function registerDebugCommand(program: Command): void {
	program
		.command("debug <failure-id>")
		.description(
			"[experimental] Emit launch guidance for an interactive debugger at the failure location",
		)
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--break <location>", "Breakpoint location: 'primary' or file:line", "primary")
		.option("--port <port>", "debugpy listen port", "5678")
		.option("--runtime <runtime>", "Override runtime detection: python or node")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

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
			let breakpoint: SourceLocation;
			if (opts.break === "primary") {
				if (failure.primary_location) {
					breakpoint = failure.primary_location;
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
					breakpoint = { file: match[1], line: Number.parseInt(match[2], 10) };
				} else {
					outputResult(
						{ error: true, message: `Invalid breakpoint format: ${opts.break}. Use file:line` },
						outOpts,
					);
					process.exit(1);
				}
			}

			// Prefer the minimal repro command for debugging if one exists
			const repro = store.getRepro(failureId);
			const command = repro?.command ?? failure.command;
			const runtime = opts.runtime ?? detectRuntime(command);

			// Capability gate: only runtimes with a working adapter get guidance
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

			// Check the adapter is installed
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

			// Emit non-interactive launch guidance. Failsafe does not manage a
			// long-lived debug session across CLI invocations; instead it hands
			// the agent/human a ready-to-run command to start an interactive
			// debugger that pauses at the failure location.
			const port = Number.parseInt(opts.port, 10);
			const launchCommand = buildDebugpyLaunchCommand(command, port);

			// Source context around the breakpoint
			const slice = await extractSourceSlice(breakpoint, 5);

			const output: Record<string, unknown> = {
				mode: "launch_guidance",
				runtime: capability.runtime,
				adapter: capability.adapter.name,
				breakpoint: { file: breakpoint.file, line: breakpoint.line, symbol: breakpoint.symbol },
				launch_command: launchCommand,
				instructions: [
					`Set a breakpoint at ${breakpoint.file}:${breakpoint.line} in your editor or via 'breakpoint()'.`,
					`Run: ${launchCommand}`,
					`Attach a DAP client / IDE to 127.0.0.1:${port} (e.g. VS Code 'Python: Remote Attach').`,
				],
				note: "Failsafe does not maintain interactive debug sessions across CLI invocations. The 'step' and 'inspect' commands are experimental and only operate within a single process.",
			};

			if (slice) {
				output.source_context = slice.text;
			}

			output.next = [
				{
					command: `failsafe diagnose ${failure.failure_id}`,
					reason: "Get a root-cause diagnosis without launching a debugger",
				},
			];

			outputResult(output, outOpts);
			store.close();
		});
}
