import type { Command } from "commander";
import { diagnose } from "../diagnosis/engine.js";
import { formatDiagnosisText } from "../utils/format.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

export function registerDiagnoseCommand(program: Command): void {
	program
		.command("diagnose <failure-id>")
		.description("Build a structured root-cause hypothesis for a failure")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.option("--evidence-only", "Omit suggested fixes and next actions; keep evidence only")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);

			const { failure } = resolveFailureOrExit(rawId, store, outOpts);

			const diagnosis = await diagnose(failure, store, config);
			store.saveDiagnosis(diagnosis);

			outputResult(diagnosis, outOpts, (d) => formatDiagnosisText(d as typeof diagnosis));
			store.close();
		});
}
