import { describe, expect, test } from "bun:test";
import {
	CLAIM_KINDS,
	type Claim,
	DEFAULT_CITATION_POLICY,
	type EvidenceRecord,
	VIOLATION_CODES,
	VIOLATION_SEVERITY,
	checkClaim,
	enforceCitations,
	indexEvidence,
	normalizeQuote,
	quoteAppears,
	renderViolations,
	uncitedEvidence,
} from "../../src/diagnosis/citations.js";

const EVIDENCE: EvidenceRecord[] = [
	{
		id: "ev-log",
		source: "output",
		content: "Traceback (most recent call last):\n  File \"app.py\", line 42\nKeyError: 'email'",
		addressable: true,
	},
	{ id: "ev-diff", source: "diff", content: "- payload['email']\n+ payload.get('email')" },
	{
		id: "ev-old",
		source: "output",
		content: "stale run output",
		superseded_by: "ev-log",
	},
];

const INDEX = indexEvidence(EVIDENCE);

function claim(overrides: Partial<Claim> & { id: string }): Claim {
	return {
		kind: "diagnosis",
		statement: "the payload lacks an email key",
		citations: [{ evidence_id: "ev-log", locator: "L3" }],
		...overrides,
	};
}

describe("a claim must cite something", () => {
	test("a well-cited diagnosis passes clean", () => {
		expect(checkClaim(claim({ id: "c1" }), INDEX)).toEqual([]);
	});

	test("an uncited claim is rejected with a named code", () => {
		const violations = checkClaim(claim({ id: "c1", citations: [] }), INDEX);
		expect(violations).toHaveLength(1);
		expect(violations[0].code).toBe("no_citations");
		expect(violations[0].severity).toBe("error");
	});

	test("every claim kind is subject to the requirement", () => {
		for (const kind of CLAIM_KINDS) {
			const violations = checkClaim(claim({ id: "c1", kind, citations: [] }), INDEX);
			expect(violations.some((v) => v.code === "no_citations")).toBe(true);
		}
	});
});

describe("fabrication is separated from omission", () => {
	test("citing a nonexistent id is fabrication, not a missing citation", () => {
		const violations = checkClaim(
			claim({ id: "c1", citations: [{ evidence_id: "ev-imaginary" }] }),
			INDEX,
		);
		expect(violations.map((v) => v.code)).toEqual(["fabricated_evidence"]);
		expect(violations[0].severity).toBe("critical");
	});

	test("a quote not present in the source is the highest-severity violation", () => {
		const violations = checkClaim(
			claim({
				id: "c1",
				citations: [{ evidence_id: "ev-log", locator: "L3", quote: "ValueError: bad input" }],
			}),
			INDEX,
		);
		expect(violations[0].code).toBe("fabricated_quote");
		expect(VIOLATION_SEVERITY.fabricated_quote).toBe("critical");
	});

	test("a genuine quote passes even when reflowed", () => {
		const violations = checkClaim(
			claim({
				id: "c1",
				citations: [
					{ evidence_id: "ev-log", locator: "L3", quote: "KeyError:    'email'" },
				],
			}),
			INDEX,
		);
		expect(violations).toEqual([]);
	});

	test("case and punctuation changes are not forgiven", () => {
		expect(quoteAppears("keyerror: 'email'", EVIDENCE[0].content)).toBe(false);
		expect(quoteAppears("KeyError: \"email\"", EVIDENCE[0].content)).toBe(false);
	});

	test("an empty quote never counts as verified", () => {
		expect(quoteAppears("", "anything")).toBe(false);
		expect(quoteAppears("   ", "anything")).toBe(false);
	});

	test("whitespace normalization collapses runs and trims", () => {
		expect(normalizeQuote("  a \n\t b  ")).toBe("a b");
	});

	test("a fabricated id short-circuits the quote check rather than crashing", () => {
		const violations = checkClaim(
			claim({ id: "c1", citations: [{ evidence_id: "ghost", quote: "anything" }] }),
			INDEX,
		);
		expect(violations).toHaveLength(1);
		expect(violations[0].code).toBe("fabricated_evidence");
	});
});

