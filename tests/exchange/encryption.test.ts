import { describe, expect, test } from "bun:test";
import {
	KEY_BYTES,
	type PlainSection,
	encryptBundle,
	generateSectionKey,
	issueKeys,
	manifestRoot,
	openBundle,
	verifyManifest,
} from "../../src/exchange/encryption.js";

const SIGNING_KEY = "manifest-signing-key";
const NOW = 1_700_000_000_000;

const SECTIONS: PlainSection[] = [
	{ id: "s1", kind: "failure", content: "Traceback: KeyError 'email'" },
	{ id: "s2", kind: "diagnosis", content: "the payload lacks an email key" },
	{ id: "s3", kind: "configuration", content: "DB_PASSWORD_LENGTH=32 REGION=eu" },
];

function keysFor(sections: PlainSection[]): Record<string, Buffer> {
	return Object.fromEntries(sections.map((s) => [s.id, generateSectionKey()]));
}

describe("encryption", () => {
	test("a bundle round-trips when every key is held", () => {
		const keys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, keys, SIGNING_KEY, NOW);
		const opened = openBundle("b1", sections, manifest, keys, SIGNING_KEY);
		expect(opened.problems).toEqual([]);
		expect(opened.disclosed.map((s) => s.content).sort()).toEqual(
			SECTIONS.map((s) => s.content).sort(),
		);
	});

	test("no plaintext survives in the encrypted form", () => {
		const keys = keysFor(SECTIONS);
		const { sections } = encryptBundle("b1", SECTIONS, keys, SIGNING_KEY, NOW);
		const wire = JSON.stringify(sections);
		expect(wire).not.toContain("KeyError");
		expect(wire).not.toContain("DB_PASSWORD_LENGTH");
	});

	test("a missing or wrong-length key is refused rather than left in plaintext", () => {
		expect(() => encryptBundle("b1", SECTIONS, {}, SIGNING_KEY, NOW)).toThrow(
			/no 32-byte key/,
		);
		expect(() =>
			encryptBundle("b1", SECTIONS, { s1: Buffer.alloc(8) }, SIGNING_KEY, NOW),
		).toThrow();
	});

	test("each encryption uses a fresh IV, so identical content differs on the wire", () => {
		const keys = keysFor(SECTIONS);
		const first = encryptBundle("b1", SECTIONS, keys, SIGNING_KEY, NOW).sections[0];
		const second = encryptBundle("b1", SECTIONS, keys, SIGNING_KEY, NOW).sections[0];
		expect(first.iv).not.toBe(second.iv);
		expect(first.ciphertext).not.toBe(second.ciphertext);
	});

	test("a generated key is the right size", () => {
		expect(generateSectionKey().length).toBe(KEY_BYTES);
	});
});

describe("the manifest commits to every section", () => {
	test("a valid manifest verifies", () => {
		const { manifest } = encryptBundle("b1", SECTIONS, keysFor(SECTIONS), SIGNING_KEY, NOW);
		expect(verifyManifest(manifest, SIGNING_KEY)).toEqual({ valid: true, problems: [] });
	});

	test("the root is recomputed rather than trusted", () => {
		const { manifest } = encryptBundle("b1", SECTIONS, keysFor(SECTIONS), SIGNING_KEY, NOW);
		const tampered = { ...manifest, root: manifestRoot([manifest.entries[0]]) };
		const result = verifyManifest(tampered, SIGNING_KEY);
		expect(result.valid).toBe(false);
		expect(result.problems).toContain("the manifest root does not match its entries");
	});

	test("editing an entry invalidates both the root and the signature", () => {
		const { manifest } = encryptBundle("b1", SECTIONS, keysFor(SECTIONS), SIGNING_KEY, NOW);
		const tampered = {
			...manifest,
			entries: manifest.entries.map((e) => (e.id === "s3" ? { ...e, digest: "0".repeat(64) } : e)),
		};
		expect(verifyManifest(tampered, SIGNING_KEY).problems.length).toBeGreaterThanOrEqual(1);
	});

	test("a different signing key does not verify", () => {
		const { manifest } = encryptBundle("b1", SECTIONS, keysFor(SECTIONS), SIGNING_KEY, NOW);
		expect(verifyManifest(manifest, "other-key").valid).toBe(false);
	});

	test("every problem is reported, not just the first", () => {
		const { manifest } = encryptBundle("b1", SECTIONS, keysFor(SECTIONS), SIGNING_KEY, NOW);
		const tampered = {
			...manifest,
			root: "0".repeat(64),
			entries: [...manifest.entries, manifest.entries[0]],
		};
		expect(verifyManifest(tampered, SIGNING_KEY).problems.length).toBeGreaterThanOrEqual(2);
	});

	test("the manifest lists the size of sections the recipient cannot read", () => {
		const { manifest } = encryptBundle("b1", SECTIONS, keysFor(SECTIONS), SIGNING_KEY, NOW);
		const config = manifest.entries.find((e) => e.id === "s3")!;
		expect(config.size).toBe(Buffer.byteLength(SECTIONS[2].content, "utf8"));
		expect(config.kind).toBe("configuration");
	});
});

