import type { AdapterInfo } from "./index.js";

export const nodeInspectorAdapter: AdapterInfo = {
	name: "node-inspector",
	runtime: "node",
	transport: "stdio",
	command: "node",
	args: [],
	installHint: "Node.js built-in debugger (no additional install needed)",

	async isAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["node", "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			return proc.exitCode === 0;
		} catch {
			return false;
		}
	},

	launchArgs(options): Record<string, unknown> {
		const args: Record<string, unknown> = {
			type: "pwa-node",
			request: "launch",
			cwd: options.cwd ?? process.cwd(),
			sourceMaps: true,
			skipFiles: ["<node_internals>/**"],
		};

		if (options.program) {
			args.program = options.program;
			if (options.args?.length) {
				args.args = options.args;
			}
		}

		return args;
	},
};
