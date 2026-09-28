/**
 * Bundle encryption, signed manifests, and selective evidence disclosure
 * (item 89).
 *
 * Item 49 established consent, scrubbing, signatures, and trust for diagnostic
 * bundle exchange. It assumes the recipient gets everything they are given. The
 * case this module adds is the one that actually arises: a vendor should see
 * the stack trace and the failing test, and must not see the configuration
 * section, and must nonetheless be able to verify that what they received has
 * not been altered.
 *
 * That last clause is the whole difficulty. Three properties are needed
 * together, and dropping any one produces something that looks secure:
 *
 * 1. **Per-section encryption**, so a key can be issued for one section and not
 *    another. Encrypting the whole bundle and sending the key means disclosure
 *    is all-or-nothing.
 *
 * 2. **A signed manifest committing to *every* section**, including the ones a
 *    given recipient cannot decrypt. Without it, a sender can simply omit a
 *    section and the recipient cannot distinguish "withheld from me" from "not
 *    present" — and an omission is exactly how an inconvenient piece of
 *    evidence disappears.
 *
 * 3. **Authenticated encryption with the section's identity bound in.**
 *    AES-256-GCM detects tampering, and putting the section id in the
 *    additional authenticated data prevents a *valid* ciphertext for section A
 *    being presented as section B — a swap that plain AEAD permits and that
 *    would let a sender substitute a benign section for a damaging one.
 *
 * What this module deliberately does **not** do is key distribution. Deciding
 * who gets which key, transporting it, and revoking it are the parts these
 * designs actually fail at, and a library that quietly invents an answer makes
 * that failure harder to see. Keys come in as arguments.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

export const CIPHER = "aes-256-gcm";
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export type PlainSection = {
	id: string;
	/** e.g. `failure`, `diagnosis`, `configuration`. */
	kind: string;
	content: string;
};

export type EncryptedSection = {
	id: string;
	kind: string;
	/** Base64 ciphertext. */
	ciphertext: string;
	iv: string;
	tag: string;
	/** SHA-256 of the plaintext, committed to in the manifest. */
	digest: string;
};

export type ManifestEntry = {
	id: string;
	kind: string;
	digest: string;
	/** Bytes of plaintext, so a recipient can see the size of what they lack. */
	size: number;
};

export type SignedManifest = {
	bundle_id: string;
	created_at_ms: number;
	/** Every section in the bundle, disclosed or not. Sorted by id. */
	entries: ManifestEntry[];
	/** Digest over the sorted entries: a single value covering the whole set. */
	root: string;
	signature: string;
};

function sha256(value: string | Buffer): string {
	return createHmac("sha256", "failsafe-digest").update(value).digest("hex");
}

/** Deterministic serialization of a manifest's signable content. */
function manifestPayload(manifest: Omit<SignedManifest, "signature">): string {
	return JSON.stringify({
		bundle_id: manifest.bundle_id,
		created_at_ms: manifest.created_at_ms,
		entries: manifest.entries,
		root: manifest.root,
	});
}

/** Root digest over the manifest entries. */
export function manifestRoot(entries: ManifestEntry[]): string {
	const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
	return sha256(sorted.map((e) => `${e.id}:${e.kind}:${e.digest}:${e.size}`).join("|"));
}

export type EncryptionResult = {
	sections: EncryptedSection[];
	manifest: SignedManifest;
};

/**
 * Encrypt each section under its own key and sign a manifest over all of them.
 *
 * `keys` maps section id to a 32-byte key. A section with no key is an error
 * rather than a silently-plaintext section: the failure mode of "encrypt what
 * you can" is a bundle where some sections happen to be readable and nobody
 * noticed which.
 */
