import type { Command } from "commander";
import { computeSignature } from "../repro/signatures.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

export function registerHistoryCommand(program: Command): void {
	program
		.command("history")
		.description("Show prior failures and whether they were resolved")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.option("--similar <failure-id>", "Find failures similar to this one")
		.option("--limit <n>", "Max failures to show", "10")
		.action(async (opts) => {
			const { store, outOpts } = initCommand(opts);

			if (opts.similar) {
				const { failureId, failure } = resolveFailureOrExit(opts.similar, store, outOpts);

				const allErrors = failure.parsed.flatMap((p) => p.errors);
				const signature = computeSignature(allErrors, failure.primary_location);
				const similar = store.findSimilarFailures(signature);

				outputResult(
					{
						query_failure_id: failureId,
						similar_failures: similar,
					},
					outOpts,
					() => {
						if (similar.length === 0) return "No similar failures found.";
						const lines = [`Similar failures to ${failureId}:`];
						for (const s of similar) {
							lines.push(`  ${s.failure_id} (similarity: ${Math.round(s.similarity * 100)}%)`);
						}
						return lines.join("\n");
					},
				);
			} else {
				const limit = Number.parseInt(opts.limit, 10);
				const failures = store.listFailures({ limit });

				outputResult(
					{
						failures: failures.map((f) => ({
							failure_id: f.failure_id,
							created_at: f.created_at,
							status: f.status,
							command: f.command,
							summary: f.parsed[0]?.errors[0]?.message ?? "Unknown",
							primary_location: f.primary_location,
						})),
					},
					outOpts,
					() => {
						if (failures.length === 0) return "No failures recorded.";
						const lines = ["Recent failures:"];
						for (const f of failures) {
							lines.push(
								`  [${f.status}] ${f.failure_id} — ${f.parsed[0]?.errors[0]?.message?.substring(0, 80) ?? "Unknown"}`,
							);
						}
						return lines.join("\n");
					},
				);
			}

			store.close();
		});
}
