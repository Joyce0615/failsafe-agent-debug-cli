import type { AdapterInfo } from "./index.js";

/**
 * Node.js debug adapter backed by the built-in V8 inspector.
 *
 * Failsafe's `debug` command uses the *launch-guidance* model: it hands the
 * agent/human a ready-to-run command that pauses execution and waits for a
 * DAP/IDE client to attach — it does not persist a live session across CLI
 * invocations. For Node this needs no extra install: `node --inspect-brk`
 * ships with Node itself and pauses on the first line until a debugger
 * attaches (the exact analogue of debugpy's `--listen --wait-for-client`).
 * The IDE side (VS Code "Node: Attach", or chrome://inspect) provides the
 * DAP/CDP bridge, just as the Python flow relies on "Python: Remote Attach".
 *
 * `isAvailable()` therefore only checks that `node` is on PATH.
 */
export const nodeInspectorAdapter: AdapterInfo = {
	name: "node-inspector",
	runtime: "node",
	transport: "stdio",
	command: "node",
	args: ["--inspect-brk"],
	ready: true,
	installHint: "Node.js ships a built-in inspector (node --inspect-brk); ensure 'node' is on PATH",

	async isAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
			await proc.exited;
			return proc.exitCode === 0;
		} catch {
			return false;
		}
	},

	launchArgs(options): Record<string, unknown> {
		return {
			type: "pwa-node",
			request: "launch",
			cwd: options.cwd ?? process.cwd(),
			sourceMaps: true,
			skipFiles: ["<node_internals>/**"],
			program: options.program,
			args: options.args,
		};
	},
};
