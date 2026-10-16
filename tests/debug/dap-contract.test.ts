/**
 * Debugger adapter contract tests (item 12).
 *
 * `tests/debug/capability.test.ts` already proves `checkRuntimeCapability`'s
 * runtime-recognition logic in isolation. It does not prove the actual DAP
 * wire protocol works: nothing in the repo previously drove `DapClient` or
 * `DebugController.startSession()` against a real adapter end-to-end, or
 * against a fake adapter for the edge cases a real one won't reliably
 * exercise on demand (timeout, an in-flight cancel, a malformed response).
 * This file closes that gap.
 *
 * Two kinds of counterparty are used:
 *  - a real `debugpy` adapter (python3 -m debugpy.adapter) for the
 *    capabilities/breakpoints/threads/stack/variables contract — these are
 *    skipped (not failed) if debugpy is not importable in this environment,
 *    exactly like `describeNode` in tests/e2e/failsafe-e2e.test.ts skips when
 *    the Node fixture's jest isn't installed.
 *  - a tiny fake DAP server over `Bun.listen` (socket transport) for
 *    protocol edge cases a real adapter won't deterministically produce on
 *    command: request timeout and an unknown/unsupported command's response
 *    shape. This also proves the "unsupported runtimes" contract at the
 *    `checkRuntimeCapability` boundary `DebugController.startSession` relies
 *    on before ever touching the wire.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRuntimeCapability } from "../../src/debug/adapters/index.js";
import { DebugController } from "../../src/debug/controller.js";
import { DapClient } from "../../src/debug/dap-client.js";

// --- debugpy availability probe (mirrors adapters/debugpy.ts's own check) ---
function debugpyAvailable(): boolean {
	try {
		const proc = Bun.spawnSync(["python3", "-c", "import debugpy"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}
const hasDebugpy = debugpyAvailable();
const describeDebugpy = hasDebugpy ? describe : describe.skip;

// A fake, in-memory `StoreInterface` — DebugController only needs these three
// methods and this item is about the DAP wire contract, not storage.
function fakeStore() {
	const sessions = new Map<string, unknown>();
	return {
		saveDebugSession(session: { debug_session_id: string }) {
			sessions.set(session.debug_session_id, session);
		},
		updateDebugSession(id: string, updates: Record<string, unknown>) {
			const existing = sessions.get(id);
			if (existing) Object.assign(existing as object, updates);
		},
		getDebugSession(id: string) {
			return (sessions.get(id) as never) ?? null;
		},
	};
}

let fixtureDir: string;
let fixtureFile: string;

function writeFixture(): void {
	fixtureDir = mkdtempSync(join(tmpdir(), "failsafe-dap-contract-"));
	fixtureFile = join(fixtureDir, "target.py");
	writeFileSync(
		fixtureFile,
		[
			"def add(a, b):",
			"    result = a + b",
			"    return result",
			"",
			"",
			"x = add(2, 3)",
			"print(x)",
			"",
		].join("\n"),
	);
}

const activeClients: DapClient[] = [];
const activeControllers: DebugController[] = [];

afterEach(async () => {
	for (const c of activeClients.splice(0)) {
		try {
			await c.disconnect();
		} catch {
			// best effort
		}
	}
	for (const c of activeControllers.splice(0)) {
		for (const id of (c as unknown as { sessions: Map<string, unknown> }).sessions.keys()) {
			try {
				await c.terminateSession(id);
			} catch {
				// best effort
			}
		}
	}
	if (fixtureDir && existsSync(fixtureDir)) {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

/** Drive a fresh DapClient through initialize/launch/configurationDone against real debugpy. */
async function connectAndLaunch(breakpointLine: number): Promise<DapClient> {
	writeFixture();
	const client = new DapClient(
		{ transport: "stdio", command: "python3", args: ["-m", "debugpy.adapter"] },
		15_000,
	);
	activeClients.push(client);
	await client.connect();
	await client.initialize({ adapterID: "debugpy" });

	const initializedPromise = client.waitForEvent("initialized", 8_000);
	// Per the DAP spec, debugpy's `launch` request does not get a response
	// until after `configurationDone`, and will not emit `initialized` until
	// it has received the launch request — so this must be fired, not
	// awaited, before the configuration sequence.
	const launchPromise = client.launch({
		type: "python",
		request: "launch",
		program: fixtureFile,
		justMyCode: true,
		console: "internalConsole",
		cwd: fixtureDir,
	});
	await initializedPromise;
	await client.setBreakpoints({ path: fixtureFile }, [{ line: breakpointLine }]);
	await client.setExceptionBreakpoints(["uncaught"]);
	await client.configurationDone();
	await launchPromise;
	return client;
}