describe("citation precision", () => {
	test("addressable evidence cited as a whole is imprecise, not rejected", () => {
		const violations = checkClaim(
			claim({ id: "c1", citations: [{ evidence_id: "ev-log" }] }),
			INDEX,
		);
		expect(violations.map((v) => v.code)).toEqual(["imprecise_citation"]);
		expect(violations[0].severity).toBe("warning");
	});

	test("non-addressable evidence needs no locator", () => {
		expect(
			checkClaim(claim({ id: "c1", citations: [{ evidence_id: "ev-diff" }] }), INDEX),
		).toEqual([]);
	});

	test("the locator requirement can be turned off", () => {
		const violations = checkClaim(claim({ id: "c1", citations: [{ evidence_id: "ev-log" }] }), INDEX, {
			...DEFAULT_CITATION_POLICY,
			require_locator: false,
		});
		expect(violations).toEqual([]);
	});

	test("superseded evidence is flagged as a warning, not a fabrication", () => {
		const violations = checkClaim(
			claim({ id: "c1", citations: [{ evidence_id: "ev-old" }] }),
			INDEX,
		);
		expect(violations.map((v) => v.code)).toEqual(["superseded_evidence"]);
	});

	test("repeating a citation is not corroboration", () => {
		const violations = checkClaim(
			claim({
				id: "c1",
				citations: [
					{ evidence_id: "ev-log", locator: "L3" },
					{ evidence_id: "ev-log", locator: "L3" },
				],
			}),
			INDEX,
		);
		expect(violations.map((v) => v.code)).toEqual(["duplicate_citation"]);
	});

	test("the same evidence at two locations is two citations, not a duplicate", () => {
		expect(
			checkClaim(
				claim({
					id: "c1",
					citations: [
						{ evidence_id: "ev-log", locator: "L2" },
						{ evidence_id: "ev-log", locator: "L3" },
					],
				}),
				INDEX,
			),
		).toEqual([]);
	});
});

describe("confidence updates must be coherent", () => {
	function update(overrides: Partial<Claim>): Claim {
		return claim({
			id: "u1",
			kind: "confidence_update",
			confidence_from: 0.4,
			confidence_to: 0.7,
			stance: "supports",
			...overrides,
		});
	}

	test("a rise citing supporting evidence is fine", () => {
		expect(checkClaim(update({}), INDEX)).toEqual([]);
	});

	test("a fall citing contradicting evidence is fine", () => {
		expect(
			checkClaim(update({ confidence_from: 0.7, confidence_to: 0.2, stance: "contradicts" }), INDEX),
		).toEqual([]);
	});

	test("a rise citing contradicting evidence is incoherent", () => {
		const violations = checkClaim(update({ stance: "contradicts" }), INDEX);
		expect(violations.map((v) => v.code)).toEqual(["incoherent_update"]);
		expect(violations[0].detail).toContain("rose");
	});

	test("a fall citing supporting evidence is incoherent", () => {
		const violations = checkClaim(
			update({ confidence_from: 0.8, confidence_to: 0.3, stance: "supports" }),
			INDEX,
		);
		expect(violations[0].detail).toContain("fell");
	});

	test("an update that moves nothing is not judged on direction", () => {
		expect(
			checkClaim(update({ confidence_from: 0.5, confidence_to: 0.5, stance: "contradicts" }), INDEX),
		).toEqual([]);
	});

	test("an update missing its before/after or stance is malformed", () => {
		expect(
			checkClaim(update({ confidence_to: undefined }), INDEX).map((v) => v.code),
		).toEqual(["malformed_update"]);
		expect(checkClaim(update({ stance: undefined }), INDEX).map((v) => v.code)).toEqual([
			"malformed_update",
		]);
	});

	test("a diagnosis is not held to the update rules", () => {
		expect(checkClaim(claim({ id: "d1", kind: "diagnosis" }), INDEX)).toEqual([]);
	});

	test("independent problems are all reported, not just the first", () => {
		const violations = checkClaim(
			update({ citations: [{ evidence_id: "ghost" }], stance: "contradicts" }),
			INDEX,
		);
		expect(violations.map((v) => v.code).sort()).toEqual([
			"fabricated_evidence",
			"incoherent_update",
		]);
	});
});

