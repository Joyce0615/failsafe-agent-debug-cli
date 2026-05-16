import type { DebugProtocol } from "@vscode/debugprotocol";
import { extractSourceSlice } from "../diagnosis/context.js";
import type { SourceLocation } from "../types/common.js";
import { SCHEMA_VERSION } from "../types/common.js";
import type {
	ConsoleEvent,
	DebugSession,
	ExceptionEvent,
	StateDelta,
	StateSnapshot,
	VariableSnapshot,
} from "../types/debug.js";
import type { ContextSlice } from "../types/diagnosis.js";
import { debugId } from "../utils/id.js";
import { getAdapter } from "./adapters/index.js";
import { DapClient } from "./dap-client.js";
import { detectRuntime, generateLaunchConfig } from "./launch.js";
import { captureStateSnapshot, computeStateDelta } from "./state.js";

type ActiveSession = {
	client: DapClient;
	session: DebugSession;
	lastSnapshot: StateSnapshot | null;
	threadId: number;
	consoleEvents: ConsoleEvent[];
};

type StoreInterface = {
	saveDebugSession(session: DebugSession): void;
	updateDebugSession(id: string, updates: Partial<DebugSession>): void;
	getDebugSession(id: string): DebugSession | null;
};

export class DebugController {
	private sessions = new Map<string, ActiveSession>();
	private store: StoreInterface;

	constructor(store: StoreInterface) {
		this.store = store;
	}

	async startSession(options: {
		failureId?: string;
		reproId?: string;
		command: string;
		runtime?: string;
		breakpoints: SourceLocation[];
		watchExpressions?: string[];
		cwd?: string;
	}): Promise<DebugSession> {
		const runtime = (options.runtime as "python" | "node") ?? detectRuntime(options.command);
		if (runtime !== "python" && runtime !== "node") {
			throw new Error(`Unsupported debug runtime: ${runtime}. Currently supported: python, node`);
		}

		const adapter = getAdapter(runtime);
		if (!adapter) throw new Error(`No debug adapter found for ${runtime}`);

		const available = await adapter.isAvailable();
		if (!available) {
			throw new Error(
				`Debug adapter '${adapter.name}' is not available. Install: ${adapter.installHint}`,
			);
		}

		const sessionId = debugId();
		const launchConfig = generateLaunchConfig(options.command, runtime, { cwd: options.cwd });

		const client = new DapClient(
			{
				transport: adapter.transport,
				command: adapter.command,
				args: adapter.args,
				cwd: options.cwd,
			},
			30_000,
		);

		await client.connect();

		// Initialize
		await client.initialize({ adapterID: adapter.name });

		// Wait for initialized event
		const initializedPromise = client.waitForEvent("initialized", 10_000);

		// Set breakpoints
		for (const bp of options.breakpoints) {
			await client.setBreakpoints({ path: bp.file }, [{ line: bp.line }]);
		}

		// Set exception breakpoints
		await client.setExceptionBreakpoints(["uncaught"]);

		await initializedPromise;
		await client.configurationDone();

		// Launch
		const launchArgs = adapter.launchArgs({
			program: launchConfig.program,
			module: launchConfig.module,
			args: launchConfig.args,
			cwd: launchConfig.cwd,
		});
		await client.launch(launchArgs);

		// Collect console events
		const consoleEvents: ConsoleEvent[] = [];
		client.on("output", (body: DebugProtocol.OutputEvent["body"]) => {
			if (body.output.trim()) {
				consoleEvents.push({
					category: (body.category === "stderr" ? "stderr" : "stdout") as ConsoleEvent["category"],
					text: body.output.substring(0, 500),
				});
			}
		});

		// Wait for stopped event (breakpoint or exception)
		const stoppedBody = await client.waitForEvent<DebugProtocol.StoppedEvent["body"]>(
			"stopped",
			60_000,
		);

		const threadId = stoppedBody.threadId ?? 1;

		// Get current location
		const stackResult = await client.stackTrace(threadId, 0, 20);
		const topFrame = stackResult.stackFrames[0];
		const location: SourceLocation = {
			file: topFrame?.source?.path ?? "unknown",
			line: topFrame?.line ?? 0,
			column: topFrame?.column,
			symbol: topFrame?.name,
		};

		// Capture initial state snapshot
		const snapshot = topFrame
			? await captureStateSnapshot(client, threadId, topFrame.id, location)
			: null;

		const session: DebugSession = {
			schema_version: SCHEMA_VERSION,
			debug_session_id: sessionId,
			failure_id: options.failureId,
			repro_id: options.reproId,
			runtime,
			adapter: adapter.name,
			launch_config: launchConfig,
			status: "paused",
			current_thread_id: String(threadId),
			current_frame_id: topFrame ? String(topFrame.id) : undefined,
			breakpoints: options.breakpoints.map((bp) => ({
				location: bp,
				verified: true,
			})),
			watch_expressions: options.watchExpressions ?? [],
			last_state_snapshot: snapshot ?? undefined,
		};

		this.sessions.set(sessionId, {
			client,
			session,
			lastSnapshot: snapshot,
			threadId,
			consoleEvents,
		});

		this.store.saveDebugSession(session);
		return session;
	}