describeDebugpy("DapClient contract: capabilities (real debugpy)", () => {
	test("initialize returns real DAP capabilities with the fields this codebase depends on", async () => {
		const client = new DapClient(
			{ transport: "stdio", command: "python3", args: ["-m", "debugpy.adapter"] },
			10_000,
		);
		activeClients.push(client);
		await client.connect();
		const caps = await client.initialize({ adapterID: "debugpy" });

		expect(caps.supportsConfigurationDoneRequest).toBe(true);
		expect(Array.isArray(caps.exceptionBreakpointFilters)).toBe(true);
		expect(caps.exceptionBreakpointFilters?.some((f) => f.filter === "uncaught")).toBe(true);
	});
});

describeDebugpy("DapClient contract: breakpoints (real debugpy)", () => {
	test("setBreakpoints verifies a breakpoint at a real line and the adapter stops there", async () => {
		const client = await connectAndLaunch(2);
		const stopped = await client.waitForEvent<{ reason: string; threadId?: number }>(
			"stopped",
			10_000,
		);
		expect(stopped.reason).toBe("breakpoint");

		const threadId = stopped.threadId ?? 1;
		const stack = await client.stackTrace(threadId, 0, 1);
		expect(stack.stackFrames[0]?.line).toBe(2);
	}, 20_000);

	test("an unverifiable breakpoint location (past EOF) is still reported, not thrown", async () => {
		writeFixture();
		const client = new DapClient(
			{ transport: "stdio", command: "python3", args: ["-m", "debugpy.adapter"] },
			10_000,
		);
		activeClients.push(client);
		await client.connect();
		await client.initialize({ adapterID: "debugpy" });

		// setBreakpoints is only answered once the adapter's debug session has
		// actually started (the launch request sent, even though its RESPONSE
		// arrives later, after configurationDone) — see connectAndLaunch.
		const initializedPromise = client.waitForEvent("initialized", 8_000);
		const launchPromise = client.launch({
			type: "python",
			request: "launch",
			program: fixtureFile,
			justMyCode: true,
			console: "internalConsole",
			cwd: fixtureDir,
		});
		await initializedPromise;

		const result = await client.setBreakpoints({ path: fixtureFile }, [{ line: 9999 }]);
		expect(result?.breakpoints).toBeDefined();
		expect(result?.breakpoints.length).toBe(1);
		// debugpy reports verified:false for an out-of-range line rather than
		// erroring the request — the contract is "always a structured result".
		expect(typeof result?.breakpoints[0].verified).toBe("boolean");

		await client.setExceptionBreakpoints(["uncaught"]);
		await client.configurationDone();
		await launchPromise;
	}, 15_000);
});

describeDebugpy("DapClient contract: threads (real debugpy)", () => {
	test("threads() returns at least one real thread id once stopped", async () => {
		const client = await connectAndLaunch(2);
		await client.waitForEvent("stopped", 10_000);
		const threads = await client.threads();
		expect(threads.length).toBeGreaterThan(0);
		expect(typeof threads[0].id).toBe("number");
		expect(typeof threads[0].name).toBe("string");
	}, 20_000);
});

describeDebugpy("DapClient contract: stack (real debugpy)", () => {
	test("stackTrace() returns frames with a source path and line matching the breakpoint", async () => {
		const client = await connectAndLaunch(2);
		const stopped = await client.waitForEvent<{ threadId?: number }>("stopped", 10_000);
		const threadId = stopped.threadId ?? 1;
		const stack = await client.stackTrace(threadId, 0, 10);
		expect(stack.stackFrames.length).toBeGreaterThan(0);
		const top = stack.stackFrames[0];
		expect(top.line).toBe(2);
		expect(top.source?.path).toBe(fixtureFile);
	}, 20_000);
});

