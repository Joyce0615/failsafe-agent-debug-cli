/**
 * `failsafe migration-forensics diagnose` — protocol-deprecation
 * migration forensics CLI entry point (item 59).
 *
 * Mirrors `mrtr.ts`'s (item 51) and `retry-amplification.ts`'s (item
 * 58) read-only, local-JSON-file pattern. A caller supplies every
 * already-paired `MigrationObservation` (one per operation_id and
 * migration dimension: `mrtr`, `result_type`, `stateless_metadata`,
 * `subscription`, `sse_resume`); this command runs the same
 * `diagnoseMigrationForensics` path a live legacy/current trace-pairing
 * pipeline would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type MigrationObservation,
	diagnoseMigrationForensics,
	renderMigrationForensicsReport,
} from "../diagnosis/migration-forensics.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerMigrationForensicsCommand(program: Command): void {
	const migration = program
		.command("migration-forensics")
		.description(
			"Pair legacy and current MCP traces and classify protocol-deprecation differences as client, server, or SDK translation defects",
		);

	migration
		.command("diagnose")
		.description("Classify each paired operation/dimension's migration divergence, if any")
		.requiredOption("--observations <path>", "Path to a JSON MigrationObservation[] array")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let observations: MigrationObservation[];
			try {
				observations = readJson(opts.observations as string) as MigrationObservation[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const reports = diagnoseMigrationForensics(observations);

			if (opts.render) {
				process.stdout.write(renderMigrationForensicsReport(reports));
			} else {
				outputResult({ reports } as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
