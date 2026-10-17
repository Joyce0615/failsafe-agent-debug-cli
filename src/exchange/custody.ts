/**
 * Signed chain of custody: hash evidence, transformations, redactions,
 * analysis, and exports; verify selective disclosure (item 85).
 *
 * `exchange/bundle.ts` (item 49) signs the *final* scrubbed bundle. That
 * proves the bundle was not altered after signing; it proves nothing about
 * what happened *before* signing -- which raw evidence was collected, what
 * normalization/redaction stripped out, what the diagnosis actually said
 * before it was summarized, and which export format a given finding ended up
 * in. A reviewer who only ever sees the final bundle has no way to tell "this
 * redaction removed one email address" from "this redaction removed the one
 * piece of evidence that would have overturned the diagnosis".
 *
 * This module builds a tamper-evident **hash chain** over every pipeline
 * stage a piece of evidence passes through on its way to being shared:
 *
 *   evidence -> transformation -> redaction -> analysis -> export
 *
 * Each record's `link_hash` folds in the previous record's `link_hash`, so
 * reordering, dropping, or inserting a record changes every link_hash after
 * it -- the same construction a Merkle/blockchain hash chain uses, scoped to
 * a single linear pipeline rather than a tree, because custody here is
 * sequential (an export happens after the analysis it exports, which happens
 * after the redaction it analyzed).
 *
 * **The signature covers hashes, never raw content.** `signCustodyChain`
 * signs `{records: [{stage, label, content_hash, link_hash}], root_hash}` --
 * the content itself (the actual evidence text, the actual redacted string)
 * is kept out of the signed payload entirely. This is what makes selective
 * disclosure possible without re-signing: a holder can hand a verifier the
 * signed manifest plus the *content* for only the stages they choose to
 * reveal, and the verifier can confirm (a) the revealed content's hash
 * matches what the signed chain already committed to, and (b) every stage --
 * revealed or not -- is accounted for, so dropping an inconvenient stage
 * silently is detectable as a missing record, not a smaller chain.
 *
 * Pure apart from `node:crypto` hashing/HMAC; no fs, network, or clock
 * (timestamps are caller-supplied) so chain construction and verification are
 * fully reproducible in tests.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CUSTODY_STAGES = [
	"evidence",
	"transformation",
	"redaction",
	"analysis",
	"export",
] as const;
export type CustodyStage = (typeof CUSTODY_STAGES)[number];

export const CUSTODY_SCHEMA_VERSION = "0.1";

/** Deterministic JSON encoding: object keys sorted at every depth. */
export function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Hash of a stage's actual content, independent of its position in the chain. */
export function contentHash(content: unknown): string {
	return sha256(canonicalize(content));
}

export type CustodyInput = {
	stage: CustodyStage;
	/** Human-readable identifier for this specific step, e.g. "redact-pass-1". */
	label: string;
	/** The actual content at this stage. Hashed, never itself signed. */
	content: unknown;
};

export type CustodyRecord = {
	stage: CustodyStage;
	label: string;
	content_hash: string;
	/** Chain link: folds in every prior record, so reordering/dropping is detectable. */
	link_hash: string;
};

export type CustodyChain = {
	schema_version: typeof CUSTODY_SCHEMA_VERSION;
	chain_id: string;
	created_at: string;
	records: CustodyRecord[];
	/** The last record's link_hash. The single value a signature needs to cover. */
	root_hash: string;
};

const GENESIS_LINK = sha256("failsafe-custody-genesis");

function computeLinkHash(
	prevLink: string,
	stage: CustodyStage,
	label: string,
	hash: string,
): string {
	return sha256(`${prevLink}\u0000${stage}\u0000${label}\u0000${hash}`);
}

/**
 * Build a hash chain over an ordered sequence of pipeline stages.
 *
 * Order is the caller's: this function does not reorder or validate stage
 * sequencing (e.g. it does not require "evidence" before "analysis"), because
 * a real pipeline can legitimately revisit a stage (two redaction passes,
 * two exports of the same analysis to different formats) and imposing a
 * strict total order here would reject valid chains. What it guarantees is
 * that whatever order was given cannot be silently changed afterward.
 */
