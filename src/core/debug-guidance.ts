/**
 * Shared `debug` launch-guidance core (items 1, 21).
 *
 * Extracted from `src/cli/debug.ts` so the CLI and the `failsafe_debug` MCP tool
 * emit exactly the same packet: resolve the failure, pick a breakpoint, prefer
 * the minimal repro command, gate on runtime capability + adapter availability,
 * and build a ready-to-run launch command (debugpy for Python, the built-in V8
 * inspector for Node). Returns `{ exit_code, data }` (never throws / exits) so
 * both wrappers map it to output + an exit code.
 */
import { ExitCode } from "../cli/exit-codes.js";
import { checkRuntimeCapability } from "../debug/adapters/index.js";
import { detectRuntime } from "../debug/launch.js";
import { extractSourceSlice } from "../diagnosis/context.js";
import type { FailsafeStore } from "../storage/store.js";
import type { SourceLocation } from "../types/common.js";
import type { Runtime } from "../types/debug.js";

export type DebugGuidanceResult = { exit_code: number; data: Record<string, unknown> };

/**
 * Build an interactive debugpy launch command for a Python command. The
 * agent/human runs this; debugpy waits for a DAP client to attach, then
 * execution stops at the breakpoint.
 */
export function buildDebugpyLaunchCommand(command: string, port: number): string {
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
	const rest = command.replace(/^python3?\s+/, "");
	return `python3 -m debugpy ${listen} ${rest}`;
}

/**
 * Build a Node launch command using the built-in V8 inspector. `--inspect-brk`
 * pauses on the first line and waits for a DAP/IDE client to attach — the Node
 * analogue of debugpy's `--listen --wait-for-client`.
 */
export function buildNodeInspectLaunchCommand(command: string, port: number): string {
	const brk = `--inspect-brk=127.0.0.1:${port}`;
	const jestMatch = command.match(/(?:npx\s+)?jest\s+(.+)/);
	if (jestMatch) {
		return `node ${brk} node_modules/.bin/jest --runInBand ${jestMatch[1]}`;
	}
	const vitestMatch = command.match(/(?:npx\s+)?vitest\s+(.+)/);
	if (vitestMatch) {
		return `node ${brk} node_modules/.bin/vitest ${vitestMatch[1]}`;
	}
	const bunMatch = command.match(/^bun\s+(.+)/);
	if (bunMatch) {
		return `bun --inspect-brk=127.0.0.1:${port} ${bunMatch[1]}`;
	}
	const nodeMatch = command.match(/^node\s+(.+)/);
	if (nodeMatch) {
		return `node ${brk} ${nodeMatch[1]}`;
	}
	const rest = command.replace(/^node\s+/, "");
	return `node ${brk} ${rest}`;
}

function resolveId(rawId: string, store: FailsafeStore): string | null {
	if (rawId === "--last" || rawId === "last") return store.getFailure("last")?.failure_id ?? null;
	return rawId;
}

/**
 * Produce interactive-debug launch guidance for a stored failure, or a
 * structured error/unavailable packet. Shared by the CLI and MCP.
 */
export async function debugGuidance(
	rawId: string,
	store: FailsafeStore,
	opts: { break?: string; port?: number; runtime?: string } = {},
): Promise<DebugGuidanceResult> {
	const fid = resolveId(rawId, store);
	const failure = fid ? store.getFailure(fid) : null;
	if (!failure) {
		return {
			exit_code: ExitCode.NO_INPUT,
			data: {
				error: true,
				message: rawId === "last" ? "No failure found in history" : `Failure not found: ${rawId}`,
			},
		};
	}

	const breakSpec = opts.break ?? "primary";
	let breakpoint: SourceLocation;
	if (breakSpec === "primary") {
		if (!failure.primary_location) {
			return {
				exit_code: ExitCode.ERROR,
				data: {
					error: true,
					message: "No primary location for this failure. Use --break file:line",
				},
			};
		}
		breakpoint = failure.primary_location;
	} else {
		const match = breakSpec.match(/^(.+):(\d+)$/);
		if (!match) {
			return {
				exit_code: ExitCode.ERROR,
				data: { error: true, message: `Invalid breakpoint format: ${breakSpec}. Use file:line` },
			};
		}
		breakpoint = { file: match[1], line: Number.parseInt(match[2], 10) };
	}

	// Prefer the minimal repro command for debugging if one exists.
	const repro = store.getRepro(failure.failure_id);
	const command = repro?.command ?? failure.command;
	const runtime = (opts.runtime as Runtime | undefined) ?? detectRuntime(command);

	const capability = checkRuntimeCapability(runtime, failure.failure_id);
	if (!capability.supported) {
		return {
			exit_code: ExitCode.DEBUG_UNAVAILABLE,
			data: {
				error: true,
				unsupported_runtime: true,
				runtime: capability.runtime,
				reason: capability.reason,
				future_debugger: capability.future_debugger,
				install_hint: capability.install_hint,
				next: capability.next_best,
			},
		};
	}

	const adapterAvailable = await capability.adapter.isAvailable();
	if (!adapterAvailable) {
		return {
			exit_code: ExitCode.DEBUG_UNAVAILABLE,
			data: {
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
		};
	}

	const port = opts.port ?? 5678;
	const isNode = capability.runtime === "node";
	const launchCommand = isNode
		? buildNodeInspectLaunchCommand(command, port)
		: buildDebugpyLaunchCommand(command, port);

	const slice = await extractSourceSlice(breakpoint, 5);

	const attachInstruction = isNode
		? `Attach a DAP client / IDE to 127.0.0.1:${port} (e.g. VS Code 'Node: Attach' or chrome://inspect).`
		: `Attach a DAP client / IDE to 127.0.0.1:${port} (e.g. VS Code 'Python: Remote Attach').`;
	const setBreakpointInstruction = isNode
		? `Set a breakpoint at ${breakpoint.file}:${breakpoint.line} in your editor (execution pauses on the first line until you attach).`
		: `Set a breakpoint at ${breakpoint.file}:${breakpoint.line} in your editor or via 'breakpoint()'.`;

	const data: Record<string, unknown> = {
		mode: "launch_guidance",
		runtime: capability.runtime,
		adapter: capability.adapter.name,
		breakpoint: { file: breakpoint.file, line: breakpoint.line, symbol: breakpoint.symbol },
		launch_command: launchCommand,
		instructions: [setBreakpointInstruction, `Run: ${launchCommand}`, attachInstruction],
		note: "Failsafe does not maintain interactive debug sessions across CLI invocations. The 'step' and 'inspect' commands are experimental and only operate within a single process.",
	};
	if (slice) data.source_context = slice.text;
	data.next = [
		{
			command: `failsafe diagnose ${failure.failure_id}`,
			reason: "Get a root-cause diagnosis without launching a debugger",
		},
	];

	return { exit_code: ExitCode.OK, data };
}

/** The structured packet a cross-process step/inspect returns: no live session. */
export function debugSessionUnavailable(sessionId: string): DebugGuidanceResult {
	return {
		exit_code: ExitCode.DEBUG_UNAVAILABLE,
		data: {
			error: true,
			debug_unavailable: true,
			message: `No active debug session: ${sessionId}. Debug sessions are in-memory and do not persist across invocations. Use 'failsafe debug <id>' to start a new session.`,
			next: [{ command: "failsafe diagnose last", reason: "Get diagnosis without debug stepping" }],
		},
	};
}
