/**
 * `failsafe authorization-drift diagnose` — authorization-drift diagnosis
 * CLI entry point (item 44).
 *
 * Mirrors `capability-drift.ts` (item 36) and `nested-operations.ts`
 * (item 42): read-only, local-file. Reads an already-captured delegation
 * node list plus the original authorization intent, and runs the SAME
 * `diagnoseAuthorizationDrift` path a live multi-agent orchestration
 * integration would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type AuthorizationIntent,
	type DelegationNode,
	diagnoseAuthorizationDrift,
	renderAuthorizationDriftReport,
} from "../diagnosis/authorization-drift.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerAuthorizationDriftCommand(program: Command): void {
	const authorizationDrift = program
		.command("authorization-drift")
		.description(
			"Locate the first constraint loss across a multi-agent delegation chain's reserved actions, delegated policies, and observed effects",
		);

	authorizationDrift
		.command("diagnose")
		.description(
			"Diagnose authorization drift: policy widening, reserved-action execution, policy-exceeding effects, and lost policy sources across a delegation tree",
		)
		.requiredOption("--nodes <path>", "Path to a JSON DelegationNode[] array")
		.requiredOption("--intent <path>", "Path to a JSON AuthorizationIntent object")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let nodes: DelegationNode[];
			let intent: AuthorizationIntent;
			try {
				nodes = readJson(opts.nodes as string) as DelegationNode[];
				intent = readJson(opts.intent as string) as AuthorizationIntent;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = diagnoseAuthorizationDrift(nodes, intent);

			if (opts.render) {
				process.stdout.write(renderAuthorizationDriftReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
