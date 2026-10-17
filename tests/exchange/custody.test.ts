import { describe, expect, test } from "bun:test";
import {
	buildCustodyChain,
	type CustodyChain,
	type CustodyInput,
	type SignedCustodyChain,
	contentHash,
	discloseStages,
	recomputeChainIntegrity,
	signCustodyChain,
	verifyCustodyChain,
	verifyCustodySignature,
	verifySelectiveDisclosure,
} from "../../src/exchange/custody.js";

const KEY = "test-signing-key";
const KEY_ID = "k1";
const NOW = "2026-01-01T00:00:00.000Z";

function sampleInputs(): CustodyInput[] {
	return [
		{ stage: "evidence", label: "stack-trace", content: { trace: "KeyError at line 42" } },
		{
			stage: "transformation",
			label: "normalize-paths",
			content: { trace: "KeyError at <path>:42" },
		},
		{
			stage: "redaction",
			label: "redact-pass-1",
			content: { trace: "KeyError at <path>:42", redacted: ["email@example.com"] },
		},
		{
			stage: "analysis",
			label: "root-cause",
			content: { category: "missing-key", confidence: 0.8 },
		},
		{ stage: "export", label: "sarif", content: { format: "sarif-2.1.0" } },
	];
}

function buildSigned(): SignedCustodyChain {
	const chain = buildCustodyChain("chain-1", NOW, sampleInputs());
	return signCustodyChain(chain, KEY, KEY_ID);
}

describe("building a custody chain", () => {
	test("produces one record per input, each with a content_hash and a link_hash", () => {
		const chain = buildCustodyChain("chain-1", NOW, sampleInputs());
		expect(chain.records.length).toBe(5);
		for (const record of chain.records) {
			expect(record.content_hash.length).toBeGreaterThan(0);
			expect(record.link_hash.length).toBeGreaterThan(0);
		}
	});

	test("root_hash equals the final record's link_hash", () => {
		const chain = buildCustodyChain("chain-1", NOW, sampleInputs());
		expect(chain.root_hash).toBe(chain.records.at(-1)?.link_hash ?? "");
	});

	test("content_hash is deterministic and independent of chain position", () => {
		const content = { x: 1, y: 2 };
		expect(contentHash(content)).toBe(contentHash({ y: 2, x: 1 })); // key order irrelevant
	});

	test("reordering two inputs produces a different root_hash", () => {
		const inputs = sampleInputs();
		const a = buildCustodyChain("c", NOW, inputs);
		const b = buildCustodyChain("c", NOW, [inputs[1], inputs[0], ...inputs.slice(2)]);
		expect(a.root_hash).not.toBe(b.root_hash);
	});

	test("a chain with no records has a root_hash equal to the genesis-derived link, deterministically", () => {
		const a = buildCustodyChain("c", NOW, []);
		const b = buildCustodyChain("c", NOW, []);
		expect(a.root_hash).toBe(b.root_hash);
		expect(a.records).toEqual([]);
	});
});

describe("chain integrity", () => {
	test("an untouched chain is intact", () => {
		const chain = buildCustodyChain("chain-1", NOW, sampleInputs());
		const result = recomputeChainIntegrity(chain);
		expect(result.valid).toBe(true);
		expect(result.problems).toEqual([]);
	});

	test("splicing a different content_hash at a middle record is caught, and cascades to the root", () => {
		const chain = buildCustodyChain("chain-1", NOW, sampleInputs());
		const tampered: CustodyChain = {
			...chain,
			records: chain.records.map((r, i) => (i === 2 ? { ...r, content_hash: contentHash({ different: true }) } : r)),
		};
		const result = recomputeChainIntegrity(tampered);
		expect(result.valid).toBe(false);
		expect(result.problems.length).toBeGreaterThan(0);
	});

	test("dropping a record from the middle changes every subsequent link_hash", () => {
		const chain = buildCustodyChain("chain-1", NOW, sampleInputs());
		const dropped: CustodyChain = {
			...chain,
			records: chain.records.filter((_, i) => i !== 2),
			root_hash: chain.records.at(-1)?.link_hash ?? "",
		};
		const result = recomputeChainIntegrity(dropped);
		expect(result.valid).toBe(false);
	});
});

