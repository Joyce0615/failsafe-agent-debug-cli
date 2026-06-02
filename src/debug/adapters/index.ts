import type { Runtime } from "../../types/debug.js";
import type { DapTransport } from "../dap-client.js";
import { debugpyAdapter } from "./debugpy.js";
import { nodeInspectorAdapter } from "./node-inspector.js";

export type AdapterInfo = {
	name: string;
	runtime: "python" | "node";
	transport: DapTransport;
	command: string;
	args: string[];
	env?: Record<string, string>;
	/**
	 * Whether this adapter is a real, wired-up DAP adapter. A stub adapter
	 * (e.g. the Node placeholder) is registered for runtime detection but
	 * cannot actually drive a debug session, so it is reported as
	 * "recognized, adapter not yet available" rather than "supported".
	 */
	ready: boolean;
	isAvailable(): Promise<boolean>;
	installHint: string;
	launchArgs(options: {
		program?: string;
		module?: string;
		args?: string[];
		cwd?: string;
	}): Record<string, unknown>;
};

const ADAPTERS: AdapterInfo[] = [debugpyAdapter, nodeInspectorAdapter];

/** Runtimes with a real, wired-up DAP adapter (ready === true). */
const SUPPORTED_RUNTIMES = new Set<string>(ADAPTERS.filter((a) => a.ready).map((a) => a.runtime));

/** Install hints for runtimes that are recognized but not yet supported */
const FUTURE_RUNTIME_HINTS: Record<string, { debugger: string; installHint: string }> = {
	node: {
		debugger: "@vscode/js-debug",
		installHint: "npm install -g @vscode/js-debug",
	},
	go: { debugger: "Delve", installHint: "go install github.com/go-delve/delve/cmd/dlv@latest" },
	rust: {
		debugger: "LLDB / CodeLLDB",
		installHint: "Install LLDB via your system package manager",
	},
	java: { debugger: "JDI", installHint: "Java Debug Interface (requires JDK)" },
	dotnet: { debugger: "netcoredbg", installHint: "Install netcoredbg from Samsung/netcoredbg" },
};

/** Runtimes that have a working adapter, named for messaging. */
const READY_ADAPTER_NAMES = ADAPTERS.filter((a) => a.ready).map((a) => a.runtime);

export function getAdapter(runtime: "python" | "node"): AdapterInfo | null {
	return ADAPTERS.find((a) => a.runtime === runtime) ?? null;
}

export function listAdapters(): AdapterInfo[] {
	return [...ADAPTERS];
}

export type RuntimeCapability =
	| { supported: true; runtime: "python" | "node"; adapter: AdapterInfo }
	| {
			supported: false;
			runtime: Runtime;
			reason: string;
			install_hint?: string;
			future_debugger?: string;
			next_best: Array<{ command: string; reason: string }>;
	  };

/**
 * Check whether a detected runtime has a working debug adapter.
 * A runtime is "supported" only if its adapter is wired up (ready === true).
 * Returns a structured capability result that can be output directly
 * as JSON for agents instead of throwing generic errors.
 */
export function checkRuntimeCapability(runtime: Runtime, failureId?: string): RuntimeCapability {
	if (SUPPORTED_RUNTIMES.has(runtime)) {
		const adapter = getAdapter(runtime as "python" | "node")!;
		return { supported: true, runtime: runtime as "python" | "node", adapter };
	}

	const hint = FUTURE_RUNTIME_HINTS[runtime];
	const next: Array<{ command: string; reason: string }> = [];

	if (failureId) {
		next.push({
			command: `failsafe diagnose ${failureId}`,
			reason: "Get a root-cause diagnosis without debugging",
		});
		next.push({
			command: `failsafe repro ${failureId}`,
			reason: "Create a minimal reproduction to debug manually",
		});
	}

	const supportedList = READY_ADAPTER_NAMES.join(", ") || "none";

	if (runtime === "unknown") {
		return {
			supported: false,
			runtime,
			reason: `Could not detect runtime from the command. Runtimes with a working debug adapter: ${supportedList}.`,
			next_best: next,
		};
	}

	return {
		supported: false,
		runtime,
		reason: `Runtime '${runtime}' is recognized but its debug adapter is not yet available. Runtimes with a working debug adapter: ${supportedList}.`,
		future_debugger: hint?.debugger,
		install_hint: hint?.installHint,
		next_best: next,
	};
}
