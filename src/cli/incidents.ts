/**
 * `failsafe incidents diagnose` — cross-agent causal incident graph CLI
 * entry point (item 22).
 *
 * Mirrors `trace.ts` (item 21): a read-only, local-file command that takes an
 * already-collected JSON array of cross-agent events (delegation, message,
 * memory/tool/environment access — see `diagnosis/incident-graph.ts`) and
 * runs the SAME `buildIncidentGraph` path an orchestrator integration would
 * call. No live orchestrator is reached over the network by this command.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { AgentEvent } from "../diagnosis/incident-graph.js";
import { buildIncidentGraph } from "../diagnosis/incident-graph.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerIncidentsCommand(program: Command): void {
	const incidents = program
		.command("incidents")
		.description("Cross-agent causal incident graph reconstruction");

	incidents
		.command("diagnose")
		.description(
			"Reconstruct delegation, message, memory, tool, and environment edges across a set of cross-agent events, and report the first propagating fault",
		)
		.requiredOption("--file <path>", "Path to a JSON array of AgentEvent records")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let events: AgentEvent[];
			try {
				events = readJson(opts.file as string) as AgentEvent[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read events: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			if (!Array.isArray(events) || events.length === 0) {
				outputResult(
					{
						error: true,
						message: "--file must contain a non-empty JSON array of AgentEvent records",
					},
					outOpts,
				);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			const result = buildIncidentGraph(events);
			outputResult(
				{
					nodes: result.nodes,
					edges: result.edges,
					root_causes: result.root_causes,
					first_propagating_fault: result.first_propagating_fault,
					uncertainty: result.uncertainty,
				},
				outOpts,
			);
			store.close();
		});
}
