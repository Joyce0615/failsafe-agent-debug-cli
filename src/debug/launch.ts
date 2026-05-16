import type { Runtime } from "../types/debug.js";

export type LaunchConfig = {
	type: string;
	request: "launch" | "attach";
	program?: string;
	module?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	port?: number;
	justMyCode?: boolean;
	runtimeExecutable?: string;
	sourceMaps?: boolean;
};

export function detectRuntime(command: string): Runtime {
	if (/python3?|pytest|python\s+-m/.test(command)) return "python";
	if (/node|npx|jest|vitest|bun\s+test|tsx|ts-node/.test(command)) return "node";
	if (/cargo\s+test|rustc/.test(command)) return "rust";
	if (/go\s+test|go\s+run/.test(command)) return "go";
	if (/java|mvn|gradle/.test(command)) return "java";
	if (/dotnet/.test(command)) return "dotnet";
	return "unknown";
}

export function generateLaunchConfig(
	reproCommand: string,
	runtime: Runtime,
	options?: { cwd?: string; env?: Record<string, string> },
): LaunchConfig {
	switch (runtime) {
		case "python":
			return generatePythonLaunchConfig(reproCommand, options?.cwd);
		case "node":
			return generateNodeLaunchConfig(reproCommand, options?.cwd);
		default:
			return {
				type: runtime,
				request: "launch",
				program: reproCommand,
				cwd: options?.cwd,
			};
	}
}

function generatePythonLaunchConfig(command: string, cwd?: string): LaunchConfig {
	const config: LaunchConfig = {
		type: "python",
		request: "launch",
		cwd: cwd ?? process.cwd(),
		justMyCode: true,
	};

	// Parse: pytest tests/test_auth.py::test_fn -x
	const pytestMatch = command.match(/(?:python3?\s+-m\s+)?pytest\s+(.+)/);
	if (pytestMatch) {
		config.module = "pytest";
		config.args = parseArgs(pytestMatch[1]);
		return config;
	}

	// Parse: python -m module_name args
	const moduleMatch = command.match(/python3?\s+-m\s+(\S+)(?:\s+(.+))?/);
	if (moduleMatch) {
		config.module = moduleMatch[1];
		if (moduleMatch[2]) {
			config.args = parseArgs(moduleMatch[2]);
		}
		return config;
	}

	// Parse: python script.py args
	const scriptMatch = command.match(/python3?\s+(\S+\.py)(?:\s+(.+))?/);
	if (scriptMatch) {
		config.program = scriptMatch[1];
		if (scriptMatch[2]) {
			config.args = parseArgs(scriptMatch[2]);
		}
		return config;
	}

	// Fallback: run as module
	config.module = "pytest";
	config.args = parseArgs(command.replace(/^pytest\s+/, ""));
	return config;
}

function generateNodeLaunchConfig(command: string, cwd?: string): LaunchConfig {
	const config: LaunchConfig = {
		type: "pwa-node",
		request: "launch",
		cwd: cwd ?? process.cwd(),
		sourceMaps: true,
	};

	// Parse: npx jest tests/auth.test.ts -t "name"
	const jestMatch = command.match(/(?:npx\s+)?jest\s+(.+)/);
	if (jestMatch) {
		config.program = "${workspaceFolder}/node_modules/.bin/jest";
		config.args = ["--runInBand", ...parseArgs(jestMatch[1])];
		return config;
	}

	// Parse: npx vitest run tests/auth.test.ts
	const vitestMatch = command.match(/(?:npx\s+)?vitest\s+(.+)/);
	if (vitestMatch) {
		config.program = "${workspaceFolder}/node_modules/.bin/vitest";
		config.args = parseArgs(vitestMatch[1]);
		return config;
	}

	// Parse: node script.js args
	const nodeMatch = command.match(/node\s+(\S+)(?:\s+(.+))?/);
	if (nodeMatch) {
		config.program = nodeMatch[1];
		if (nodeMatch[2]) {
			config.args = parseArgs(nodeMatch[2]);
		}
		return config;
	}

	// Fallback
	config.program = command;
	return config;
}

function parseArgs(argsStr: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (const char of argsStr) {
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}