export function encryptBundle(
	bundleId: string,
	sections: PlainSection[],
	keys: Record<string, Buffer>,
	signingKey: string,
	nowMs: number,
): EncryptionResult {
	const encrypted: EncryptedSection[] = [];
	const entries: ManifestEntry[] = [];

	for (const section of sections) {
		const key = keys[section.id];
		if (!key || key.length !== KEY_BYTES) {
			throw new Error(
				`no ${KEY_BYTES}-byte key for section '${section.id}'; refusing to emit a bundle with a section nobody can account for`,
			);
		}
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv(CIPHER, key, iv);
		// Binding the id and kind into the AAD is what stops a valid ciphertext
		// for one section being presented as another.
		cipher.setAAD(Buffer.from(`${bundleId}|${section.id}|${section.kind}`, "utf8"));
		const ciphertext = Buffer.concat([cipher.update(section.content, "utf8"), cipher.final()]);
		const tag = cipher.getAuthTag();
		const digest = sha256(section.content);

		encrypted.push({
			id: section.id,
			kind: section.kind,
			ciphertext: ciphertext.toString("base64"),
			iv: iv.toString("base64"),
			tag: tag.toString("base64"),
			digest,
		});
		entries.push({
			id: section.id,
			kind: section.kind,
			digest,
			size: Buffer.byteLength(section.content, "utf8"),
		});
	}

	entries.sort((a, b) => a.id.localeCompare(b.id));
	const unsigned = {
		bundle_id: bundleId,
		created_at_ms: nowMs,
		entries,
		root: manifestRoot(entries),
	};

	return {
		sections: encrypted,
		manifest: {
			...unsigned,
			signature: createHmac("sha256", signingKey).update(manifestPayload(unsigned)).digest("hex"),
		},
	};
}

export type ManifestVerification = {
	valid: boolean;
	/** Every problem found, not just the first. */
	problems: string[];
};

/**
 * Verify a manifest's signature and internal consistency.
 *
 * The root is recomputed rather than trusted, because a signature over a root
 * that was itself supplied by the sender proves only that the sender signed
 * the number they chose.
 */
export function verifyManifest(manifest: SignedManifest, signingKey: string): ManifestVerification {
	const problems: string[] = [];

	const recomputed = manifestRoot(manifest.entries);
	if (recomputed !== manifest.root) {
		problems.push("the manifest root does not match its entries");
	}

	const expected = Buffer.from(
		createHmac("sha256", signingKey)
			.update(manifestPayload({ ...manifest, root: manifest.root }))
			.digest("hex"),
		"hex",
	);
	const actual = Buffer.from(manifest.signature, "hex");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		problems.push("the manifest signature does not verify");
	}

	const ids = manifest.entries.map((e) => e.id);
	if (new Set(ids).size !== ids.length) {
		problems.push("the manifest contains duplicate section ids");
	}

	return { valid: problems.length === 0, problems };
}

export type DisclosureResult = {
	/** Sections the recipient could decrypt. */
	disclosed: PlainSection[];
	/**
	 * Sections present in the manifest that the recipient has no key for. Named
	 * rather than omitted: knowing that a configuration section exists and was
	 * withheld is different from not knowing it exists.
	 */
	withheld: ManifestEntry[];
	/**
	 * Manifest entries with no corresponding ciphertext. This is the case the
	 * manifest exists to detect — the sender committed to a section and then did
	 * not ship it.
	 */
	missing: ManifestEntry[];
	/** Ciphertexts with no manifest entry: material the manifest does not cover. */
	uncommitted: string[];
	problems: string[];
};

/**
 * Decrypt what the recipient's keys allow and account for everything else.
 *
 * The three residual categories are deliberately distinct. `withheld` is
 * expected and fine. `missing` means the sender committed to a section and
 * omitted it, which is the omission attack the manifest exists to catch.
 * `uncommitted` means material arrived that the signature does not cover, which
 * cannot be trusted at all.
 */
