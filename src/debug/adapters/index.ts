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

const SUPPORTED_RUNTIMES = new Set<string>(ADAPTERS.map((a) => a.runtime));

/** Install hints for runtimes that are recognized but not yet supported */
const FUTURE_RUNTIME_HINTS: Record<string, { debugger: string; installHint: string }> = {
	go: { debugger: "Delve", installHint: "go install github.com/go-delve/delve/cmd/dlv@latest" },
	rust: {
		debugger: "LLDB / CodeLLDB",
		installHint: "Install LLDB via your system package manager",
	},
	java: { debugger: "JDI", installHint: "Java Debug Interface (requires JDK)" },
	dotnet: { debugger: "netcoredbg", installHint: "Install netcoredbg from Samsung/netcoredbg" },
};

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
 * Check whether a detected runtime is supported for debugging.
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

	if (runtime === "unknown") {
		return {
			supported: false,
			runtime,
			reason: "Could not detect runtime from the command. Supported runtimes: python, node.",
			next_best: next,
		};
	}

	return {
		supported: false,
		runtime,
		reason: `Runtime '${runtime}' is recognized but debug stepping is not yet supported. Supported: python, node.`,
		future_debugger: hint?.debugger,
		install_hint: hint?.installHint,
		next_best: next,
	};
}
