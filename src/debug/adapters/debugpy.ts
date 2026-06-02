import type { AdapterInfo } from "./index.js";

export const debugpyAdapter: AdapterInfo = {
	name: "debugpy",
	runtime: "python",
	transport: "stdio",
	command: "python3",
	args: ["-m", "debugpy.adapter"],
	ready: true,
	installHint: "pip install debugpy",

	async isAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["python3", "-c", "import debugpy; print(debugpy.__version__)"], {
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
			type: "python",
			request: "launch",
			justMyCode: true,
			console: "internalConsole",
			cwd: options.cwd ?? process.cwd(),
		};

		if (options.module) {
			args.module = options.module;
			if (options.args?.length) {
				args.args = options.args;
			}
		} else if (options.program) {
			args.program = options.program;
			if (options.args?.length) {
				args.args = options.args;
			}
		}

		return args;
	},
};
