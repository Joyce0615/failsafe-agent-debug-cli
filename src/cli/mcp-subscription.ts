/**
 * `failsafe mcp-subscription diagnose` — MCP subscription loss and
 * cross-talk diagnosis CLI entry point (item 52).
 *
 * Mirrors `mrtr.ts`'s (item 51) and `async-lifecycle-race.ts`'s (item 47)
 * read-only, local-JSON-file pattern. A caller supplies the
 * already-captured, already-sequenced `SubscriptionEvent[]` for one or
 * more `resources/subscribe` lifecycles; this command runs the SAME
 * `diagnoseSubscriptionExchange` path a live MCP client/server
 * integration would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type SubscriptionEvent,
	diagnoseSubscriptionExchange,
	renderSubscriptionReport,
} from "../diagnosis/mcp-subscription.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerMcpSubscriptionCommand(program: Command): void {
	const sub = program
		.command("mcp-subscription")
		.description(
			"Diagnose MCP resources/subscribe lifecycle loss and cross-talk: acknowledgment ordering, ownership, requested resource, duplicates, gaps, and closure",
		);

	sub
		.command("diagnose")
		.description(
			"Diagnose every subscription finding across one capture's events and name the first violation",
		)
		.requiredOption(
			"--events <path>",
			"Path to a JSON SubscriptionEvent[] array across one or more subscriptions",
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let events: SubscriptionEvent[];
			try {
				events = readJson(opts.events as string) as SubscriptionEvent[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const report = diagnoseSubscriptionExchange(events);

			if (opts.render) {
				process.stdout.write(renderSubscriptionReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
