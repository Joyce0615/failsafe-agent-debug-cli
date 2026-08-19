/**
 * Scrubbed diagnostic bundle exchange (item 49).
 *
 * AgentDebugX reuses sanitized failure/diagnosis/repair bundles across
 * workspaces. Sharing debugging knowledge between projects is genuinely useful
 * and genuinely dangerous: a bundle is assembled from command output, file
 * paths, and diffs, which is exactly where credentials, customer identifiers,
 * and internal topology live. So the exchange rules are defined *before* any
 * import or export path exists:
 *
 * - **Consent is explicit and per-section.** A bundle carries a consent record
 *   naming who granted it, when, what it covers (`failure`, `diagnosis`,
 *   `repair`), and when it expires. Export refuses to include a section the
 *   consent does not cover; import refuses a bundle whose consent has lapsed.
 * - **Scrubbing happens at build time, and is re-checked at import.** Absolute
 *   paths are made workspace-relative, the workspace itself becomes a salted
 *   hash, raw output never travels, and every string is secret-redacted. A
 *   bundle that still trips a secret pattern is rejected at *both* ends —
 *   trusting the sender's scrubbing is not a security model.
 * - **Signatures are over canonical JSON.** HMAC-SHA256 over a
 *   deterministically key-sorted encoding, so re-serialization cannot
 *   invalidate a signature and field reordering cannot smuggle a change past
 *   one.
 * - **Deduplication is by content fingerprint**, not bundle id, so the same
 *   finding re-shared under a new id does not count twice — which matters
 *   because corroboration feeds trust.
 * - **Trust is scored, not assumed**: signature validity, consent validity,
 *   whether the signing key is known, corroboration by *distinct* origins, age
 *   decay, and the scrub re-check. Import applies a threshold and explains every
 *   rejection.
 *
 * Pure apart from `node:crypto` hashing; no fs, network, or clock (timestamps
 * are passed in) so exchange behavior is fully reproducible in tests.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "../security/redaction.js";

export const BUNDLE_SCHEMA_VERSION = "0.1";

export const BUNDLE_SECTIONS = ["failure", "diagnosis", "repair"] as const;
export const BundleSectionSchema = z.enum(BUNDLE_SECTIONS);
export type BundleSection = z.infer<typeof BundleSectionSchema>;

export const ConsentSchema = z.object({
	granted: z.boolean(),
	/** Sections the grantor agreed to share. */
	scope: z.array(BundleSectionSchema).default([]),
	/** Who granted it — a team or account identifier, never a person's name. */
	grantor: z.string().min(1),
	granted_at: z.string().min(1),
	/** ISO timestamp after which the grant no longer applies. */
	expires_at: z.string().optional(),
});
export type Consent = z.infer<typeof ConsentSchema>;

export const SignatureSchema = z.object({
	algorithm: z.literal("hmac-sha256"),
	/** Identifies the key without revealing it. */
	key_id: z.string().min(1),
	value: z.string().min(1),
});
export type BundleSignature = z.infer<typeof SignatureSchema>;

export const DiagnosticBundleSchema = z.object({
	schema_version: z.literal(BUNDLE_SCHEMA_VERSION),
	bundle_id: z.string().min(1),
	created_at: z.string().min(1),
	/** Salted hash of the originating workspace — correlatable, not identifying. */
	origin: z.object({ workspace_hash: z.string().min(1), tool_version: z.string().min(1) }),
	consent: ConsentSchema,
	failure: z
		.object({
			signature_hash: z.string().min(1),
			failure_type: z.string().min(1),
			/** Message with literals and paths normalized away. */
			normalized_message: z.string(),
			/** Repo-relative, never absolute. */
			location: z.string().optional(),
		})
		.optional(),
	diagnosis: z
		.object({
			category: z.string().min(1),
			explanation: z.string(),
			confidence: z.number().min(0).max(1),
		})
		.optional(),
	repair: z
		.object({
			summary: z.string(),
			/** Files touched, repo-relative. */
			files: z.array(z.string()).default([]),
			verified: z.boolean().default(false),
		})
		.optional(),
	signature: SignatureSchema.optional(),
});
export type DiagnosticBundle = z.infer<typeof DiagnosticBundleSchema>;

/**
 * Deterministic JSON encoding: object keys sorted at every depth.
 *
 * A signature over `JSON.stringify` output would break the moment a producer
 * emitted fields in a different order — and, worse, would let a consumer
 * reorder fields to make a modified bundle verify.
 */
export function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** Salted hash of a workspace path. Correlatable across bundles, not reversible. */
export function workspaceHash(path: string, salt: string): string {
	return createHash("sha256").update(`${salt}\u0000${path}`).digest("hex").slice(0, 32);
}

