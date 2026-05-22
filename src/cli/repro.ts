import type { Command } from "commander";
import { generateRepro } from "../repro/engine.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureId } from "./shared.js";

export function registerReproCommand(program: Command): void {
	program
		.command("repro <failure-id>")
		.description("Create or identify a minimal reproduction for a failure")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--no-verify", "Skip repro verification (faster but less confident)")
		.option("--timeout <seconds>", "Repro verification timeout", "60")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

			const failureId = resolveFailureId(rawId, store);
			if (!failureId) {
				outputResult({ error: true, message: "No failure found" }, outOpts);
				process.exit(1);
			}

			const failure = store.getFailure(failureId);
			if (!failure) {
				outputResult({ error: true, message: `Failure not found: ${failureId}` }, outOpts);
				process.exit(1);
			}

			const repro = await generateRepro(failure, store, {
				verify: opts.verify !== false,
				timeout_ms: Number.parseInt(opts.timeout, 10) * 1000,
				cwd: failure.cwd,
			});

			const output: Record<string, unknown> = {
				failure_id: failure.failure_id,
				repro_id: repro.repro_id,
				status: repro.status,
				kind: repro.kind,
				command: repro.command,
				confidence: repro.confidence,
				reduction: repro.reduction,
				next: repro.next,
			};

			outputResult(output, outOpts, () => {
				const lines = [
					`[REPRO] ${repro.repro_id} for ${failure.failure_id}`,
					`Status: ${repro.status}`,
					`Command: ${repro.command}`,
					`Confidence: ${Math.round(repro.confidence * 100)}%`,
				];
				if (repro.reduction.original_tests && repro.reduction.repro_tests) {
					lines.push(
						`Reduction: ${repro.reduction.original_tests} tests -> ${repro.reduction.repro_tests} test(s)`,
					);
				}
				return lines.join("\n");
			});
			store.close();
		});
}
