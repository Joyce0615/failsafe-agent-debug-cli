import { existsSync, readFileSync } from "node:fs";
import { FailsafeStore } from "../storage/store.js";
import { configureTelemetryCapture } from "../telemetry/capture-policy.js";
import {
	DEFAULT_CONFIG,
	type FailsafeConfig,
	FailsafeConfigSchema,
	resolveConfigPaths,
} from "../types/config.js";
import type { FailureRecord } from "../types/failure.js";
import { ExitCode } from "./exit-codes.js";
import { type OutputOptions, outputResult, resolveOutputOptions } from "./format.js";

/**
 * Load workspace config, and install its telemetry capture policy (item 41).
 *
 * Every CLI command and MCP tool call routes through here, so this is the one
 * place that has to arm the content-capture gate; a command that forgets would
 * otherwise silently fall back to the (safe) default policy rather than the
 * workspace's own.
 */
export function loadConfig(cwd?: string): FailsafeConfig {
	const workDir = cwd ?? process.cwd();
	const configPath = `${workDir}/.failsafe/config.json`;

	if (existsSync(configPath)) {
		try {
			const raw = readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(raw);
			const config = FailsafeConfigSchema.parse(parsed);
			configureTelemetryCapture(config);
			return config;
		} catch {
			// Fall through to default
		}
	}

	configureTelemetryCapture(DEFAULT_CONFIG);
	return DEFAULT_CONFIG;
}

export function createStore(config?: FailsafeConfig, cwd?: string): FailsafeStore {
	const cfg = config ?? loadConfig(cwd);
	return new FailsafeStore(cfg, cwd ?? process.cwd());
}

export function resolveFailureId(idOrLast: string, store: FailsafeStore): string | null {
	if (idOrLast === "--last" || idOrLast === "last") {
		const last = store.getFailure("last");
		return last?.failure_id ?? null;
	}
	return idOrLast;
}

/**
 * Resolve a failure record by id-or-"last", or emit a NO_INPUT error packet
 * and exit. Returns the resolved id and record; never returns on failure.
 */
export function resolveFailureOrExit(
	rawId: string,
	store: FailsafeStore,
	outOpts: OutputOptions,
): { failureId: string; failure: FailureRecord } {
	const failureId = resolveFailureId(rawId, store);
	if (!failureId) {
		outputResult({ error: true, message: "No failure found in history" }, outOpts);
		process.exit(ExitCode.NO_INPUT);
	}
	const failure = store.getFailure(failureId);
	if (!failure) {
		outputResult({ error: true, message: `Failure not found: ${failureId}` }, outOpts);
		process.exit(ExitCode.NO_INPUT);
	}
	return { failureId, failure };
}

/**
 * Shared command initialization: loads config, creates store,
 * resolves output options with config defaults and --max-bytes.
 * Use this in every command handler for consistent behavior.
 */
export function initCommand(opts: {
	format?: string;
	raw?: boolean;
	maxBytes?: string | number;
	quiet?: boolean;
	evidenceOnly?: boolean;
}): { config: FailsafeConfig; store: FailsafeStore; outOpts: OutputOptions } {
	const config = loadConfig();
	const store = createStore(config);
	const maxBytes =
		typeof opts.maxBytes === "string" ? Number.parseInt(opts.maxBytes, 10) : opts.maxBytes;
	const outOpts = resolveOutputOptions(
		{ ...opts, maxBytes },
		config.default_format,
		config.token_budget.max_output_bytes,
	);
	return { config, store, outOpts };
}
