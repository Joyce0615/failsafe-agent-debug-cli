import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { DEFAULT_CONFIG, FailsafeConfigSchema, resolveConfigPaths } from "../types/config.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { loadConfig } from "./shared.js";

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize Failsafe in the current directory")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action((opts) => {
			const config = loadConfig();
			const outOpts = resolveOutputOptions(
				opts,
				config.default_format,
				config.token_budget.max_output_bytes,
			);
			const cwd = process.cwd();
			const paths = resolveConfigPaths(cwd, config);

			// Create the config anchor dir and the storage dirs (which may differ)
			mkdirSync(paths.configDir, { recursive: true });
			mkdirSync(paths.storageDir, { recursive: true });
			mkdirSync(paths.runsDir, { recursive: true });

			// Write default config to the fixed anchor if not present
			if (!existsSync(paths.configFile)) {
				writeFileSync(paths.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2));
			}

			outputResult(
				{
					status: "initialized",
					storage_dir: paths.storageDir,
					config_file: paths.configFile,
					message: "Failsafe initialized. Add .failsafe/runs/ to .gitignore.",
				},
				outOpts,
				(d) => {
					const data = d as { storage_dir: string; message: string };
					return `Failsafe initialized at ${data.storage_dir}\n${data.message}`;
				},
			);
		});
}

export function registerConfigCommand(program: Command): void {
	const configCmd = program.command("config").description("View or modify Failsafe configuration");

	configCmd
		.command("show")
		.description("Show current configuration")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action((opts) => {
			const cfgForDefaults = loadConfig();
			const outOpts = resolveOutputOptions(
				opts,
				cfgForDefaults.default_format,
				cfgForDefaults.token_budget.max_output_bytes,
			);
			const cwd = process.cwd();
			const paths = resolveConfigPaths(cwd, DEFAULT_CONFIG);

			let config = DEFAULT_CONFIG;
			if (existsSync(paths.configFile)) {
				try {
					const raw = readFileSync(paths.configFile, "utf-8");
					config = FailsafeConfigSchema.parse(JSON.parse(raw));
				} catch {
					// Fall through to default
				}
			}

			outputResult(config, outOpts, () => JSON.stringify(config, null, 2));
		});

	configCmd
		.command("set <key> <value>")
		.description("Set a configuration value (dot-notation key)")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action((key: string, value: string, opts) => {
			const cfgForDefaults = loadConfig();
			const outOpts = resolveOutputOptions(
				opts,
				cfgForDefaults.default_format,
				cfgForDefaults.token_budget.max_output_bytes,
			);
			const cwd = process.cwd();
			const paths = resolveConfigPaths(cwd, DEFAULT_CONFIG);

			let config: Record<string, unknown> = { ...DEFAULT_CONFIG };
			if (existsSync(paths.configFile)) {
				try {
					const raw = readFileSync(paths.configFile, "utf-8");
					config = JSON.parse(raw);
				} catch {
					// Start from default
				}
			}

			// Set value using dot notation
			const keys = key.split(".");
			let target: Record<string, unknown> = config;
			for (let i = 0; i < keys.length - 1; i++) {
				if (typeof target[keys[i]] !== "object" || target[keys[i]] === null) {
					target[keys[i]] = {};
				}
				target = target[keys[i]] as Record<string, unknown>;
			}

			// Try to parse the value as JSON, fall back to string
			let parsedValue: unknown;
			try {
				parsedValue = JSON.parse(value);
			} catch {
				parsedValue = value;
			}
			target[keys[keys.length - 1]] = parsedValue;

			// Validate
			try {
				FailsafeConfigSchema.parse(config);
			} catch (err) {
				outputResult({ error: true, message: `Invalid configuration: ${err}` }, outOpts);
				process.exit(1);
			}

			mkdirSync(paths.storageDir, { recursive: true });
			writeFileSync(paths.configFile, JSON.stringify(config, null, 2));

			outputResult(
				{ status: "updated", key, value: parsedValue },
				outOpts,
				() => `Set ${key} = ${JSON.stringify(parsedValue)}`,
			);
		});
}
