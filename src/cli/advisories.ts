/**
 * `failsafe advisories ingest` — runtime and dependency security advisory
 * ingestion CLI entry point (item 37).
 *
 * Mirrors `capability-drift.ts` (item 36) and `drift.ts` (item 30):
 * read-only, local-file. Reads an advisory feed, SBOM components, a
 * deployment exposure, and an incident evidence JSON file, then runs the
 * SAME `ingestAdvisories` path a live SBOM/advisory-feed integration would
 * call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { SbomComponent } from "../release/supply-chain.js";
import {
	type DeploymentExposure,
	type IncidentEvidence,
	type SecurityAdvisory,
	ingestAdvisories,
	renderAdvisoryIngestReport,
} from "../security/advisories.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerAdvisoriesCommand(program: Command): void {
	const advisories = program
		.command("advisories")
		.description("Ingest runtime and dependency security advisories against this project's SBOM");

	advisories
		.command("ingest")
		.description(
			"Match signed advisories against SBOM components, distinguish vulnerable from exploitable configurations, and propose bounded upgrade or isolation recovery",
		)
		.requiredOption("--advisories <path>", "Path to a JSON array of SecurityAdvisory")
		.requiredOption("--sbom-components <path>", "Path to a JSON array of SBOM SbomComponent")
		.requiredOption(
			"--exposure <path>",
			'Path to a JSON DeploymentExposure: { "network_reachable": bool, "local_reachable": bool, "physical_reachable": bool }',
		)
		.option(
			"--evidence <path>",
			'Path to a JSON IncidentEvidence: { "implicated_components": string[], "error_text": string }',
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let advisoryList: SecurityAdvisory[];
			let components: SbomComponent[];
			let exposure: DeploymentExposure;
			let evidence: IncidentEvidence = { implicated_components: [], error_text: "" };
			try {
				advisoryList = readJson(opts.advisories as string) as SecurityAdvisory[];
				components = readJson(opts.sbomComponents as string) as SbomComponent[];
				exposure = readJson(opts.exposure as string) as DeploymentExposure;
				if (opts.evidence) {
					evidence = readJson(opts.evidence as string) as IncidentEvidence;
				}
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = ingestAdvisories(advisoryList, components, exposure, evidence);

			if (opts.render) {
				process.stdout.write(renderAdvisoryIngestReport(report));
			} else {
				outputResult(report as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