describe("enforcement", () => {
	const good = claim({ id: "ok" });
	const uncited = claim({ id: "bare", citations: [] });
	const fabricated = claim({ id: "invented", citations: [{ evidence_id: "ghost" }] });
	const imprecise = claim({ id: "vague", citations: [{ evidence_id: "ev-log" }] });

	test("block rejects error-and-above and accepts the rest", () => {
		const result = enforceCitations([good, uncited, fabricated, imprecise], EVIDENCE);
		expect(result.accepted.map((c) => c.id).sort()).toEqual(["ok", "vague"]);
		expect(result.rejected.map((r) => r.claim.id).sort()).toEqual(["bare", "invented"]);
	});

	test("warn reports everything and rejects nothing", () => {
		const result = enforceCitations([good, uncited, fabricated], EVIDENCE, {
			...DEFAULT_CITATION_POLICY,
			enforcement: "warn",
		});
		expect(result.rejected).toEqual([]);
		expect(result.violations.length).toBeGreaterThan(0);
	});

	test("off means off: nothing is checked, not merely nothing blocked", () => {
		const result = enforceCitations([uncited, fabricated], EVIDENCE, {
			...DEFAULT_CITATION_POLICY,
			enforcement: "off",
		});
		expect(result.accepted).toHaveLength(2);
		expect(result.violations).toEqual([]);
		expect(result.summary.flagged).toBe(0);
	});

	test("raising the block threshold to critical lets an uncited claim through", () => {
		const result = enforceCitations([uncited, fabricated], EVIDENCE, {
			...DEFAULT_CITATION_POLICY,
			block_at: "critical",
		});
		expect(result.accepted.map((c) => c.id)).toEqual(["bare"]);
		expect(result.rejected.map((r) => r.claim.id)).toEqual(["invented"]);
	});

	test("never-citing and inventing citations are counted separately", () => {
		const result = enforceCitations([uncited, uncited, fabricated], EVIDENCE);
		expect(result.summary.uncited_claims).toBe(2);
		expect(result.summary.fabricating_claims).toBe(1);
	});

	test("the summary counts every code that fired", () => {
		const result = enforceCitations([uncited, fabricated, imprecise], EVIDENCE);
		expect(result.summary.by_code.no_citations).toBe(1);
		expect(result.summary.by_code.fabricated_evidence).toBe(1);
		expect(result.summary.by_code.imprecise_citation).toBe(1);
		expect(result.summary.flagged).toBe(3);
	});

	test("an empty claim set is a clean pass", () => {
		const result = enforceCitations([], EVIDENCE);
		expect(result.accepted).toEqual([]);
		expect(result.summary.claims).toBe(0);
		expect(result.summary.by_code).toEqual({});
	});

	test("a repeated evidence id resolves to the last record", () => {
		const index = indexEvidence([
			{ id: "e", source: "output", content: "old" },
			{ id: "e", source: "output", content: "new" },
		]);
		expect(index.get("e")?.content).toBe("new");
	});
});

describe("the complement: evidence nobody used", () => {
	test("uncited evidence is reported", () => {
		const uncited = uncitedEvidence([claim({ id: "c1" })], EVIDENCE);
		expect(uncited.map((e) => e.id).sort()).toEqual(["ev-diff", "ev-old"]);
	});

	test("evidence cited anywhere counts as used", () => {
		const uncited = uncitedEvidence(
			[
				claim({ id: "c1", citations: [{ evidence_id: "ev-log", locator: "L1" }] }),
				claim({ id: "c2", citations: [{ evidence_id: "ev-diff" }] }),
				claim({ id: "c3", citations: [{ evidence_id: "ev-old" }] }),
			],
			EVIDENCE,
		);
		expect(uncited).toEqual([]);
	});

	test("no claims means all evidence is unused", () => {
		expect(uncitedEvidence([], EVIDENCE)).toHaveLength(EVIDENCE.length);
	});
});

describe("rendering", () => {
	test("violations are ordered severity-first for scanning", () => {
		const result = enforceCitations(
			[
				claim({ id: "vague", citations: [{ evidence_id: "ev-log" }] }),
				claim({ id: "invented", citations: [{ evidence_id: "ghost" }] }),
			],
			EVIDENCE,
		);
		const lines = renderViolations(result.violations).split("\n");
		expect(lines[0]).toContain("[CRITICAL]");
		expect(lines[lines.length - 1]).toContain("[WARNING]");
	});

	test("every code has a declared severity", () => {
		for (const code of VIOLATION_CODES) {
			expect(VIOLATION_SEVERITY[code]).toBeDefined();
		}
	});

	test("an empty violation list renders empty", () => {
		expect(renderViolations([])).toBe("");
	});
});
