import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const FailsafeConfigSchema = z.object({
	schema_version: z.literal("0.1"),
	default_format: z.enum(["json", "text"]).default("json"),
	storage_dir: z.string().default(".failsafe"),
	timeouts: z
		.object({
			run_seconds: z.number().default(120),
			debug_launch_seconds: z.number().default(30),
			step_seconds: z.number().default(10),
		})
		.default({}),
	debug_adapters: z
		.object({
			python: z.object({ type: z.string().default("debugpy") }).default({}),
			node: z.object({ type: z.string().default("node-inspector") }).default({}),
		})
		.default({}),
	token_budget: z
		.object({
			max_output_bytes: z.number().default(6000),
			include_raw_paths: z.boolean().default(true),
		})
		.default({}),
	security: z
		.object({
			redact_env: z.boolean().default(true),
			allow_mutating_eval: z.boolean().default(false),
			allow_commands: z
				.array(z.string())
				.default([
					"npm",
					"npx",
					"bun",
					"bunx",
					"node",
					"python",
					"python3",
					"pytest",
					"cargo",
					"go",
					"jest",
					"vitest",
					"tsc",
					"eslint",
					"biome",
					"make",
				]),
			deny_patterns: z
				.array(z.string())
				.default(["rm -rf /", "rm -rf /*", "curl.*|.*sh", "sudo", "> /dev/sd"]),
			timeout_seconds: z.number().default(120),
		})
		.default({}),
	rules: z
		.object({
			rules_file: z.string().default(".failsafe/rules.yaml"),
			auto_learn: z.boolean().default(true),
			promotion_threshold: z
				.object({
					min_occurrences: z.number().int().default(5),
					min_success_rate: z.number().default(0.8),
					min_distinct_files: z.number().int().default(2),
				})
				.default({}),
			staleness_days: z.number().int().default(90),
			flaky_recurrence_threshold: z.number().int().default(3),
		})
		.default({}),
});
export type FailsafeConfig = z.infer<typeof FailsafeConfigSchema>;

export const DEFAULT_CONFIG: FailsafeConfig = FailsafeConfigSchema.parse({
	schema_version: "0.1",
});

/**
 * Resolve filesystem paths for a workspace.
 *
 * Config is ANCHORED at `<cwd>/.failsafe/config.json` — a fixed bootstrap
 * location that does not move when `storage_dir` changes. This is where
 * `loadConfig()`, `init`, and `config show/set` always read and write.
 *
 * Storage (runs, history db, code index) follows `config.storage_dir`,
 * which may be absolute or relative to cwd. This lets a team relocate
 * captured data (e.g. to a shared cache) without losing the config anchor.
 */
export function resolveConfigPaths(cwd: string, config: FailsafeConfig) {
	// Fixed config anchor — never moves with storage_dir. Use platform-native
	// joins so local-filesystem paths are correct on Windows as well as POSIX.
	const configDir = join(cwd, ".failsafe");
	const configFile = join(configDir, "config.json");

	// Storage location — controlled by storage_dir, which may be absolute
	// (including a Windows drive path like `C:\cache`) or relative to cwd.
	const storageDir = isAbsolute(config.storage_dir)
		? config.storage_dir
		: join(cwd, config.storage_dir);

	return {
		configDir,
		configFile,
		storageDir,
		runsDir: join(storageDir, "runs"),
		historyDb: join(storageDir, "history.sqlite"),
		codeIndexDir: join(storageDir, "code-index"),
	};
}
