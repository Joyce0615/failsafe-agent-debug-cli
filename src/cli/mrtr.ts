/**
 * `failsafe mrtr diagnose` — MCP multi-round tool-response (MRTR) stall
 * and response-mismatch diagnosis CLI entry point (item 51).
 *
 * Mirrors `async-lifecycle-race.ts`'s (item 47) and `authorization-drift.ts`'s
 * (item 44) read-only, local-JSON-file pattern. A caller supplies the
 * already-captured, already-sequenced `MrtrRound[]` for one MRTR
 * exchange; this command runs the SAME `diagnoseMrtrExchange` path a live
 * MCP client/server integration would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { type MrtrRound, diagnoseMrtrExchange, renderMrtrReport } from "../diagnosis/mrtr.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerMrtrCommand(program: Command): void {
	const mrtr = program
		.command("mrtr")
		.description(
			"Diagnose MCP multi-round tool-response (MRTR) stalls, missing/replayed responses, request-state mismatch, retry parameter drift, and infinite input loops",
		);

	mrtr
		.command("diagnose")
		.description(
			"Diagnose every MRTR finding across one exchange's rounds and name the first violated round",
		)
		.requiredOption("--rounds <path>", "Path to a JSON MrtrRound[] array for one MRTR exchange")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let rounds: MrtrRound[];
			try {
				rounds = readJson(opts.rounds as string) as MrtrRound[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const report = diagnoseMrtrExchange(rounds);

			if (opts.render) {
				process.stdout.write(renderMrtrReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