/** Canonical bytes a signature covers: everything except the signature itself. */
function signablePayload(bundle: DiagnosticBundle): string {
	const { signature: _signature, ...rest } = bundle;
	return canonicalize(rest);
}

export function signBundle(bundle: DiagnosticBundle, key: string, keyId: string): DiagnosticBundle {
	const value = createHmac("sha256", key).update(signablePayload(bundle)).digest("hex");
	return { ...bundle, signature: { algorithm: "hmac-sha256", key_id: keyId, value } };
}

/** Constant-time signature check. Returns false for an unsigned bundle. */
export function verifyBundle(bundle: DiagnosticBundle, key: string): boolean {
	if (!bundle.signature) return false;
	const expected = createHmac("sha256", key).update(signablePayload(bundle)).digest("hex");
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(bundle.signature.value, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Content fingerprint used for deduplication and corroboration.
 *
 * Keyed on the finding, not the bundle: the same failure/diagnosis/repair
 * re-shared under a new `bundle_id` must not count as independent
 * corroboration, or trust becomes trivially inflatable by re-sending.
 */
export function bundleFingerprint(bundle: DiagnosticBundle): string {
	return createHash("sha256")
		.update(
			canonicalize({
				failure: bundle.failure?.signature_hash,
				category: bundle.diagnosis?.category,
				repair: bundle.repair?.summary,
			}),
		)
		.digest("hex")
		.slice(0, 32);
}

export type ScrubIssue = { field: string; problem: string };

/**
 * Re-check a bundle for things that must never travel.
 *
 * Run at export *and* at import. Trusting the sender to have scrubbed correctly
 * would make the whole exchange only as safe as its least careful participant.
 */
export function scrubIssues(bundle: DiagnosticBundle): ScrubIssue[] {
	const issues: ScrubIssue[] = [];
	const check = (field: string, text: string | undefined): void => {
		if (text === undefined) return;
		if (redactSecrets(text).matched.length > 0) {
			issues.push({ field, problem: "contains a value matching a secret pattern" });
		}
		if (/(^|\s)(?:\/(?:Users|home|root|var|etc)\/|[A-Za-z]:\\)/.test(text)) {
			issues.push({ field, problem: "contains an absolute filesystem path" });
		}
	};

	check("failure.normalized_message", bundle.failure?.normalized_message);
	check("failure.location", bundle.failure?.location);
	check("diagnosis.explanation", bundle.diagnosis?.explanation);
	check("repair.summary", bundle.repair?.summary);
	for (const [i, file] of (bundle.repair?.files ?? []).entries()) {
		check(`repair.files[${i}]`, file);
	}
	return issues;
}

export type ConsentIssue = { section: BundleSection | "bundle"; problem: string };

/**
 * Check consent covers every section actually present, and has not lapsed.
 *
 * `now` is a parameter so expiry behavior is deterministic in tests, and so a
 * consumer cannot accidentally accept a lapsed grant because its own clock is
 * behind.
 */
export function consentIssues(bundle: DiagnosticBundle, now: string): ConsentIssue[] {
	const issues: ConsentIssue[] = [];
	const consent = bundle.consent;
	if (!consent.granted) {
		issues.push({ section: "bundle", problem: "consent was not granted" });
	}
	const scope = new Set(consent.scope);
	for (const section of BUNDLE_SECTIONS) {
		if (bundle[section] !== undefined && !scope.has(section)) {
			issues.push({ section, problem: "section present but not covered by consent scope" });
		}
	}
	if (consent.expires_at !== undefined) {
		const expires = Date.parse(consent.expires_at);
		const current = Date.parse(now);
		if (Number.isFinite(expires) && Number.isFinite(current) && current > expires) {
			issues.push({ section: "bundle", problem: `consent expired at ${consent.expires_at}` });
		}
	}
	return issues;
}

export type BuildInput = {
	bundle_id: string;
	created_at: string;
	workspace: string;
	/** Salt for the workspace hash; a stable per-org secret. */
	salt: string;
	tool_version: string;
	consent: Consent;
	failure?: {
		signature_hash: string;
		failure_type: string;
		message: string;
		location?: string;
	};
	diagnosis?: { category: string; explanation: string; confidence: number };
	repair?: { summary: string; files?: string[]; verified?: boolean };
};

/** Strip an absolute prefix and normalize separators so paths are repo-relative. */
export function relativize(path: string, workspace: string): string {
	let out = path;
	if (workspace.length > 0 && out.startsWith(workspace)) {
		out = out.slice(workspace.length);
	}
	return out.replace(/^[/\\]+/, "");
}

/**
 * Normalize a message so it groups across workspaces: redact secrets, strip
 * absolute paths, and replace volatile literals (hex ids, long numbers,
 * quoted values) that would otherwise make every bundle unique.
 */
export function normalizeMessage(message: string, workspace: string): string {
	let out = redactSecrets(message).redacted;
	if (workspace.length > 0) out = out.split(workspace).join("");
	return out
		.replace(/(?:\/(?:Users|home|root)\/[^\s:'"]+)/g, "<path>")
		.replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
		.replace(/\b[0-9a-f]{16,}\b/gi, "<hash>")
		.replace(/\b\d{4,}\b/g, "<num>")
		.trim();
}

export type BuildResult = { ok: true; bundle: DiagnosticBundle } | { ok: false; refused: string[] };

/**
 * Build a scrubbed bundle, refusing rather than trimming when consent does not
 * cover a section the caller asked to include.
 *
 * Silently dropping an unconsented section would be friendlier and worse: the
 * caller would believe they shared something they did not, and would not be
 * told to go get consent.
 */
export function buildBundle(input: BuildInput): BuildResult {
	const refused: string[] = [];
	const scope = new Set(input.consent.scope);
	if (!input.consent.granted) refused.push("consent was not granted");
	for (const section of BUNDLE_SECTIONS) {
		if (input[section] !== undefined && !scope.has(section)) {
			refused.push(`'${section}' requested but not covered by consent scope`);
		}
	}
	if (refused.length > 0) return { ok: false, refused };

	const bundle: DiagnosticBundle = DiagnosticBundleSchema.parse({
		schema_version: BUNDLE_SCHEMA_VERSION,
		bundle_id: input.bundle_id,
		created_at: input.created_at,
		origin: {
			workspace_hash: workspaceHash(input.workspace, input.salt),
			tool_version: input.tool_version,
		},
		consent: input.consent,
		...(input.failure
			? {
					failure: {
						signature_hash: input.failure.signature_hash,
						failure_type: input.failure.failure_type,
						normalized_message: normalizeMessage(input.failure.message, input.workspace),
						...(input.failure.location
							? { location: relativize(input.failure.location, input.workspace) }
							: {}),
					},
				}
			: {}),
		...(input.diagnosis
			? {
					diagnosis: {
						category: input.diagnosis.category,
						explanation: normalizeMessage(input.diagnosis.explanation, input.workspace),
						confidence: input.diagnosis.confidence,
					},
				}
			: {}),
		...(input.repair
			? {
					repair: {
						summary: normalizeMessage(input.repair.summary, input.workspace),
						files: (input.repair.files ?? []).map((f) => relativize(f, input.workspace)),
						verified: input.repair.verified ?? false,
					},
				}
			: {}),
	});

	const issues = scrubIssues(bundle);
	if (issues.length > 0) {
		return { ok: false, refused: issues.map((i) => `${i.field}: ${i.problem}`) };
	}
	return { ok: true, bundle };
}

export type TrustFactors = {
	signature_valid: boolean;
	key_known: boolean;
	consent_valid: boolean;
	scrub_clean: boolean;
	/** Distinct origins reporting the same fingerprint, including this one. */
	corroborating_origins: number;
	/** Days since the bundle was created. */
	age_days: number;
};

export type TrustAssessment = {
	score: number;
	factors: TrustFactors;
	/** Every factor that reduced the score, in plain language. */
	reasons: string[];
};

/** Bundles below this are not imported by default. */
export const DEFAULT_MIN_TRUST = 0.6;
/** Age at which a bundle's contribution has decayed by half. */
export const TRUST_HALF_LIFE_DAYS = 180;

export type TrustOptions = {
	/** Key ids the importer recognizes. */
	known_key_ids?: string[];
	/** Fingerprint -> distinct origin hashes already seen. */
	corroboration?: Map<string, Set<string>>;
	now: string;
	key?: string;
};

/**
 * Score a bundle's trustworthiness.
 *
 * A bad signature or lapsed consent is disqualifying, not merely a deduction —
 * a bundle that cannot be authenticated has no claim on trust regardless of how
 * plausible its contents are. Everything else is a weighted contribution, and
 * corroboration is counted by *distinct origin*, so one enthusiastic workspace
 * cannot vote repeatedly.
 */
export function assessTrust(bundle: DiagnosticBundle, opts: TrustOptions): TrustAssessment {
	const reasons: string[] = [];
	const signatureValid = opts.key !== undefined ? verifyBundle(bundle, opts.key) : false;
	const keyKnown =
		bundle.signature !== undefined && (opts.known_key_ids ?? []).includes(bundle.signature.key_id);
	const consentOk = consentIssues(bundle, opts.now).length === 0;
	const scrubClean = scrubIssues(bundle).length === 0;

	const fingerprint = bundleFingerprint(bundle);
	const origins = new Set(opts.corroboration?.get(fingerprint) ?? []);
	origins.add(bundle.origin.workspace_hash);
	const corroborating = origins.size;

	const createdAt = Date.parse(bundle.created_at);
	const now = Date.parse(opts.now);
	const ageDays =
		Number.isFinite(createdAt) && Number.isFinite(now)
			? Math.max(0, (now - createdAt) / 86_400_000)
			: 0;

	const factors: TrustFactors = {
		signature_valid: signatureValid,
		key_known: keyKnown,
		consent_valid: consentOk,
		scrub_clean: scrubClean,
		corroborating_origins: corroborating,
		age_days: ageDays,
	};

	if (!signatureValid) {
		reasons.push(
			bundle.signature
				? "signature does not verify against the importer's key"
				: "bundle is unsigned",
		);
		return { score: 0, factors, reasons };
	}
	if (!consentOk) {
		reasons.push("consent is missing, lapsed, or does not cover the sections present");
		return { score: 0, factors, reasons };
	}
	if (!scrubClean) {
		reasons.push("bundle failed the importer's own scrub re-check");
		return { score: 0, factors, reasons };
	}

	// Base credit for an authenticated, consented, clean bundle.
	let score = 0.5;
	if (keyKnown) score += 0.2;
	else reasons.push("signing key id is not on the importer's known-key list");

	// Corroboration: each additional distinct origin adds less than the last.
	const extra = Math.max(0, corroborating - 1);
	score += 0.3 * (1 - 0.5 ** extra);
	if (extra === 0) reasons.push("no corroboration from another origin");

	const decay = 0.5 ** (ageDays / TRUST_HALF_LIFE_DAYS);
	if (decay < 1) {
		reasons.push(`bundle is ${ageDays.toFixed(0)} day(s) old; age decay applied`);
	}
	score *= decay;

	return { score: Math.min(1, Math.max(0, score)), factors, reasons };
}

export type ImportDecision = {
	bundle_id: string;
	fingerprint: string;
	accepted: boolean;
	trust: TrustAssessment;
	/** Set when rejected or deduplicated. */
	reason?: string;
};

export type ImportResult = {
	accepted: DiagnosticBundle[];
	decisions: ImportDecision[];
	/** Fingerprint -> distinct origins, updated with everything accepted. */
	corroboration: Map<string, Set<string>>;
};

/**
 * Apply the import gate to a batch.
 *
 * Order matters: bundles are processed in the order given, and a duplicate
 * fingerprint from a *new* origin still updates corroboration (it is evidence)
 * without being imported twice (it is not new knowledge).
 */
export function importBundles(
	bundles: DiagnosticBundle[],
	opts: TrustOptions & { min_trust?: number },
): ImportResult {
	const minTrust = opts.min_trust ?? DEFAULT_MIN_TRUST;
	const corroboration = new Map<string, Set<string>>();
	for (const [key, value] of opts.corroboration ?? []) {
		corroboration.set(key, new Set(value));
	}

	const accepted: DiagnosticBundle[] = [];
	const decisions: ImportDecision[] = [];
	const importedFingerprints = new Set<string>();

	for (const bundle of bundles) {
		const fingerprint = bundleFingerprint(bundle);
		const trust = assessTrust(bundle, { ...opts, corroboration });

		if (trust.score < minTrust) {
			decisions.push({
				bundle_id: bundle.bundle_id,
				fingerprint,
				accepted: false,
				trust,
				reason: `trust ${trust.score.toFixed(2)} below the ${minTrust} threshold: ${trust.reasons.join("; ")}`,
			});
			continue;
		}

		// Record the origin before the dedupe check: a second workspace reporting
		// the same finding is corroboration even though it is not new knowledge.
		const origins = corroboration.get(fingerprint) ?? new Set<string>();
		origins.add(bundle.origin.workspace_hash);
		corroboration.set(fingerprint, origins);

		if (importedFingerprints.has(fingerprint)) {
			decisions.push({
				bundle_id: bundle.bundle_id,
				fingerprint,
				accepted: false,
				trust,
				reason: "duplicate of a bundle already imported in this batch",
			});
			continue;
		}

		importedFingerprints.add(fingerprint);
		accepted.push(bundle);
		decisions.push({ bundle_id: bundle.bundle_id, fingerprint, accepted: true, trust });
	}

	return { accepted, decisions, corroboration };
}