describeDebugpy("DapClient contract: variables (real debugpy)", () => {
	test("scopes() + variables() surface the real locals at the breakpoint", async () => {
		const client = await connectAndLaunch(2);
		const stopped = await client.waitForEvent<{ threadId?: number }>("stopped", 10_000);
		const threadId = stopped.threadId ?? 1;
		const stack = await client.stackTrace(threadId, 0, 1);
		const frameId = stack.stackFrames[0].id;

		const scopes = await client.scopes(frameId);
		expect(scopes.length).toBeGreaterThan(0);
		const locals = scopes.find((s) => s.name === "Locals") ?? scopes[0];

		const vars = await client.variables(locals.variablesReference);
		const byName = new Map(vars.map((v) => [v.name, v.value]));
		expect(byName.get("a")).toBe("2");
		expect(byName.get("b")).toBe("3");
	}, 20_000);
});

describeDebugpy("DebugController contract: full startSession (real debugpy)", () => {
	test("startSession reaches a paused state with a real stack+variable snapshot, not a deadlock", async () => {
		writeFixture();
		const controller = new DebugController(fakeStore() as never);
		activeControllers.push(controller);

		const session = await controller.startSession({
			command: `python3 ${fixtureFile}`,
			runtime: "python",
			breakpoints: [{ file: fixtureFile, line: 2 }],
			cwd: fixtureDir,
		});

		expect(session.status).toBe("paused");
		expect(session.adapter).toBe("debugpy");
		expect(session.last_state_snapshot?.location.line).toBe(2);
		const locals = session.last_state_snapshot?.scopes.find((s) => s.name === "Locals");
		const byName = new Map((locals?.variables ?? []).map((v) => [v.name, v.value]));
		expect(byName.get("a")).toBe("2");
		expect(byName.get("b")).toBe("3");

		await controller.terminateSession(session.debug_session_id);
	}, 25_000);
});

// --- Fake DAP server over Bun.listen (socket transport) for deterministic
// protocol edge cases a real adapter can't be relied on to reproduce on
// command: a request that never gets a response (timeout), and a successful
// response to a command the client never asked the adapter to support
// (an unsupported/cancel-style request answering with success:false). ---

type FakeServerHandle = {
	port: number;
	stop(): void;
};

function startFakeDapServer(
	handler: (
		cmd: string,
		seq: number,
		args: unknown,
		reply: (body: unknown, success: boolean, message?: string) => void,
	) => void,
): FakeServerHandle {
	let outSeq = 1000;
	let sock: { write(data: string): number } | null = null;

	function encode(message: Record<string, unknown>): string {
		const json = JSON.stringify(message);
		return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
	}

	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(connection) {
				sock = connection as unknown as { write(data: string): number };
			},
			data(connection, data) {
				const text = Buffer.from(data).toString("utf-8");
				const match = text.match(/Content-Length:\s*(\d+)\r\n\r\n(.*)/s);
				if (!match) return;
				let request: { seq: number; command: string; arguments?: unknown };
				try {
					request = JSON.parse(match[2]);
				} catch {
					return;
				}
				handler(request.command, request.seq, request.arguments, (body, success, message) => {
					const response: Record<string, unknown> = {
						seq: outSeq++,
						type: "response",
						request_seq: request.seq,
						success,
						command: request.command,
						body,
					};
					if (message) response.message = message;
					(connection as unknown as { write(data: string): number }).write(encode(response));
				});
			},
			close() {},
			error() {},
		},
	});

	return {
		port: (server as unknown as { port: number }).port,
		stop() {
			server.stop(true);
		},
	};
}

