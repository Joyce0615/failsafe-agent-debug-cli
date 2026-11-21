/**
 * `failsafe patch-validation validate` — runtime security patch validation
 * CLI entry point (item 48).
 *
 * Mirrors `canary.ts` (item 29): read-only, local-file, no live replay
 * harness reached over the network. The runner is file-driven — a JSON
 * object of recorded `MatrixRun[]` per arm (`vulnerable`/`patched`), the
 * exact shape `MatrixRunner` needs — so this command runs the SAME
 * `validatePatchAgainstExploit` + `decideExceptionOrUpgrade` path a live
 * exploit-fixture replay harness would call.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { ExploitabilityAssessment } from "../security/advisories.js";
import {
	DEFAULT_MATRIX_REPEATS,
	type MatrixRun,
	decideExceptionOrUpgrade,
	renderPatchDecision,
	validatePatchAgainstExploit,
} from "../security/patch-validation.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

type RecordedRuns = { vulnerable: MatrixRun[]; patched: MatrixRun[] };

export function registerPatchValidationCommand(program: Command): void {
	const patchValidation = program
		.command("patch-validation")
		.description(
			"Replay an exploit fixture against vulnerable and patched dependency matrices and decide upgrade, isolation, or exception",
		);

	patchValidation
		.command("validate")
		.description(
			"Classify a recorded vulnerable/patched exploit-replay matrix as mitigated, not_mitigated, exploit_ineffective, inconsistent, insufficient_repeats, or harness_error, and decide the resulting action",
		)
		.requiredOption(
			"--runs <path>",
			'Path to a JSON object: { "vulnerable": MatrixRun[], "patched": MatrixRun[] }',
		)
		.requiredOption(
			"--assessment <path>",
			"Path to a JSON ExploitabilityAssessment object (security/advisories.ts)",
		)
		.option("--repeats <n>", "Repetitions expected per arm", String(DEFAULT_MATRIX_REPEATS))
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			let runs: RecordedRuns;
			let assessment: ExploitabilityAssessment;
			try {
				runs = readJson(opts.runs as string) as RecordedRuns;
				assessment = readJson(opts.assessment as string) as ExploitabilityAssessment;
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const repeats = Number(opts.repeats) || DEFAULT_MATRIX_REPEATS;
			let vulnerableCalls = 0;
			let patchedCalls = 0;
			const validation = await validatePatchAgainstExploit((arm) => {
				if (arm === "vulnerable") {
					const run = runs.vulnerable[vulnerableCalls];
					vulnerableCalls++;
					return run ?? { outcome: "error", detail: "no recorded run available" };
				}
				const run = runs.patched[patchedCalls];
				patchedCalls++;
				return run ?? { outcome: "error", detail: "no recorded run available" };
			}, repeats);

			const decision = decideExceptionOrUpgrade(validation, assessment);

			if (opts.render) {
				process.stdout.write(renderPatchDecision(decision));
			} else {
				outputResult(decision as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