export function buildCustodyChain(
	chainId: string,
	createdAt: string,
	inputs: CustodyInput[],
): CustodyChain {
	const records: CustodyRecord[] = [];
	let prevLink = GENESIS_LINK;
	for (const input of inputs) {
		const hash = contentHash(input.content);
		const link = computeLinkHash(prevLink, input.stage, input.label, hash);
		records.push({ stage: input.stage, label: input.label, content_hash: hash, link_hash: link });
		prevLink = link;
	}
	return {
		schema_version: CUSTODY_SCHEMA_VERSION,
		chain_id: chainId,
		created_at: createdAt,
		records,
		root_hash: prevLink,
	};
}

/**
 * Recompute every link_hash from the records' own (stage, label,
 * content_hash) triples and compare against the stored link_hash at each
 * position, and against the chain's own root_hash at the end.
 *
 * This is the check that makes the chain tamper-evident even to a holder of
 * the content: splicing in a different content_hash at record 3 changes
 * record 3's own recomputed link_hash (it is a direct input), which cascades
 * to every record after it, which changes the recomputed root_hash -- so a
 * single edit anywhere is visible at the root without needing to compare
 * record-by-record.
 */
export function recomputeChainIntegrity(chain: CustodyChain): {
	valid: boolean;
	problems: string[];
} {
	const problems: string[] = [];
	let prevLink = GENESIS_LINK;
	for (const [i, record] of chain.records.entries()) {
		const expected = computeLinkHash(prevLink, record.stage, record.label, record.content_hash);
		if (expected !== record.link_hash) {
			problems.push(
				`record ${i} ('${record.stage}:${record.label}'): link_hash does not match its own (stage, label, content_hash)`,
			);
		}
		prevLink = record.link_hash;
	}
	if (prevLink !== chain.root_hash) {
		problems.push("root_hash does not match the final record's link_hash");
	}
	return { valid: problems.length === 0, problems };
}

export type SignatureBlock = {
	algorithm: "hmac-sha256";
	key_id: string;
	value: string;
};

export type SignedCustodyChain = CustodyChain & { signature: SignatureBlock };

/** Canonical bytes a signature covers: everything except the signature itself. */
function signablePayload(chain: CustodyChain): string {
	return canonicalize({
		schema_version: chain.schema_version,
		chain_id: chain.chain_id,
		created_at: chain.created_at,
		records: chain.records,
		root_hash: chain.root_hash,
	});
}

/** Sign a chain. The signature covers hashes only -- never the raw content. */
export function signCustodyChain(
	chain: CustodyChain,
	key: string,
	keyId: string,
): SignedCustodyChain {
	const value = createHmac("sha256", key).update(signablePayload(chain)).digest("hex");
	return { ...chain, signature: { algorithm: "hmac-sha256", key_id: keyId, value } };
}

