/**
 * `failsafe privacy` — privacy-preserving incident sharing CLI entry points
 * (item 28).
 *
 * Mirrors `bundle.ts` (item 49): the HMAC signing key comes from the
 * environment, never a flag, for the same reason (argv ends up in shell
 * history, process listings, and CI logs). Local-file, no network.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { IncidentGraphResult } from "../diagnosis/incident-graph.js";
import {
	type PrivacyBudget,
	releaseNoisyRootCauseCounts,
	shareIncidentEvidence,
} from "../exchange/privacy-sharing.js";
import { mulberry32 } from "../utils/random.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

/** Env var holding the shared HMAC key. Never accepted as a flag. */
export const PRIVACY_KEY_ENV = "FAILSAFE_PRIVACY_KEY";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function requireKey(): string | null {
	const key = process.env[PRIVACY_KEY_ENV];
	return key && key.length > 0 ? key : null;
}

export function registerPrivacySharingCommand(program: Command): void {
	const privacy = program
		.command("privacy")
		.description(
			"Privacy-preserving incident sharing: k-anonymized, selectively disclosed, signed evidence, plus differential-privacy budgeted aggregate stats",
		);

	privacy
		.command("share <chain-id>")
		.description(
			"k-anonymize an incident graph's service field, sign a custody chain over it, and disclose only the exported, anonymized stage",
		)
		.requiredOption("--graph <path>", "Path to an IncidentGraphResult JSON file")
		.option("--key-id <id>", "Identifier for the signing key", "local")
		.option("--k <n>", "Minimum group size for k-anonymity", String(3))
		.option("--out <file>", "Write the disclosure here instead of stdout")
		.option("--format <format>", "Output format: json or text")
		.action(async (chainId: string, opts) => {
			const { store, outOpts } = initCommand(opts);

			const key = requireKey();
			if (!key) {
				outputResult(
					{ error: true, message: `Set ${PRIVACY_KEY_ENV} to sign a shared incident chain.` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			let graph: IncidentGraphResult;
			try {
				graph = readJson(opts.graph as string) as IncidentGraphResult;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read graph: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const disclosure = shareIncidentEvidence(
				chainId,
				new Date().toISOString(),
				graph,
				key,
				opts.keyId as string,
				Number.parseInt(opts.k as string, 10),
				"service",
			);

			if (opts.out) {
				writeFileSync(opts.out as string, `${JSON.stringify(disclosure, null, 2)}\n`);
				outputResult({ status: "exported", file: opts.out }, outOpts);
			} else {
				outputResult(disclosure as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});

	privacy
		.command("aggregate")
		.description(
			"Release Laplace-noised root-cause-kind counts aggregated across several shared incident graphs, gated by a differential-privacy epsilon budget",
		)
		.requiredOption("--graphs <path>", "Path to a JSON array of IncidentGraphResult records")
		.requiredOption("--epsilon <n>", "Epsilon to spend on this release")
		.requiredOption("--budget <path>", "Path to a JSON PrivacyBudget record")
		.option("--seed <n>", "Deterministic noise seed", "1")
		.option("--format <format>", "Output format: json or text")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let graphs: IncidentGraphResult[];
			let budget: PrivacyBudget;
			try {
				graphs = readJson(opts.graphs as string) as IncidentGraphResult[];
				budget = readJson(opts.budget as string) as PrivacyBudget;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const rand = mulberry32(Number.parseInt(opts.seed as string, 10));
			const result = releaseNoisyRootCauseCounts(
				graphs,
				Number.parseFloat(opts.epsilon as string),
				budget,
				rand,
			);

			if (!result.ok) {
				outputResult({ error: true, message: result.message, budget: result.budget }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			outputResult({ noisy_counts: result.noisy_counts, budget: result.budget }, outOpts);
			store.close();
		});
}
