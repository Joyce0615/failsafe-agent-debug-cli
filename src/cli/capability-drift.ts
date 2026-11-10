/**
 * `failsafe capability-drift diagnose` — progressive-discovery and skill
 * drift CLI entry point (item 36).
 *
 * Mirrors `trace-gaps.ts` (item 32) and `drift.ts` (item 30): read-only,
 * local-file. Reads two already-captured `CapabilityCatalog` JSON files (the
 * exact shape a live MCP/A2A `tools/list` poll, recorded by the caller,
 * would produce) plus an optional failure-context JSON object, and runs the
 * SAME `diagnoseCapabilityDrift` path a live tool-discovery integration
 * would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type CapabilityCatalog,
	type CapabilityFailureContext,
	diagnoseCapabilityDrift,
	renderCapabilityDriftReport,
} from "../diagnosis/capability-drift.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerCapabilityDriftCommand(program: Command): void {
	const capabilityDrift = program
		.command("capability-drift")
		.description("Diagnose progressive-discovery and skill drift across two capability catalogs");

	capabilityDrift
		.command("diagnose")
		.description(
			"Diff visible capability catalogs (tool versions, schemas, policy scopes, cached ETags) and attribute a failure to missing, stale, or unexpectedly expanded tools",
		)
		.requiredOption("--before <path>", "Path to a JSON CapabilityCatalog captured earlier")
		.requiredOption("--after <path>", "Path to a JSON CapabilityCatalog captured later")
		.option(
			"--context <path>",
			'Path to a JSON CapabilityFailureContext: { "tool_name"?: string, "error_text": string }',
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let before: CapabilityCatalog;
			let after: CapabilityCatalog;
			let context: CapabilityFailureContext = { error_text: "" };
			try {
				before = readJson(opts.before as string) as CapabilityCatalog;
				after = readJson(opts.after as string) as CapabilityCatalog;
				if (opts.context) {
					context = readJson(opts.context as string) as CapabilityFailureContext;
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = diagnoseCapabilityDrift(before, after, context);

			if (opts.render) {
				process.stdout.write(renderCapabilityDriftReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