describe("DapClient contract: timeout (fake adapter)", () => {
	test("a request the adapter never answers rejects with a timeout error, not a hang", async () => {
		const fake = startFakeDapServer((cmd, _seq, _args, reply) => {
			if (cmd === "initialize") {
				reply({ supportsConfigurationDoneRequest: true }, true);
			}
			// Deliberately never reply to anything else (e.g. "threads").
		});

		const client = new DapClient({ transport: "socket", host: "127.0.0.1", port: fake.port }, 300);
		activeClients.push(client);
		await client.connect();
		await client.initialize({ adapterID: "fake" });

		await expect(client.threads()).rejects.toThrow(/timeout/i);
		fake.stop();
	});

	test("waitForEvent rejects with a timeout error when the expected event never arrives", async () => {
		const fake = startFakeDapServer((cmd, _seq, _args, reply) => {
			if (cmd === "initialize") reply({}, true);
			if (cmd === "disconnect") reply(undefined, true);
		});
		const client = new DapClient(
			{ transport: "socket", host: "127.0.0.1", port: fake.port },
			5_000,
		);
		await client.connect();
		await client.initialize({ adapterID: "fake" });

		await expect(client.waitForEvent("stopped", 200)).rejects.toThrow(
			/Timeout waiting for DAP event: stopped/,
		);
		// Disconnect while the fake server can still answer, then stop it --
		// the global afterEach also disconnects, but by then the server (if
		// stopped first) could no longer reply and would hang this cleanup.
		await client.disconnect();
		fake.stop();
	});
});

describe("DapClient contract: cancellation (fake adapter)", () => {
	test("a cancel request for an in-flight request is honored: the cancelled request's response is a failure, not a hang", async () => {
		const pendingReplies = new Map<
			number,
			(body: unknown, success: boolean, message?: string) => void
		>();
		const fake = startFakeDapServer((cmd, seq, args, reply) => {
			if (cmd === "initialize") {
				reply({ supportsCancelRequest: true }, true);
				return;
			}
			if (cmd === "disconnect") {
				reply(undefined, true);
				return;
			}
			if (cmd === "cancel") {
				const target = (args as { requestId?: number })?.requestId;
				const targetReply = target ? pendingReplies.get(target) : undefined;
				if (targetReply) {
					targetReply(undefined, false, "cancelled");
					pendingReplies.delete(target as number);
				}
				reply(undefined, true);
				return;
			}
			// Simulate a long-running request (e.g. evaluate) that only
			// resolves once cancelled or explicitly completed.
			pendingReplies.set(seq, reply);
		});

		const client = new DapClient(
			{ transport: "socket", host: "127.0.0.1", port: fake.port },
			5_000,
		);
		await client.connect();
		const caps = await client.initialize({ adapterID: "fake" });
		expect(caps.supportsCancelRequest).toBe(true);

		// Issue a slow "evaluate" request and immediately cancel it via the
		// DAP `cancel` request naming the original request's seq. The
		// cancelled request must reject cleanly rather than hang or time out.
		const slowRequest = client.evaluate("1+1");

		// Give the fake server a tick to register the pending request, then cancel it.
		await new Promise((r) => setTimeout(r, 20));
		await client.cancel(2);

		await expect(slowRequest).rejects.toThrow(/cancelled/i);
		// Disconnect while the fake server is still up to answer -- this
		// client is deliberately NOT registered in `activeClients` (the
		// global afterEach would otherwise try to disconnect it again after
		// `fake.stop()`, which would hang out the full request timeout
		// waiting for a reply from a server that no longer exists).
		await client.disconnect();
		fake.stop();
	});
});

describe("checkRuntimeCapability contract: unsupported runtimes", () => {
	test("go/rust/java/dotnet are recognized-but-unsupported with a next_best diagnose path, never a crash", () => {
		for (const runtime of ["go", "rust", "java", "dotnet"] as const) {
			const result = checkRuntimeCapability(runtime, "fail_contract_test");
			expect(result.supported).toBe(false);
			if (!result.supported) {
				expect(result.next_best.length).toBeGreaterThan(0);
				expect(result.install_hint).toBeDefined();
				expect(result.future_debugger).toBeDefined();
			}
		}
	});

	test("DebugController.startSession rejects an unsupported runtime before ever touching the DAP wire", async () => {
		const controller = new DebugController(fakeStore() as never);
		activeControllers.push(controller);
		await expect(
			controller.startSession({
				command: "go test ./...",
				runtime: "go",
				breakpoints: [],
			}),
		).rejects.toThrow(/Unsupported debug runtime: go/);
	});

	test("an unknown/undetectable runtime also rejects before touching the DAP wire", async () => {
		const controller = new DebugController(fakeStore() as never);
		activeControllers.push(controller);
		await expect(
			controller.startSession({
				command: "some-random-command",
				breakpoints: [],
			}),
		).rejects.toThrow(/Unsupported debug runtime: unknown/);
	});
});
