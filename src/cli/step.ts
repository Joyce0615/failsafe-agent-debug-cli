import type { Command } from "commander";
import { DebugController } from "../debug/controller.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { createStore, loadConfig } from "./shared.js";

export function registerStepCommand(program: Command): void {
	program
		.command("step")
		.description("Step through execution and return state deltas")
		.requiredOption("--session <id>", "Debug session ID")
		.option("--format <format>", "Output format: json or text")
		.option("--over", "Step over (default)")
		.option("--into", "Step into")
		.option("--out", "Step out")
		.option("--count <n>", "Number of steps", "1")
		.option("--summary <mode>", "Summary mode: delta or full", "delta")
		.action(async (opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const outOpts = resolveOutputOptions(opts);

			let kind: "over" | "into" | "out" = "over";
			if (opts.into) kind = "into";
			else if (opts.out) kind = "out";

			const count = Number.parseInt(opts.count, 10);
			const controller = new DebugController(store);

			try {
				const delta = await controller.step(opts.session, kind, count);

				const output: Record<string, unknown> = {
					debug_session_id: delta.debug_session_id,
					step: { kind, count },
					status: "paused",
					location: delta.to_location,
				};

				if (opts.summary === "delta" || !opts.summary) {
					output.state_delta = delta.changed_variables;
					if (delta.exceptions.length > 0) {
						output.exceptions = delta.exceptions;
					}
					if (delta.console_events.length > 0) {
						output.console_events = delta.console_events;
					}
				}

				output.interpretation = delta.interpretation;

				output.next = [
					{
						command: `failsafe inspect vars --session ${opts.session} --changed`,
						reason: "See all changed variables",
					},
					{
						command: `failsafe step --session ${opts.session} --${kind}`,
						reason: "Continue stepping",
					},
				];

				outputResult(output, outOpts, () => {
					const lines = [
						`[STEP ${kind.toUpperCase()}] ${delta.from_location.file}:${delta.from_location.line} -> ${delta.to_location.file}:${delta.to_location.line}`,
					];
					if (delta.interpretation) lines.push(delta.interpretation);
					for (const c of delta.changed_variables) {
						lines.push(`  ${c.name}: ${c.before} -> ${c.after}${c.note ? ` (${c.note})` : ""}`);
					}
					return lines.join("\n");
				});
			} catch (err) {
				outputResult(
					{
						error: true,
						message: `Step failed: ${err instanceof Error ? err.message : String(err)}`,
					},
					outOpts,
				);
				process.exit(1);
			}
		});
}
