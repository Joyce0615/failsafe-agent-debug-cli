/**
 * Evidence-sufficiency challenge set tests (item 60 — mutate the
 * failure corpus by deleting spans, skewing clocks, removing
 * references, corrupting labels, and truncating handoffs; verify
 * every diagnoser lowers confidence or abstains rather than becoming
 * more certain).
 */
import { describe, expect, test } from "bun:test";
import {
	CHALLENGE_SET_KINDS,
	CORRUPTED_LABEL_SENTINEL,
	type ConfidenceLevel,
	DEFAULT_EVIDENCE_BUNDLE,
	type Diagnoser,
	type EvidenceBundle,
	assessEvidenceSufficiency,
	buildChallengeSet,
	challengePasses,
	corruptLabels,
	deleteSpans,
	removeReferences,
	renderChallengeReport,
	runEvidenceSufficiencyChallenge,
	skewClocks,
	truncateHandoffs,
} from "../../src/testing/evidence-sufficiency.js";

describe("mutation primitives", () => {
	test("deleteSpans removes a deterministic fraction from the front", () => {
		const mutated = deleteSpans(DEFAULT_EVIDENCE_BUNDLE);
		expect(mutated.spans.length).toBeLessThan(DEFAULT_EVIDENCE_BUNDLE.spans.length);
		expect(mutated.references).toEqual(DEFAULT_EVIDENCE_BUNDLE.references);
	});

	test("skewClocks shifts every span's ts_ms by a fixed delta, nothing else", () => {
		const mutated = skewClocks(DEFAULT_EVIDENCE_BUNDLE, 1000);
		expect(mutated.spans.map((s) => s.ts_ms)).toEqual(
			DEFAULT_EVIDENCE_BUNDLE.spans.map((s) => s.ts_ms + 1000),
		);
		expect(mutated.spans.length).toBe(DEFAULT_EVIDENCE_BUNDLE.spans.length);
	});

	test("removeReferences removes a deterministic fraction from the front", () => {
		const mutated = removeReferences(DEFAULT_EVIDENCE_BUNDLE);
		expect(mutated.references.length).toBeLessThan(DEFAULT_EVIDENCE_BUNDLE.references.length);
	});

	test("corruptLabels replaces values with the sentinel but never deletes keys", () => {
		const mutated = corruptLabels(DEFAULT_EVIDENCE_BUNDLE);
		expect(Object.keys(mutated.labels)).toEqual(Object.keys(DEFAULT_EVIDENCE_BUNDLE.labels));
		expect(Object.values(mutated.labels)).toContain(CORRUPTED_LABEL_SENTINEL);
	});

	test("truncateHandoffs keeps only a prefix by sequence order", () => {
		const mutated = truncateHandoffs(DEFAULT_EVIDENCE_BUNDLE);
		expect(mutated.handoffs.length).toBeLessThan(DEFAULT_EVIDENCE_BUNDLE.handoffs.length);
		expect(mutated.handoffs.map((h) => h.sequence)).toEqual([0, 1]);
	});
});

describe("buildChallengeSet", () => {
	test("produces exactly one case per CHALLENGE_SET_KINDS entry", () => {
		const cases = buildChallengeSet(DEFAULT_EVIDENCE_BUNDLE);
		expect(cases.map((c) => c.kind).sort()).toEqual([...CHALLENGE_SET_KINDS].sort());
	});

	test("each case applies exactly one mutation, never stacked", () => {
		const cases = buildChallengeSet(DEFAULT_EVIDENCE_BUNDLE);
		const deleteSpansCase = cases.find((c) => c.kind === "delete_spans");
		expect(deleteSpansCase?.bundle.references).toEqual(DEFAULT_EVIDENCE_BUNDLE.references);
		expect(deleteSpansCase?.bundle.handoffs).toEqual(DEFAULT_EVIDENCE_BUNDLE.handoffs);
	});
});

describe("challengePasses", () => {
	test("passes when the challenge confidence is strictly lower than baseline", () => {
		expect(challengePasses("full", "reduced")).toBe(true);
		expect(challengePasses("reduced", "abstained")).toBe(true);
	});

	test("passes when the challenge confidence is abstained, even if baseline was already abstained", () => {
		expect(challengePasses("abstained", "abstained")).toBe(true);
	});

	test("fails when the challenge confidence is unchanged and non-abstained", () => {
		expect(challengePasses("full", "full")).toBe(false);
		expect(challengePasses("reduced", "reduced")).toBe(false);
	});

	test("fails when the challenge confidence is HIGHER than baseline", () => {
		expect(challengePasses("reduced", "full")).toBe(false);
	});
});

describe("assessEvidenceSufficiency (reference diagnoser)", () => {
	test("reports full on the clean default bundle", () => {
		expect(assessEvidenceSufficiency(DEFAULT_EVIDENCE_BUNDLE)).toBe("full");
	});

	test("abstains when any evidence category is entirely empty", () => {
		const empty: EvidenceBundle = { ...DEFAULT_EVIDENCE_BUNDLE, spans: [] };
		expect(assessEvidenceSufficiency(empty)).toBe("abstained");
	});

	test("reports reduced when a label is corrupted", () => {
		expect(assessEvidenceSufficiency(corruptLabels(DEFAULT_EVIDENCE_BUNDLE))).toBe("reduced");
	});

	test("reports reduced when clocks are skewed", () => {
		expect(assessEvidenceSufficiency(skewClocks(DEFAULT_EVIDENCE_BUNDLE))).toBe("reduced");
	});
});

describe("runEvidenceSufficiencyChallenge", () => {
	test("the honest reference diagnoser passes all five challenges", () => {
		const report = runEvidenceSufficiencyChallenge(
			assessEvidenceSufficiency,
			DEFAULT_EVIDENCE_BUNDLE,
		);
		expect(report.passed).toBe(true);
		expect(report.violations).toEqual([]);
		expect(report.baseline_confidence).toBe("full");
	});

	test("a diagnoser that always reports full is caught with violations on every challenge", () => {
		const alwaysFull: Diagnoser = () => "full" as ConfidenceLevel;
		const report = runEvidenceSufficiencyChallenge(alwaysFull, DEFAULT_EVIDENCE_BUNDLE);
		expect(report.passed).toBe(false);
		expect(report.violations.length).toBe(CHALLENGE_SET_KINDS.length);
		expect(report.violations.map((v) => v.kind).sort()).toEqual([...CHALLENGE_SET_KINDS].sort());
	});

	test("a diagnoser that always abstains passes trivially (abstained can never violate)", () => {
		const alwaysAbstained: Diagnoser = () => "abstained" as ConfidenceLevel;
		const report = runEvidenceSufficiencyChallenge(alwaysAbstained, DEFAULT_EVIDENCE_BUNDLE);
		expect(report.passed).toBe(true);
	});
});

describe("renderChallengeReport", () => {
	test("renders baseline confidence, passed, and violations", () => {
		const alwaysFull: Diagnoser = () => "full" as ConfidenceLevel;
		const report = runEvidenceSufficiencyChallenge(alwaysFull, DEFAULT_EVIDENCE_BUNDLE);
		const text = renderChallengeReport(report);
		expect(text).toContain("passed: false");
		expect(text).toContain("delete_spans");
	});
});
