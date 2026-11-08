/**
 * `failsafe memory-retrieve` — privacy-safe debugging memory retrieval CLI
 * entry point (item 34).
 *
 * Mirrors `trace-gaps.ts` (item 32)/`drift.ts` (item 30): read-only,
 * local-file. Reads already-computed inputs (a JSON array of
 * `MemoryCandidate` — `{ bundle: DiagnosticBundle, tenant: string }` — plus
 * a `TenantQuery` and usage history) and runs the SAME
 * `retrievePrivacySafeMemory` path a live memory index would call. The HMAC
 * verification key comes from the environment, never a flag, mirroring
 * `bundle.ts`/`privacy-sharing.ts`.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { BundleUsageOutcome, MemoryCandidate } from "../memory/bundle-retrieval.js";
import { retrievePrivacySafeMemory } from "../memory/bundle-retrieval.js";
import type { TenantQuery } from "../storage/governance.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

/** Env var holding the shared HMAC key used to verify retrieved bundles. */
export const MEMORY_RETRIEVAL_KEY_ENV = "FAILSAFE_BUNDLE_KEY";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function requireKey(): string | null {
	const key = process.env[MEMORY_RETRIEVAL_KEY_ENV];
	return key && key.length > 0 ? key : null;
}

export function registerMemoryRetrievalCommand(program: Command): void {
	program
		.command("memory-retrieve")
		.description(
			"Privacy-safe debugging memory retrieval: tenant-isolated, trust-gated, applicability-evidenced bundle lookup with retrieval-lift vs. negative-transfer measurement",
		)
		.requiredOption("--candidates <path>", "Path to a JSON array of MemoryCandidate")
		.option("--tenant <id>", "Tenant to scope the query to")
		.option(
			"--cross-tenant <authorized_by:reason>",
			"Explicit cross-tenant authorization, as 'authorized_by:reason'",
		)
		.option(
			"--usage <path>",
			"Path to a JSON object mapping bundle fingerprint -> BundleUsageOutcome[]",
		)
		.option("--baseline <n>", "No-retrieval baseline success rate, for lift measurement")
		.option("--min-trust <n>", "Reject bundles below this trust score")
		.option("--stale-after-ms <n>", "Override the governed exchange_bundle TTL for staleness")
		.option("--known-key <id...>", "Key ids this workspace recognizes")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			const key = requireKey();
			if (!key) {
				outputResult(
					{ error: true, message: `Set ${MEMORY_RETRIEVAL_KEY_ENV} to verify retrieved bundles.` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			let candidates: MemoryCandidate[];
			try {
				candidates = readJson(opts.candidates as string) as MemoryCandidate[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read candidates: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			let usage: Map<string, BundleUsageOutcome[]> | undefined;
			if (opts.usage) {
				try {
					const raw = readJson(opts.usage as string) as Record<string, BundleUsageOutcome[]>;
					usage = new Map(Object.entries(raw));
				} catch (err) {
					outputResult(
						{ error: true, message: `Failed to read usage: ${(err as Error).message}` },
						outOpts,
					);
					store.close();
					process.exit(ExitCode.NO_INPUT);
				}
			}

			const query: TenantQuery = {};
			if (opts.tenant) query.tenant = opts.tenant as string;
			if (opts.crossTenant) {
				const [authorizedBy, reason] = (opts.crossTenant as string).split(":");
				query.cross_tenant = { authorized_by: authorizedBy ?? "", reason: reason ?? "" };
			}

			const result = retrievePrivacySafeMemory(candidates, query, {
				now_ms: Date.now(),
				trust: {
					now: new Date().toISOString(),
					key,
					known_key_ids: (opts.knownKey as string[] | undefined) ?? [],
				},
				...(opts.minTrust ? { min_trust: Number.parseFloat(opts.minTrust as string) } : {}),
				...(opts.staleAfterMs
					? { stale_after_ms: Number.parseInt(opts.staleAfterMs as string, 10) }
					: {}),
				...(usage ? { usage } : {}),
				...(opts.baseline
					? { baseline_success_rate: Number.parseFloat(opts.baseline as string) }
					: {}),
			});

			if (!result.ok) {
				outputResult({ error: true, message: result.reason }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			outputResult(
				{
					scope: result.scope,
					retrieved: result.retrieved.length,
					rejected: result.rejected.length,
					entries: result.retrieved,
					refusals: result.rejected,
				},
				outOpts,
			);
			store.close();
		});
}