describe("signing and verifying", () => {
	test("a correctly signed, untampered chain verifies", () => {
		const signed = buildSigned();
		expect(verifyCustodySignature(signed, KEY)).toBe(true);
		const result = verifyCustodyChain(signed, KEY);
		expect(result.ok).toBe(true);
		expect(result.signature_valid).toBe(true);
		expect(result.chain_intact).toBe(true);
	});

	test("verifying with the wrong key fails", () => {
		const signed = buildSigned();
		expect(verifyCustodySignature(signed, "wrong-key")).toBe(false);
		const result = verifyCustodyChain(signed, "wrong-key");
		expect(result.ok).toBe(false);
		expect(result.signature_valid).toBe(false);
	});

	test("tampering with a record after signing is caught even though the signature bytes are untouched", () => {
		const signed = buildSigned();
		const tampered: SignedCustodyChain = {
			...signed,
			records: signed.records.map((r, i) => (i === 0 ? { ...r, label: "renamed" } : r)),
		};
		const result = verifyCustodyChain(tampered, KEY);
		expect(result.ok).toBe(false);
	});

	test("the signature covers hashes only -- it does not change if record content is swapped for different content with the same hash collision is not required to prove this: it changes whenever content_hash changes, and content_hash is all the signature sees", () => {
		const signed = buildSigned();
		// Swapping record content directly (not through content_hash) has no
		// representation in SignedCustodyChain at all -- content never travels
		// inside the chain object. This is asserted structurally: no record has
		// a `content` field.
		for (const record of signed.records) {
			expect(Object.keys(record)).not.toContain("content");
		}
	});
});

describe("selective disclosure", () => {
	test("disclosing a subset reveals content for those indices and withholds the rest", () => {
		const chain = buildSigned();
		const contents = sampleInputs().map((i) => i.content);
		const disclosure = discloseStages(chain, contents, [0, 3]);
		expect(disclosure.records[0]?.disclosed).toBe(true);
		expect(disclosure.records[0]?.content).toEqual(contents[0]);
		expect(disclosure.records[1]?.disclosed).toBe(false);
		expect(disclosure.records[1]?.content).toBeUndefined();
	});

	test("verifying a correct selective disclosure passes, with disclosed/withheld correctly reported", () => {
		const chain = buildSigned();
		const contents = sampleInputs().map((i) => i.content);
		const disclosure = discloseStages(chain, contents, [0, 2, 4]);
		const result = verifySelectiveDisclosure(disclosure, KEY);
		expect(result.ok).toBe(true);
		expect(result.disclosed_verified.sort()).toEqual([0, 2, 4]);
		expect(result.withheld.sort()).toEqual([1, 3]);
		expect(result.disclosed_mismatched).toEqual([]);
	});

	test("substituting different content for a disclosed stage is caught as a hash mismatch", () => {
		const chain = buildSigned();
		const contents = sampleInputs().map((i) => i.content);
		const disclosure = discloseStages(chain, contents, [0]);
		const forged = {
			...disclosure,
			records: disclosure.records.map((r, i) =>
				i === 0 ? { ...r, content: { trace: "a completely different, more flattering trace" } } : r,
			),
		};
		const result = verifySelectiveDisclosure(forged, KEY);
		expect(result.ok).toBe(false);
		expect(result.disclosed_mismatched).toContain(0);
	});

	test("silently dropping a withheld record entirely (not even marking it withheld) is detected", () => {
		const chain = buildSigned();
		const contents = sampleInputs().map((i) => i.content);
		const disclosure = discloseStages(chain, contents, [0, 2, 4]);
		const shortened = { ...disclosure, records: disclosure.records.filter((_, i) => i !== 3) };
		const result = verifySelectiveDisclosure(shortened, KEY);
		expect(result.ok).toBe(false);
		expect(result.problems.some((p) => p.includes("missing"))).toBe(true);
	});

	test("withheld records never have their content hash-checked, since none is present", () => {
		const chain = buildSigned();
		const contents = sampleInputs().map((i) => i.content);
		const disclosure = discloseStages(chain, contents, []); // disclose nothing
		const result = verifySelectiveDisclosure(disclosure, KEY);
		expect(result.ok).toBe(true);
		expect(result.disclosed_verified).toEqual([]);
		expect(result.withheld.sort()).toEqual([0, 1, 2, 3, 4]);
	});

	test("a tampered signed chain fails selective disclosure verification even if all disclosed content matches", () => {
		const chain = buildSigned();
		const tamperedChain: SignedCustodyChain = {
			...chain,
			records: chain.records.map((r, i) => (i === 1 ? { ...r, label: "renamed" } : r)),
		};
		const contents = sampleInputs().map((i) => i.content);
		const disclosure = discloseStages(tamperedChain, contents, [0]);
		const result = verifySelectiveDisclosure(disclosure, KEY);
		expect(result.ok).toBe(false);
		expect(result.chain_intact).toBe(false);
	});
});
