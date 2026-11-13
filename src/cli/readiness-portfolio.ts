/**
 * `failsafe readiness publish` — incident-readiness release portfolio CLI
 * entry point (item 40).
 *
 * Mirrors `advisories.ts` (item 37)/`operator-adjudication.ts` (item 39):
 * read-only, local-file. Reads the seven already-computed dimension reports
 * (telemetry fidelity, attribution, reproducer quality, recovery safety,
 * privacy budget, advisory exposure, drift) and runs the SAME
 * `publishReleaseReadinessPortfolio` path a live release pipeline would
 * call. The signing key is read from the environment, exactly like
 * `release/supply-chain.ts`'s own `signRelease` expects its caller to
 * supply one, never a hardcoded default.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type ReadinessInputs,
	publishReleaseReadinessPortfolio,
	renderReadinessPortfolio,
} from "../release/readiness-portfolio.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

/** Env var holding the readiness-portfolio signing key. Caller-supplied, never hardcoded. */
export const READINESS_SIGNING_KEY_ENV = "FAILSAFE_READINESS_KEY";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerReadinessPortfolioCommand(program: Command): void {
	const readiness = program
		.command("readiness")
		.description("Publish a signed incident-readiness release portfolio");

	readiness
		.command("publish")
		.description(
			"Combine telemetry fidelity, attribution, reproducer quality, recovery safety, privacy, advisory exposure, and drift into a signed promote/hold/rollback verdict",
		)
		.requiredOption("--inputs <path>", "Path to a JSON ReadinessInputs object")
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			const key = process.env[READINESS_SIGNING_KEY_ENV];
			if (!key) {
				outputResult(
					{
						error: true,
						message: `${READINESS_SIGNING_KEY_ENV} is not set; a readiness portfolio cannot be signed`,
					},
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			let inputs: ReadinessInputs;
			try {
				inputs = readJson(opts.inputs as string) as ReadinessInputs;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const result = publishReleaseReadinessPortfolio(inputs, key);

			if (opts.render) {
				process.stdout.write(renderReadinessPortfolio(result));
			} else {
				outputResult(result as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
