import type { Command } from "commander";
import {
	buildProjectIndex,
	refreshProjectIndex,
	retrieveContext,
} from "../memory/project-index.js";
import { loadProjectIndex, queryFromFailure, saveProjectIndex } from "../memory/store.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

/** Resolve the configured index path against the working directory. */
function indexPath(indexFile: string): string {
	return indexFile.startsWith("/") ? indexFile : `${process.cwd()}/${indexFile}`;
}

/**
 * `failsafe memory` — build/refresh/query the opt-in project-context index
 * (item 36). Nothing here runs implicitly; diagnosis only consults the index
 * when `memory.enabled` is set in config.
 */
export function registerMemoryCommand(program: Command): void {
	const memory = program
		.command("memory")
		.description("Project-context memory index for fault localization");

	memory
		.command("build")
		.description("Build (or rebuild) the project index")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action(async (opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const path = indexPath(config.memory.index_file);
			const index = buildProjectIndex(process.cwd(), { maxFiles: config.memory.max_files });
			saveProjectIndex(path, index);
			outputResult(
				{
					status: "built",
					index_file: path,
					version: index.version,
					indexed_files: index.entries.length,
					skipped: index.skipped.length,
					// Secret-ish paths are never indexed; report the count so the
					// exclusion is auditable without naming the files.
					skipped_secret: index.skipped.filter((s) => s.reason === "secret").length,
					enabled: config.memory.enabled,
				},
				outOpts,
			);
			store.close();
		});

	memory
		.command("refresh")
		.description("Re-hash indexed files and rebuild only what changed")
		.option("--format <format>", "Output format: json or text")
		.action(async (opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const path = indexPath(config.memory.index_file);
			const existing = loadProjectIndex(path);
			if (!existing) {
				outputResult({ error: true, message: `No project index at ${path}` }, outOpts);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			const { index, changed, removed } = refreshProjectIndex(existing);
			saveProjectIndex(path, index);
			outputResult(
				{
					status: "refreshed",
					index_file: path,
					changed,
					removed,
					indexed_files: index.entries.length,
				},
				outOpts,
			);
			store.close();
		});

	memory
		.command("status")
		.description("Show the current project index summary")
		.option("--format <format>", "Output format: json or text")
		.action(async (opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const path = indexPath(config.memory.index_file);
			const index = loadProjectIndex(path);
			outputResult(
				index
					? {
							status: "present",
							index_file: path,
							version: index.version,
							built_at: index.built_at,
							indexed_files: index.entries.length,
							test_files: index.entries.filter((e) => e.is_test).length,
							enabled: config.memory.enabled,
						}
					: { status: "absent", index_file: path, enabled: config.memory.enabled },
				outOpts,
			);
			store.close();
		});

	memory
		.command("query <failure-id>")
		.description("Show what the index would retrieve for a failure")
		.option("--format <format>", "Output format: json or text")
		.option("--budget <bytes>", "Retrieval byte budget")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const path = indexPath(config.memory.index_file);
			const index = loadProjectIndex(path);
			if (!index) {
				outputResult({ error: true, message: `No project index at ${path}` }, outOpts);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);
			const errors = failure.parsed.flatMap((p) => p.errors);
			const budget = opts.budget
				? Number.parseInt(opts.budget as string, 10)
				: config.memory.retrieval_budget_bytes;
			const result = retrieveContext(
				index,
				queryFromFailure(errors, failure.primary_location),
				budget,
			);
			outputResult({ failure_id: failure.failure_id, ...result }, outOpts);
			store.close();
		});
}
