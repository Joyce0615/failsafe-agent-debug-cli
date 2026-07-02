/**
 * `failsafe watch "<command>"` — re-run a command whenever a watched file
 * changes and emit one compact diagnosis packet per cycle (an NDJSON stream),
 * closing the agent edit -> verify loop. Pairs with declared-rule hot-reload
 * (item 14): each cycle re-calls `diagnose`, which re-reads `.failsafe/rules.yaml`.
 *
 * The per-cycle work is the testable `runWatchCycle`, which reuses the shared
 * `analyzeCommand` (argv-first/no-shell by default, same policy as `run`) and
 * `diagnoseFailure` cores so the emitted packet never diverges from the CLI.
 * The long-running `watchLoop` only adds fs-event debouncing and printing.
 */
import { watch } from "node:fs";
import type { Command } from "commander";
import { analyzeCommand, diagnoseFailure } from "../core/operations.js";
import type { FailsafeStore } from "../storage/store.js";
import type { FailsafeConfig } from "../types/config.js";
import { ExitCode } from "./exit-codes.js";
import { createStore, loadConfig } from "./shared.js";

/** A single compact packet emitted per watch cycle. */
export type WatchPacket = {
	event: "result";
	cycle: number;
	status: string;
	failure_id?: string;
	exit_code?: number;
	failure_type?: string;
	summary?: string;
	primary_location?: unknown;
	diagnosis?: {
		category: string;
		confidence?: number;
		severity: string;
		summary: string;
	};
	next?: Array<{ command: string; reason: string }>;
	error?: true;
	message?: string;
};

/**
 * Run one watch cycle: capture/parse the command, and — only on failure —
 * diagnose it. Returns the compact packet for this cycle. Pure of
 * process.exit/console so it is unit-testable.
 */
export async function runWatchCycle(
	command: string,
	config: FailsafeConfig,
	store: FailsafeStore,
	cycle: number,
	opts: { timeoutMs?: number; shell?: boolean; noPolicy?: boolean } = {},
): Promise<WatchPacket> {
	const result = await analyzeCommand(command, config, store, opts);
	if (!result.ok) {
		return {
			event: "result",
			cycle,
			status: "error",
			error: true,
			message: result.error.message,
			exit_code: result.error.exit_code,
		};
	}

	const data = result.data;
	const status = String(data.status);
	const failureId = data.failure_id as string;
	const packet: WatchPacket = {
		event: "result",
		cycle,
		status,
		failure_id: failureId,
		exit_code: data.exit_code as number,
		failure_type: data.failure_type as string,
		summary: data.summary as string,
	};
	if (data.primary_location) packet.primary_location = data.primary_location;

	// A passing run needs no root-cause packet — the agent's edit worked.
	if (status !== "passed") {
		const diag = await diagnoseFailure(failureId, store, config);
		if (diag.ok) {
			const d = diag.data;
			packet.diagnosis = {
				category: d.root_cause?.category ?? "unknown",
				confidence: d.root_cause?.confidence,
				severity: d.severity,
				summary: d.summary,
			};
			if (d.suggested_next_actions.length > 0) packet.next = d.suggested_next_actions;
		}
	}
	return packet;
}

/** Print a single packet as a minified NDJSON line (one packet per line). */
function emit(packet: WatchPacket): void {
	console.log(JSON.stringify(packet));
}

/** Controls a running watch loop: stop watching and await clean teardown. */
export type WatchHandle = {
	/** Stop watching: clears any pending debounce timer and closes the watcher. */
	close(): void;
	/** Resolves once any in-flight cycle has settled (for clean teardown). */
	drain(): Promise<void>;
};

/**
 * The long-running watch loop. Runs an initial cycle, then re-runs (debounced)
 * on any change under `cwd`, skipping storage/VCS/dependency noise. Returns a
 * handle so callers/tests can stop it and drain in-flight work; in normal CLI
 * use the process simply runs until interrupted.
 */
export function watchLoop(
	command: string,
	config: FailsafeConfig,
	store: FailsafeStore,
	opts: {
		cwd: string;
		debounceMs?: number;
		timeoutMs?: number;
		shell?: boolean;
		noPolicy?: boolean;
		onCycle?: (packet: WatchPacket) => void;
	},
): WatchHandle {
	const debounceMs = opts.debounceMs ?? 300;
	const onCycle = opts.onCycle ?? emit;
	// Ignore churn from our own storage, VCS metadata, and dependencies so an
	// edit doesn't trigger an infinite re-run loop via written run artifacts.
	const ignored = [".failsafe", ".git", "node_modules", "dist"];
	let cycle = 0;
	let running = false;
	let pending = false;
	let stopped = false;
	let inFlight: Promise<void> = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const cycleOpts = {
		timeoutMs: opts.timeoutMs,
		shell: opts.shell,
		noPolicy: opts.noPolicy,
	};

	function trigger(): void {
		if (stopped || running) {
			if (!stopped) pending = true;
			return;
		}
		running = true;
		inFlight = (async () => {
			try {
				const packet = await runWatchCycle(command, config, store, ++cycle, cycleOpts);
				onCycle(packet);
			} finally {
				running = false;
				if (pending && !stopped) {
					pending = false;
					trigger();
				}
			}
		})();
	}

	const watcher = watch(opts.cwd, { recursive: true }, (_event, filename) => {
		if (stopped) return;
		if (filename && ignored.some((seg) => filename.split(/[\\/]/).includes(seg))) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => trigger(), debounceMs);
	});

	// Kick off an initial cycle so the first packet reflects the current state.
	trigger();

	return {
		close() {
			stopped = true;
			if (timer) clearTimeout(timer);
			watcher.close();
		},
		drain() {
			return inFlight;
		},
	};
}

export function registerWatchCommand(program: Command): void {
	program
		.command("watch <command>")
		.description("Re-run a command on file changes and emit a compact diagnosis packet per cycle")
		.option("--timeout <seconds>", "Command timeout in seconds", "120")
		.option("--debounce <ms>", "Debounce window for file-change events", "300")
		.option("--shell", "Run via 'sh -c' to allow shell syntax (operators, globs, pipes)")
		.option("--no-policy", "Skip command safety policy check")
		.action((command: string, opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const cwd = process.cwd();
			const handle = watchLoop(command, config, store, {
				cwd,
				debounceMs: Number.parseInt(opts.debounce, 10),
				timeoutMs: Number.parseInt(opts.timeout, 10) * 1000,
				shell: opts.shell,
				noPolicy: opts.policy === false,
			});
			// Emit a startup banner so an agent consuming the stream knows the
			// watcher is live and which command/dir it is bound to.
			console.log(JSON.stringify({ event: "watching", command, cwd, exit_code: ExitCode.OK }));
			const stop = () => {
				handle.close();
				void handle.drain().finally(() => {
					store.close();
					process.exit(0);
				});
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
		});
}
