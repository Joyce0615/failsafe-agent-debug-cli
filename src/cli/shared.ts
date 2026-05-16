import { existsSync, readFileSync } from "node:fs";
import { FailsafeStore } from "../storage/store.js";
import {
	DEFAULT_CONFIG,
	type FailsafeConfig,
	FailsafeConfigSchema,
	resolveConfigPaths,
} from "../types/config.js";

export function loadConfig(cwd?: string): FailsafeConfig {
	const workDir = cwd ?? process.cwd();
	const configPath = `${workDir}/.failsafe/config.json`;

	if (existsSync(configPath)) {
		try {
			const raw = readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(raw);
			return FailsafeConfigSchema.parse(parsed);
		} catch {
			// Fall through to default
		}
	}

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