export function openBundle(
	bundleId: string,
	sections: EncryptedSection[],
	manifest: SignedManifest,
	keys: Record<string, Buffer>,
	signingKey: string,
): DisclosureResult {
	const verification = verifyManifest(manifest, signingKey);
	const problems = [...verification.problems];

	const byId = new Map(sections.map((s) => [s.id, s]));
	const disclosed: PlainSection[] = [];
	const withheld: ManifestEntry[] = [];
	const missing: ManifestEntry[] = [];

	if (manifest.bundle_id !== bundleId) {
		problems.push(
			`the manifest is for bundle '${manifest.bundle_id}', not '${bundleId}'; a manifest from another bundle proves nothing about this one`,
		);
	}

	for (const entry of manifest.entries) {
		const section = byId.get(entry.id);
		if (!section) {
			missing.push(entry);
			continue;
		}
		const key = keys[entry.id];
		if (!key) {
			withheld.push(entry);
			continue;
		}
		try {
			const decipher = createDecipheriv(CIPHER, key, Buffer.from(section.iv, "base64"));
			decipher.setAAD(Buffer.from(`${bundleId}|${section.id}|${section.kind}`, "utf8"));
			decipher.setAuthTag(Buffer.from(section.tag, "base64"));
			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(section.ciphertext, "base64")),
				decipher.final(),
			]).toString("utf8");

			if (sha256(plaintext) !== entry.digest) {
				problems.push(`section '${entry.id}' decrypted but its digest does not match the manifest`);
				continue;
			}
			disclosed.push({ id: entry.id, kind: entry.kind, content: plaintext });
		} catch {
			// A GCM tag failure is indistinguishable from a wrong key by design,
			// and saying so is better than guessing which it was.
			problems.push(
				`section '${entry.id}' failed authenticated decryption: the key is wrong or the ciphertext was altered, and these are not distinguishable`,
			);
		}
	}

	const committed = new Set(manifest.entries.map((e) => e.id));
	const uncommitted = sections.filter((s) => !committed.has(s.id)).map((s) => s.id);
	if (uncommitted.length > 0) {
		problems.push(
			`${uncommitted.length} section(s) arrived that the signed manifest does not cover; they carry no integrity guarantee at all`,
		);
	}
	if (missing.length > 0) {
		problems.push(
			`${missing.length} section(s) are committed to in the manifest and were not shipped; this is the omission the manifest exists to detect, not a disclosure decision`,
		);
	}

	return { disclosed, withheld, missing, uncommitted, problems };
}

export type DisclosurePolicy = {
	recipient: string;
	/** Section kinds this recipient may receive. */
	allowed_kinds: string[];
};

export type KeyIssuance = {
	recipient: string;
	/** Keys for the sections the policy permits. */
	keys: Record<string, Buffer>;
	/** Sections deliberately not keyed, with the kind that excluded them. */
	excluded: Array<{ id: string; kind: string }>;
	/** Stated because this module does not solve it. */
	caveats: string[];
};

/**
 * Select which per-section keys a recipient receives.
 *
 * Returns the keys rather than transporting them, and says so. Key
 * distribution, rotation, and revocation are the parts of a scheme like this
 * that fail in practice, and a library that invents an answer to them makes the
 * failure harder to see rather than less likely.
 */
export function issueKeys(
	sections: PlainSection[],
	allKeys: Record<string, Buffer>,
	policy: DisclosurePolicy,
): KeyIssuance {
	const keys: Record<string, Buffer> = {};
	const excluded: KeyIssuance["excluded"] = [];

	for (const section of sections) {
		if (policy.allowed_kinds.includes(section.kind) && allKeys[section.id]) {
			keys[section.id] = allKeys[section.id];
		} else {
			excluded.push({ id: section.id, kind: section.kind });
		}
	}

	return {
		recipient: policy.recipient,
		keys,
		excluded,
		caveats: [
			"this returns keys; it does not distribute, rotate, or revoke them, and those are where a selective-disclosure scheme actually fails",
			"a recipient who is later given a key can decrypt material they already hold: withholding a key is not the same as withholding the ciphertext",
		],
	};
}

/** Generate a fresh per-section key. Callers own storage and distribution. */
export function generateSectionKey(): Buffer {
	return randomBytes(KEY_BYTES);
}