/** Constant-time signature check against the hash-only payload. */
export function verifyCustodySignature(chain: SignedCustodyChain, key: string): boolean {
	const expected = createHmac("sha256", key).update(signablePayload(chain)).digest("hex");
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(chain.signature.value, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export type CustodyVerification = {
	signature_valid: boolean;
	chain_intact: boolean;
	problems: string[];
	ok: boolean;
};

/** Full verification: signature over the hash-only payload, plus chain integrity. */
export function verifyCustodyChain(chain: SignedCustodyChain, key: string): CustodyVerification {
	const signatureValid = verifyCustodySignature(chain, key);
	const integrity = recomputeChainIntegrity(chain);
	const problems = [...integrity.problems];
	if (!signatureValid) problems.unshift("signature does not verify against the supplied key");
	return {
		signature_valid: signatureValid,
		chain_intact: integrity.valid,
		problems,
		ok: signatureValid && integrity.valid,
	};
}

// ── Selective disclosure ──

export type DisclosedRecord = {
	stage: CustodyStage;
	label: string;
	/** Present only for a disclosed record; absent for a withheld one. */
	content?: unknown;
	disclosed: boolean;
};

export type SelectiveDisclosure = {
	chain: SignedCustodyChain;
	records: DisclosedRecord[];
};

/**
 * Build a disclosure: reveal content for the chosen stages (by index into
 * `chain.records`), withhold it for the rest. The signed chain itself
 * (hashes only) travels in full regardless -- withholding a stage's content
 * never means withholding that it existed.
 */
export function discloseStages(
	chain: SignedCustodyChain,
	contents: unknown[],
	disclosedIndices: number[],
): SelectiveDisclosure {
	const disclosed = new Set(disclosedIndices);
	const records: DisclosedRecord[] = chain.records.map((record, i) => ({
		stage: record.stage,
		label: record.label,
		disclosed: disclosed.has(i),
		...(disclosed.has(i) ? { content: contents[i] } : {}),
	}));
	return { chain, records };
}

export type SelectiveDisclosureVerification = {
	ok: boolean;
	signature_valid: boolean;
	chain_intact: boolean;
	/** Indices whose disclosed content hashes to exactly what the signed chain committed to. */
	disclosed_verified: number[];
	/** Indices whose disclosed content does NOT match the signed chain's committed hash. */
	disclosed_mismatched: number[];
	/** Indices withheld -- their existence and hash are still proven by chain integrity. */
	withheld: number[];
	problems: string[];
};

/**
 * Verify a selective disclosure.
 *
 * Three independent checks, every one required for `ok`:
 *
 *  1. The signed chain's own signature and hash-chain integrity (so the set
 *     of records, their stages/labels, and their committed content hashes
 *     cannot have been edited).
 *  2. Every record in the signed chain is accounted for in the disclosure --
 *     present as either disclosed or explicitly withheld. A record missing
 *     from `disclosure.records` entirely (not even marked withheld) is a
 *     problem, not a smaller chain: dropping an inconvenient stage must be
 *     visible, not silent.
 *  3. Every *disclosed* record's revealed content hashes to exactly the
 *     content_hash the signed chain already committed to at that position --
 *     this is what proves the revealed content is genuinely what was in the
 *     chain, not a substitute handed over alongside an unrelated signature.
 *
 * A withheld record's content is never examined (there is none to examine);
 * its existence and position are already proven by chain integrity alone,
 * which is the entire point of signing hashes rather than content.
 */
export function verifySelectiveDisclosure(
	disclosure: SelectiveDisclosure,
	key: string,
): SelectiveDisclosureVerification {
	const chainVerification = verifyCustodyChain(disclosure.chain, key);
	const problems = [...chainVerification.problems];

	if (disclosure.records.length !== disclosure.chain.records.length) {
		problems.push(
			`disclosure has ${disclosure.records.length} record(s) but the signed chain has ${disclosure.chain.records.length}; a record is missing rather than explicitly withheld`,
		);
	}

	const disclosedVerified: number[] = [];
	const disclosedMismatched: number[] = [];
	const withheld: number[] = [];

	for (const [i, chainRecord] of disclosure.chain.records.entries()) {
		const disclosedRecord = disclosure.records[i];
		if (!disclosedRecord) continue; // already reported above
		if (
			disclosedRecord.stage !== chainRecord.stage ||
			disclosedRecord.label !== chainRecord.label
		) {
			problems.push(
				`record ${i}: disclosure names stage/label '${disclosedRecord.stage}:${disclosedRecord.label}' but the signed chain has '${chainRecord.stage}:${chainRecord.label}'`,
			);
			continue;
		}
		if (!disclosedRecord.disclosed) {
			withheld.push(i);
			continue;
		}
		const recomputed = contentHash(disclosedRecord.content);
		if (recomputed === chainRecord.content_hash) {
			disclosedVerified.push(i);
		} else {
			disclosedMismatched.push(i);
			problems.push(
				`record ${i} ('${chainRecord.stage}:${chainRecord.label}'): disclosed content hashes to ${recomputed.slice(0, 12)}, but the signed chain committed to ${chainRecord.content_hash.slice(0, 12)}`,
			);
		}
	}

	return {
		ok: chainVerification.ok && problems.length === 0,
		signature_valid: chainVerification.signature_valid,
		chain_intact: chainVerification.chain_intact,
		disclosed_verified: disclosedVerified,
		disclosed_mismatched: disclosedMismatched,
		withheld,
		problems,
	};
}
