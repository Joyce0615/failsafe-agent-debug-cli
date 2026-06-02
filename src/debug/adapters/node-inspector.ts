import type { AdapterInfo } from "./index.js";

/**
 * Node.js debug adapter stub.
 *
 * IMPORTANT: Node.js DAP support requires a dedicated adapter like
 * @vscode/js-debug. Plain `node` does NOT speak the DAP protocol over
 * stdio. This adapter is registered so that `detectRuntime` + capability
 * gating can report Node as "recognized but not yet available" with a
 * clear install hint, rather than silently failing at connection time.
 *
 * isAvailable() returns false until a real DAP adapter is installed.
 */
export const nodeInspectorAdapter: AdapterInfo = {
	name: "node-inspector",
	runtime: "node",
	transport: "stdio",
	command: "node",
	args: [],
	ready: false,
	installHint:
		"Node.js DAP debugging requires @vscode/js-debug. Install: npm install -g @vscode/js-debug",

	async isAvailable(): Promise<boolean> {
		// Plain `node` is not a DAP adapter. A real implementation needs
		// @vscode/js-debug or a similar DAP server. Return false until one
		// is detected.
		return false;
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