describe("selective disclosure", () => {
	test("a partial key set discloses some sections and names the rest", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const partial = { s1: allKeys.s1, s2: allKeys.s2 };

		const opened = openBundle("b1", sections, manifest, partial, SIGNING_KEY);
		expect(opened.disclosed.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
		expect(opened.withheld.map((e) => e.id)).toEqual(["s3"]);
		expect(opened.problems).toEqual([]);
	});

	test("a withheld section is visible as existing without being readable", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const opened = openBundle("b1", sections, manifest, { s1: allKeys.s1 }, SIGNING_KEY);
		const config = opened.withheld.find((e) => e.kind === "configuration")!;
		expect(config).toBeDefined();
		expect(JSON.stringify(opened.disclosed)).not.toContain("DB_PASSWORD_LENGTH");
	});

	test("an omitted section is detected as missing, not mistaken for withheld", () => {
		// The omission attack: commit to a section, then do not ship it.
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const withoutConfig = sections.filter((s) => s.id !== "s3");
		const opened = openBundle("b1", withoutConfig, manifest, allKeys, SIGNING_KEY);
		expect(opened.missing.map((e) => e.id)).toEqual(["s3"]);
		expect(opened.withheld).toEqual([]);
		expect(opened.problems.some((p) => p.includes("not a disclosure decision"))).toBe(true);
	});

	test("material the manifest does not cover is rejected as uncovered", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const extra = { ...sections[0], id: "smuggled" };
		const opened = openBundle("b1", [...sections, extra], manifest, allKeys, SIGNING_KEY);
		expect(opened.uncommitted).toEqual(["smuggled"]);
		expect(opened.problems.some((p) => p.includes("no integrity guarantee"))).toBe(true);
	});
});

describe("authenticated encryption binds the section's identity", () => {
	test("a valid ciphertext presented as another section fails", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		// Swap s1's ciphertext into s2's slot, keeping s2's id.
		const swapped = sections.map((s) =>
			s.id === "s2"
				? { ...s, ciphertext: sections[0].ciphertext, iv: sections[0].iv, tag: sections[0].tag }
				: s,
		);
		const opened = openBundle("b1", swapped, manifest, allKeys, SIGNING_KEY);
		expect(opened.disclosed.map((s) => s.id)).not.toContain("s2");
		expect(opened.problems.some((p) => p.includes("authenticated decryption"))).toBe(true);
	});

	test("an altered ciphertext fails the authentication tag", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const altered = sections.map((s) =>
			s.id === "s1"
				? { ...s, ciphertext: Buffer.from("tampered content here").toString("base64") }
				: s,
		);
		const opened = openBundle("b1", altered, manifest, allKeys, SIGNING_KEY);
		expect(opened.problems.some((p) => p.includes("s1"))).toBe(true);
	});

	test("a wrong key and a tampered ciphertext are not distinguished, and that is said", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const opened = openBundle(
			"b1",
			sections,
			manifest,
			{ s1: generateSectionKey() },
			SIGNING_KEY,
		);
		expect(opened.problems[0]).toContain("these are not distinguishable");
	});

	test("a manifest from another bundle is rejected", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const opened = openBundle("b2", sections, manifest, allKeys, SIGNING_KEY);
		expect(opened.problems.some((p) => p.includes("proves nothing about this one"))).toBe(true);
	});
});

describe("key issuance is scoped and its limits stated", () => {
	test("only the allowed kinds are keyed", () => {
		const allKeys = keysFor(SECTIONS);
		const issuance = issueKeys(SECTIONS, allKeys, {
			recipient: "vendor",
			allowed_kinds: ["failure", "diagnosis"],
		});
		expect(Object.keys(issuance.keys).sort()).toEqual(["s1", "s2"]);
		expect(issuance.excluded).toEqual([{ id: "s3", kind: "configuration" }]);
	});

	test("issued keys open exactly the permitted sections", () => {
		const allKeys = keysFor(SECTIONS);
		const { sections, manifest } = encryptBundle("b1", SECTIONS, allKeys, SIGNING_KEY, NOW);
		const issuance = issueKeys(SECTIONS, allKeys, {
			recipient: "vendor",
			allowed_kinds: ["failure"],
		});
		const opened = openBundle("b1", sections, manifest, issuance.keys, SIGNING_KEY);
		expect(opened.disclosed.map((s) => s.id)).toEqual(["s1"]);
		expect(opened.withheld).toHaveLength(2);
	});

	test("key distribution is explicitly out of scope", () => {
		const issuance = issueKeys(SECTIONS, keysFor(SECTIONS), {
			recipient: "vendor",
			allowed_kinds: [],
		});
		expect(issuance.caveats[0]).toContain("does not distribute, rotate, or revoke");
		expect(issuance.caveats[1]).toContain("withholding a key is not the same as withholding the ciphertext");
	});

	test("an empty allowlist issues nothing and excludes everything", () => {
		const issuance = issueKeys(SECTIONS, keysFor(SECTIONS), {
			recipient: "nobody",
			allowed_kinds: [],
		});
		expect(Object.keys(issuance.keys)).toEqual([]);
		expect(issuance.excluded).toHaveLength(SECTIONS.length);
	});
});