	async step(sessionId: string, kind: "over" | "into" | "out", count = 1): Promise<StateDelta> {
		const active = this.getActive(sessionId);
		const { client, threadId } = active;

		let lastDelta: StateDelta | null = null;

		for (let i = 0; i < count; i++) {
			const beforeSnapshot = active.lastSnapshot;

			// Step
			switch (kind) {
				case "over":
					await client.next(threadId);
					break;
				case "into":
					await client.stepIn(threadId);
					break;
				case "out":
					await client.stepOut(threadId);
					break;
			}

			// Wait for stopped
			const stoppedBody = await client.waitForEvent<DebugProtocol.StoppedEvent["body"]>(
				"stopped",
				30_000,
			);

			// Get new location
			const stackResult = await client.stackTrace(threadId, 0, 1);
			const topFrame = stackResult.stackFrames[0];
			const location: SourceLocation = {
				file: topFrame?.source?.path ?? "unknown",
				line: topFrame?.line ?? 0,
				column: topFrame?.column,
				symbol: topFrame?.name,
			};

			// Capture after snapshot
			const afterSnapshot = topFrame
				? await captureStateSnapshot(client, threadId, topFrame.id, location)
				: null;

			// Collect exceptions
			const exceptions: ExceptionEvent[] = [];
			if (stoppedBody.reason === "exception") {
				exceptions.push({
					type: stoppedBody.description ?? "Exception",
					message: stoppedBody.text ?? "",
					location,
				});
			}

			// Compute delta
			if (beforeSnapshot && afterSnapshot) {
				lastDelta = computeStateDelta(beforeSnapshot, afterSnapshot, kind, {
					exceptions,
					consoleEvents: [...active.consoleEvents],
				});
				lastDelta.debug_session_id = sessionId;
			} else if (afterSnapshot) {
				lastDelta = {
					debug_session_id: sessionId,
					from_location: location,
					to_location: location,
					step_kind: kind,
					changed_variables: [],
					branch_events: [],
					exceptions,
					console_events: [...active.consoleEvents],
					interpretation: "Initial step — no prior state to compare",
				};
			}

			active.lastSnapshot = afterSnapshot;
			active.consoleEvents = [];
			active.session.current_frame_id = topFrame ? String(topFrame.id) : undefined;
		}

		if (!lastDelta) {
			throw new Error("Step produced no state delta");
		}

		this.store.updateDebugSession(sessionId, {
			last_state_snapshot: active.lastSnapshot ?? undefined,
		});

		return lastDelta;
	}

	async getStack(sessionId: string): Promise<DebugProtocol.StackFrame[]> {
		const active = this.getActive(sessionId);
		const result = await active.client.stackTrace(active.threadId, 0, 50);
		return result.stackFrames;
	}

	async getVariables(
		sessionId: string,
		options: { changed?: boolean; scope?: string } = {},
	): Promise<VariableSnapshot[]> {
		const active = this.getActive(sessionId);
		const snapshot = active.lastSnapshot;
		if (!snapshot) return [];

		let vars: VariableSnapshot[] = [];
		for (const scope of snapshot.scopes) {
			if (options.scope && scope.name.toLowerCase() !== options.scope.toLowerCase()) continue;
			vars = [...vars, ...scope.variables];
		}

		if (options.changed && active.lastSnapshot) {
			// Only return variables that differ from a hypothetical "before"
			// For now, return all (full change detection requires two snapshots)
			return vars;
		}

		return vars;
	}

	async evaluate(
		sessionId: string,
		expression: string,
	): Promise<{ value: string; type?: string; summary?: string }> {
		const active = this.getActive(sessionId);
		const frameId = active.session.current_frame_id
			? Number.parseInt(active.session.current_frame_id, 10)
			: undefined;

		const result = await active.client.evaluate(expression, frameId, "repl");
		const value = result.result;
		const type = result.type || undefined;

		// Generate a one-line summary
		let summary: string | undefined;
		if (value.length > 100) {
			summary = `${type ?? "value"}: ${value.substring(0, 100)}...`;
		}

		return { value, type, summary };
	}

	async inspectSource(sessionId: string): Promise<ContextSlice | null> {
		const active = this.getActive(sessionId);
		const snapshot = active.lastSnapshot;
		if (!snapshot) return null;

		return extractSourceSlice(snapshot.location, 8);
	}

	async terminateSession(sessionId: string): Promise<void> {
		const active = this.sessions.get(sessionId);
		if (!active) return;

		try {
			await active.client.disconnect();
		} catch {
			// Adapter may already be gone
		}

		active.session.status = "terminated";
		this.store.updateDebugSession(sessionId, { status: "terminated" });
		this.sessions.delete(sessionId);
	}

	private getActive(sessionId: string): ActiveSession {
		const active = this.sessions.get(sessionId);
		if (!active) throw new Error(`No active debug session: ${sessionId}`);
		return active;
	}
}
