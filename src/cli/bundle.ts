import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type Consent,
	ConsentSchema,
	DEFAULT_MIN_TRUST,
	DiagnosticBundleSchema,
	buildBundle,
	importBundles,
	signBundle,
} from "../exchange/bundle.js";
import { bundleId } from "../utils/id.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

/** Env var holding the shared HMAC key. Never accepted as a flag. */
export const BUNDLE_KEY_ENV = "FAILSAFE_BUNDLE_KEY";
/** Env var holding the per-org salt used to hash workspace paths. */
export const BUNDLE_SALT_ENV = "FAILSAFE_BUNDLE_SALT";

function requireKey(): string | null {
	const key = process.env[BUNDLE_KEY_ENV];
	return key && key.length > 0 ? key : null;
}

function readConsent(path: string): Consent {
	return ConsentSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

/**
 * `failsafe bundle` — scrubbed diagnostic bundle exchange (item 49).
 *
 * The signing key and workspace salt come from the environment, never from a
 * flag: a key in argv ends up in shell history, process listings, and CI logs.
 */
export function registerBundleCommand(program: Command): void {
	const cmd = program
		.command("bundle")
		.description("Export and import scrubbed failure/diagnosis/repair bundles");

	cmd
		.command("export <failure-id>")
		.description("Build, scrub, and sign a shareable bundle for a failure")
		.requiredOption("--consent <file>", "JSON consent record covering the sections to share")
		.option("--key-id <id>", "Identifier for the signing key", "local")
		.option("--out <file>", "Write the bundle here instead of stdout")
		.option("--format <format>", "Output format: json or text")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);

			const key = requireKey();
			if (!key) {
				outputResult({ error: true, message: `Set ${BUNDLE_KEY_ENV} to sign a bundle.` }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			let consent: Consent;
			try {
				consent = readConsent(opts.consent as string);
			} catch (err) {
				outputResult(
					{ error: true, message: `Invalid consent record: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const diagnosis = store.getDiagnosis(failure.failure_id);
			const errors = failure.parsed.flatMap((p) => p.errors);
			const scope = new Set(consent.scope);

			const result = buildBundle({
				bundle_id: bundleId(),
				created_at: new Date().toISOString(),
				workspace: failure.cwd,
				salt: process.env[BUNDLE_SALT_ENV] ?? "failsafe-default-salt",
				tool_version: "0.1.0",
				consent,
				...(scope.has("failure")
					? {
							failure: {
								signature_hash: failure.failure_id,
								failure_type: failure.parsed[0]?.failure_type ?? "unknown",
								message: errors[0]?.message ?? "",
								...(failure.primary_location
									? {
											location: `${failure.primary_location.file}:${failure.primary_location.line}`,
										}
									: {}),
							},
						}
					: {}),
				...(scope.has("diagnosis") && diagnosis?.root_cause
					? {
							diagnosis: {
								category: diagnosis.root_cause.category,
								explanation: diagnosis.root_cause.explanation,
								confidence: diagnosis.root_cause.confidence,
							},
						}
					: {}),
			});

			if (!result.ok) {
				outputResult({ error: true, refused: result.refused }, outOpts);
				store.close();
				process.exit(ExitCode.ERROR);
			}

			const bundle = signBundle(result.bundle, key, opts.keyId as string);
			if (opts.out) {
				writeFileSync(opts.out as string, `${JSON.stringify(bundle, null, 2)}\n`);
				outputResult({ status: "exported", file: opts.out, bundle_id: bundle.bundle_id }, outOpts);
			} else {
				outputResult(bundle as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});

	cmd
		.command("import <file>")
		.description("Verify, score, and admit bundles from another workspace")
		.option("--min-trust <n>", "Reject bundles below this trust score", String(DEFAULT_MIN_TRUST))
		.option("--known-key <id...>", "Key ids this workspace recognizes")
		.option("--format <format>", "Output format: json or text")
		.action(async (file: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			store.close();

			const key = requireKey();
			if (!key) {
				outputResult(
					{ error: true, message: `Set ${BUNDLE_KEY_ENV} to verify bundle signatures.` },
					outOpts,
				);
				process.exit(ExitCode.ERROR);
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(file, "utf-8"));
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read bundles: ${(err as Error).message}` },
					outOpts,
				);
				process.exit(ExitCode.NO_INPUT);
			}

			const rows = Array.isArray(parsed) ? parsed : [parsed];
			const bundles = rows
				.map((row) => DiagnosticBundleSchema.safeParse(row))
				.filter((r) => r.success)
				.map((r) => r.data);
			const malformed = rows.length - bundles.length;

			const result = importBundles(bundles, {
				now: new Date().toISOString(),
				key,
				known_key_ids: (opts.knownKey as string[] | undefined) ?? [],
				min_trust: Number.parseFloat(opts.minTrust as string),
			});

			outputResult(
				{
					accepted: result.accepted.length,
					rejected: result.decisions.filter((d) => !d.accepted).length,
					...(malformed > 0 ? { malformed } : {}),
					decisions: result.decisions,
				},
				outOpts,
			);
		});
}
