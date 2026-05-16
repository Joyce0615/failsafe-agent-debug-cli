import type { Command } from "commander";
import { diagnose } from "../diagnosis/engine.js";
import { formatDiagnosisText } from "../utils/format.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { createStore, loadConfig, resolveFailureId } from "./shared.js";

export function registerDiagnoseCommand(program: Command): void {
	program
		.command("diagnose <failure-id>")
		.description("Build a structured root-cause hypothesis for a failure")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (rawId: string, opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const maxBytes = opts.maxBytes ? Number.parseInt(opts.maxBytes, 10) : undefined;
			const outOpts = resolveOutputOptions(
				{ ...opts, maxBytes },
				config.default_format,
				config.token_budget.max_output_bytes,
			);

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

			const diagnosis = await diagnose(failure, store, config);
			store.saveDiagnosis(diagnosis);

			outputResult(diagnosis, outOpts, (d) => formatDiagnosisText(d as typeof diagnosis));
			store.close();
		});
}
