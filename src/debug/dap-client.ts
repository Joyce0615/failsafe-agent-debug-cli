import { EventEmitter } from "node:events";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Subprocess } from "bun";

export type DapTransport = "stdio" | "socket";

export type DapClientOptions = {
	transport: DapTransport;
	// For stdio: command to spawn the adapter
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	// For socket: host and port
	host?: string;
	port?: number;
};

type PendingRequest = {
	resolve: (body: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/**
 * Standalone DAP (Debug Adapter Protocol) client.
 * Communicates with debug adapters over stdin/stdout or TCP.
 */
export class DapClient extends EventEmitter {
	private options: DapClientOptions;
	private seq = 1;
	private pending = new Map<number, PendingRequest>();
	private buffer = Buffer.alloc(0);
	private process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	private socket: unknown = null;
	private connected = false;
	private requestTimeout: number;

	constructor(options: DapClientOptions, requestTimeout = 10_000) {
		super();
		this.options = options;
		this.requestTimeout = requestTimeout;
	}

	async connect(): Promise<void> {
		if (this.options.transport === "stdio") {
			await this.connectStdio();
		} else {
			await this.connectSocket();
		}
		this.connected = true;
	}

	private async connectStdio(): Promise<void> {
		if (!this.options.command) throw new Error("stdio transport requires command");

		this.process = Bun.spawn([this.options.command, ...(this.options.args ?? [])], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...(this.options.env ?? {}) },
			cwd: this.options.cwd,
		});

		// Read stdout for DAP messages
		if (this.process.stdout) {
			this.readStream(this.process.stdout);
		}
	}

	private async connectSocket(): Promise<void> {
		const host = this.options.host ?? "127.0.0.1";
		const port = this.options.port;
		if (!port) throw new Error("socket transport requires port");

		return new Promise<void>((resolve, reject) => {
			Bun.connect({
				hostname: host,
				port,
				socket: {
					open: (sock) => {
						this.socket = sock;
						resolve();
					},
					data: (_socket, data) => {
						this.feed(Buffer.from(data));
					},
					error: (_socket, error) => {
						reject(error);
					},
					close: () => {
						this.connected = false;
						this.emit("closed");
					},
				},
			}).catch(reject);
		});
	}

	private async readStream(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.feed(Buffer.from(value));
			}
		} catch {
			// Stream ended
		}
		this.connected = false;
		this.emit("closed");
	}

	private feed(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data]);
		this.parseMessages();
	}

	private parseMessages(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = header.match(/Content-Length:\s*(\d+)/);
			if (!match) {
				// Skip malformed header
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}

			const contentLength = Number.parseInt(match[1], 10);
			const contentStart = headerEnd + 4;
			if (this.buffer.length < contentStart + contentLength) break;

			const content = this.buffer
				.subarray(contentStart, contentStart + contentLength)
				.toString("utf-8");
			this.buffer = this.buffer.subarray(contentStart + contentLength);

			try {
				const message = JSON.parse(content) as DebugProtocol.ProtocolMessage;
				this.handleMessage(message);
			} catch {
				// Skip malformed JSON
			}
		}
	}

	private handleMessage(message: DebugProtocol.ProtocolMessage): void {
		if (message.type === "response") {
			const response = message as DebugProtocol.Response;
			const pending = this.pending.get(response.request_seq);
			if (pending) {
				this.pending.delete(response.request_seq);
				clearTimeout(pending.timer);
				if (response.success) {
					pending.resolve(response.body);
				} else {
					pending.reject(new Error(response.message ?? `DAP request failed: ${response.command}`));
				}
			}
		} else if (message.type === "event") {
			const event = message as DebugProtocol.Event;
			this.emit(event.event, event.body);
		}
	}

	private sendRaw(message: DebugProtocol.ProtocolMessage): void {
		const json = JSON.stringify(message);
		const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
		const payload = header + json;

		if (this.options.transport === "stdio" && this.process?.stdin) {
			this.process.stdin.write(payload);
			this.process.stdin.flush();
		} else if (this.socket) {
			(this.socket as { write(data: string | BufferSource): number }).write(payload);
		}
	}

	private sendRequest<T>(command: string, args?: unknown): Promise<T> {
		return new Promise((resolve, reject) => {
			const seqNum = this.seq++;
			const timer = setTimeout(() => {
				this.pending.delete(seqNum);
				reject(new Error(`DAP request timeout: ${command} (${this.requestTimeout}ms)`));
			}, this.requestTimeout);

			this.pending.set(seqNum, {
				resolve: resolve as (body: unknown) => void,
				reject,
				timer,
			});

			const request: DebugProtocol.Request = {
				seq: seqNum,
				type: "request",
				command,
				arguments: args as Record<string, unknown>,
			};

			this.sendRaw(request);
		});
	}

	// High-level DAP methods

	async initialize(
		args?: Partial<DebugProtocol.InitializeRequestArguments>,
	): Promise<DebugProtocol.Capabilities> {
		return this.sendRequest<DebugProtocol.Capabilities>("initialize", {
			clientID: "failsafe",
			clientName: "Failsafe Debug CLI",
			adapterID: args?.adapterID ?? "unknown",
			pathFormat: "path",
			linesStartAt1: true,
			columnsStartAt1: true,
			supportsVariableType: true,
			supportsVariablePaging: false,
			supportsRunInTerminalRequest: false,
			locale: "en-US",
			...args,
		});
	}

	async launch(args: Record<string, unknown>): Promise<void> {
		await this.sendRequest("launch", args);
	}

	async attach(args: Record<string, unknown>): Promise<void> {
		await this.sendRequest("attach", args);
	}

	async configurationDone(): Promise<void> {
		await this.sendRequest("configurationDone");
	}

	async setBreakpoints(
		source: DebugProtocol.Source,
		breakpoints: DebugProtocol.SourceBreakpoint[],
	): Promise<DebugProtocol.SetBreakpointsResponse["body"]> {
		return this.sendRequest("setBreakpoints", { source, breakpoints });
	}

	async setExceptionBreakpoints(filters: string[]): Promise<void> {
		await this.sendRequest("setExceptionBreakpoints", { filters });
	}

	async continueExecution(threadId: number): Promise<void> {
		await this.sendRequest("continue", { threadId });
	}

	async next(threadId: number): Promise<void> {
		await this.sendRequest("next", { threadId });
	}

	async stepIn(threadId: number): Promise<void> {
		await this.sendRequest("stepIn", { threadId });
	}

	async stepOut(threadId: number): Promise<void> {
		await this.sendRequest("stepOut", { threadId });
	}

	async threads(): Promise<DebugProtocol.Thread[]> {
		const result = await this.sendRequest<{ threads: DebugProtocol.Thread[] }>("threads");
		return result.threads;
	}

	async stackTrace(
		threadId: number,
		startFrame?: number,
		levels?: number,
	): Promise<DebugProtocol.StackTraceResponse["body"]> {
		return this.sendRequest("stackTrace", { threadId, startFrame, levels });
	}

	async scopes(frameId: number): Promise<DebugProtocol.Scope[]> {
		const result = await this.sendRequest<{ scopes: DebugProtocol.Scope[] }>("scopes", {
			frameId,
		});
		return result.scopes;
	}

	async variables(variablesReference: number): Promise<DebugProtocol.Variable[]> {
		const result = await this.sendRequest<{ variables: DebugProtocol.Variable[] }>("variables", {
			variablesReference,
		});
		return result.variables;
	}

	async evaluate(
		expression: string,
		frameId?: number,
		context = "repl",
	): Promise<DebugProtocol.EvaluateResponse["body"]> {
		return this.sendRequest("evaluate", { expression, frameId, context });
	}

	async terminate(): Promise<void> {
		try {
			await this.sendRequest("terminate");
		} catch {
			// Adapter may already be gone
		}
	}

	async disconnect(restart = false): Promise<void> {
		try {
			await this.sendRequest("disconnect", {
				restart,
				terminateDebuggee: true,
			});
		} catch {
			// Adapter may already be gone
		}
		this.cleanup();
	}

	private cleanup(): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("DAP client disconnected"));
		}
		this.pending.clear();
		this.connected = false;

		if (this.process) {
			try {
				this.process.kill();
			} catch {
				// Already dead
			}
			this.process = null;
		}
	}

	/** Wait for a specific event with timeout */
	waitForEvent<T = unknown>(eventName: string, timeout = 30_000): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.removeListener(eventName, handler);
				reject(new Error(`Timeout waiting for DAP event: ${eventName}`));
			}, timeout);

			const handler = (body: T) => {
				clearTimeout(timer);
				resolve(body);
			};

			this.once(eventName, handler);
		});
	}

	get isConnected(): boolean {
		return this.connected;
	}
}
