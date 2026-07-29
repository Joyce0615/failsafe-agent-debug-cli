import type { Command } from "commander";
import { debugGuidance } from "../core/debug-guidance.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

export function registerDebugCommand(program: Command): void {
	program
		.command("debug <failure-id>")
		.description(
			"[experimental] Emit launch guidance for an interactive debugger at the failure location",
		)
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--break <location>", "Breakpoint location: 'primary' or file:line", "primary")
		.option("--port <port>", "debugpy listen port", "5678")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.option("--runtime <runtime>", "Override runtime detection: python or node")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);

			const result = await debugGuidance(rawId, store, {
				break: opts.break,
				port: Number.parseInt(opts.port, 10),
				runtime: opts.runtime,
			});

			outputResult(result.data, outOpts);
			store.close();
			if (result.exit_code !== ExitCode.OK) process.exit(result.exit_code);
		});
}
