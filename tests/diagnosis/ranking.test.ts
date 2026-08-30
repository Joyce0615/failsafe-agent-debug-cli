import { describe, expect, test } from "bun:test";
import { fitCalibration } from "../../src/diagnosis/calibration.js";
import {
	type CauseCandidate,
	MIN_LEADER_CONFIDENCE,
	MIN_MARGIN,
	type RankingEvidence,
	likelihood,
	rankCauses,
	renderRanking,
} from "../../src/diagnosis/ranking.js";

function ev(overrides: Partial<RankingEvidence> & { id: string }): RankingEvidence {
	return {
		stance: "supports",
		weight: 0.8,
		reliability: 0.9,
		description: `evidence ${overrides.id}`,
		...overrides,
	};
}

function candidate(id: string, evidence: RankingEvidence[] = []): CauseCandidate {
	return { id, summary: `cause ${id}`, evidence };
}

describe("contradictory evidence is kept, not netted away", () => {
	test("contradictions appear as their own field on the ranked cause", () => {
		const ranking = rankCauses([
			candidate("a", [ev({ id: "s1" }), ev({ id: "c1", stance: "contradicts" })]),
		]);
		expect(ranking.causes[0].supporting).toHaveLength(1);
		expect(ranking.causes[0].contradicting).toHaveLength(1);
		expect(ranking.causes[0].support_score).toBeGreaterThan(0);
		expect(ranking.causes[0].contradiction_score).toBeGreaterThan(0);
	});

	test("five-supports-three-contradictions is distinguishable from two-and-none", () => {
		const disputed = candidate("disputed", [
			...Array.from({ length: 5 }, (_, i) => ev({ id: `s${i}` })),
			...Array.from({ length: 3 }, (_, i) => ev({ id: `c${i}`, stance: "contradicts" })),
		]);
		const clean = candidate("clean", [ev({ id: "s1" }), ev({ id: "s2" })]);
		const ranking = rankCauses([disputed, clean]);
		const d = ranking.causes.find((c) => c.id === "disputed")!;
		const c = ranking.causes.find((c) => c.id === "clean")!;
		expect(d.contradiction_score).toBeGreaterThan(0);
		expect(c.contradiction_score).toBe(0);
		// And the disputed one is ranked below despite far more support.
		expect(d.confidence).toBeLessThan(c.confidence);
	});

	test("a disputed candidate is named in the caveats", () => {
		const ranking = rankCauses([
			candidate("a", [ev({ id: "s1" }), ev({ id: "c1", stance: "contradicts" })]),
		]);
		expect(ranking.caveats.some((c) => c.includes("not netted away") && c.includes("a"))).toBe(
			true,
		);
	});

	test("contradiction does not saturate, so volume of disagreement keeps costing", () => {
		const two = likelihood(
			candidate("x", [
				ev({ id: "s" }),
				ev({ id: "c1", stance: "contradicts" }),
				ev({ id: "c2", stance: "contradicts" }),
			]),
		);
		const four = likelihood(
			candidate("x", [
				ev({ id: "s" }),
				ev({ id: "c1", stance: "contradicts" }),
				ev({ id: "c2", stance: "contradicts" }),
				ev({ id: "c3", stance: "contradicts" }),
				ev({ id: "c4", stance: "contradicts" }),
			]),
		);
		expect(four).toBeLessThan(two);
	});

	test("support does saturate, so repeating one fact cannot win an argument", () => {
		const three = likelihood(candidate("x", Array.from({ length: 3 }, (_, i) => ev({ id: `s${i}` }))));
		const thirty = likelihood(
			candidate("x", Array.from({ length: 30 }, (_, i) => ev({ id: `s${i}` }))),
		);
		expect(thirty).toBeGreaterThan(three);
		// Ten times the evidence buys well under twice the belief.
		expect(thirty / three).toBeLessThan(2);
	});
});

describe("decisive vetoes", () => {
	test("a decisive contradiction removes the candidate from the ranking", () => {
		const ranking = rankCauses([
			candidate("a", [
				...Array.from({ length: 10 }, (_, i) => ev({ id: `s${i}` })),
				ev({ id: "veto", stance: "contradicts", decisive: true, description: "file does not exist" }),
			]),
			candidate("b", [ev({ id: "s" })]),
		]);
		expect(ranking.causes.map((c) => c.id)).toEqual(["b"]);
		expect(ranking.vetoed).toHaveLength(1);
		expect(ranking.vetoed[0].veto_reason).toBe("file does not exist");
	});

	test("a vetoed candidate keeps its evidence for the record", () => {
		const ranking = rankCauses([
			candidate("a", [
				ev({ id: "s1" }),
				ev({ id: "veto", stance: "contradicts", decisive: true }),
			]),
		]);
		expect(ranking.vetoed[0].supporting).toHaveLength(1);
		expect(ranking.vetoed[0].support_score).toBeGreaterThan(0);
		expect(ranking.vetoed[0].confidence).toBe(0);
	});

	test("a decisive marker on supporting evidence is not a veto", () => {
		const ranking = rankCauses([
			candidate("a", [ev({ id: "s", decisive: true })]),
		]);
		expect(ranking.vetoed).toEqual([]);
		expect(ranking.causes).toHaveLength(1);
	});

	test("vetoing every candidate leaves an honest empty ranking", () => {
		const ranking = rankCauses([
			candidate("a", [ev({ id: "v", stance: "contradicts", decisive: true })]),
			candidate("b", [ev({ id: "v", stance: "contradicts", decisive: true })]),
		]);
		expect(ranking.causes).toEqual([]);
		expect(ranking.decisive).toBe(false);
		expect(ranking.indecision_reason).toContain("no candidate survived");
		expect(ranking.residual).toBe(1);
	});
});

describe("the residual", () => {
	test("three weak candidates produce a weak leader, not a confident one", () => {
		const weak = ["a", "b", "c"].map((id) =>
			candidate(id, [ev({ id: `${id}-s`, weight: 0.2, reliability: 0.3 })]),
		);
		const ranking = rankCauses(weak);
		expect(ranking.causes[0].confidence).toBeLessThan(0.4);
		expect(ranking.residual).toBeGreaterThan(0.5);
		expect(ranking.decisive).toBe(false);
	});

	test("a dominant residual is called out explicitly", () => {
		const ranking = rankCauses([candidate("a", [ev({ id: "s", weight: 0.1, reliability: 0.2 })])]);
		expect(
			ranking.caveats.some((c) => c.includes("candidate set is probably missing the real cause")),
		).toBe(true);
	});

	test("a strongly supported candidate drives the residual down", () => {
		const strong = candidate(
			"a",
			Array.from({ length: 8 }, (_, i) => ev({ id: `s${i}`, weight: 1, reliability: 1 })),
		);
		const ranking = rankCauses([strong]);
		expect(ranking.residual).toBeLessThan(0.1);
		expect(ranking.causes[0].confidence).toBeGreaterThan(0.9);
	});

	test("confidences and the residual sum to one", () => {
		const ranking = rankCauses([
			candidate("a", [ev({ id: "s1" }), ev({ id: "s2" })]),
			candidate("b", [ev({ id: "s3" })]),
			candidate("c", [ev({ id: "s4", weight: 0.3 })]),
		]);
		const total =
			ranking.causes.reduce((s, c) => s + c.raw_confidence, 0) + ranking.residual;
		expect(total).toBeCloseTo(1, 2);
	});

	test("no candidates at all is all residual", () => {
		const ranking = rankCauses([]);
		expect(ranking.residual).toBe(1);
		expect(ranking.causes).toEqual([]);
		expect(ranking.margin).toBe(0);
	});
});

describe("margin and decisiveness", () => {
	test("a near tie is not a diagnosis", () => {
		const ranking = rankCauses([
			candidate("a", Array.from({ length: 8 }, (_, i) => ev({ id: `a${i}`, weight: 1, reliability: 1 }))),
			candidate("b", Array.from({ length: 8 }, (_, i) => ev({ id: `b${i}`, weight: 1, reliability: 1 }))),
		]);
		expect(ranking.margin).toBeLessThan(MIN_MARGIN);
		expect(ranking.decisive).toBe(false);
		expect(ranking.indecision_reason).toContain("separated by");
	});

	test("a clear leader over a weak field is decisive", () => {
		const ranking = rankCauses([
			candidate("a", Array.from({ length: 8 }, (_, i) => ev({ id: `a${i}`, weight: 1, reliability: 1 }))),
			candidate("b", [ev({ id: "b", weight: 0.1, reliability: 0.2 })]),
		]);
		expect(ranking.decisive).toBe(true);
		expect(ranking.margin).toBeGreaterThanOrEqual(MIN_MARGIN);
		expect(ranking.indecision_reason).toBeUndefined();
	});

	test("a low-confidence leader is not decisive even when it is alone in front", () => {
		const ranking = rankCauses([
			candidate("a", [ev({ id: "s", weight: 0.25, reliability: 0.3 })]),
			candidate("b", [ev({ id: "s", weight: 0.05, reliability: 0.1 })]),
		]);
		expect(ranking.causes[0].confidence).toBeLessThan(MIN_LEADER_CONFIDENCE);
		expect(ranking.decisive).toBe(false);
		expect(ranking.indecision_reason).toContain("none of these");
	});

	test("the thresholds are configurable and both are enforced", () => {
		const candidates = [
			candidate("a", [ev({ id: "s", weight: 0.5, reliability: 0.6 })]),
			candidate("b", [ev({ id: "s", weight: 0.1, reliability: 0.2 })]),
		];
		expect(rankCauses(candidates, { min_leader_confidence: 0.01, min_margin: 0.01 }).decisive).toBe(
			true,
		);
		expect(rankCauses(candidates, { min_leader_confidence: 0.99 }).decisive).toBe(false);
		expect(rankCauses(candidates, { min_leader_confidence: 0.01, min_margin: 0.99 }).decisive).toBe(
			false,
		);
	});

	test("a single candidate has no runner-up and so no margin objection", () => {
		const ranking = rankCauses([
			candidate("a", Array.from({ length: 8 }, (_, i) => ev({ id: `s${i}`, weight: 1, reliability: 1 }))),
		]);
		expect(ranking.margin).toBe(ranking.causes[0].confidence);
		expect(ranking.decisive).toBe(true);
	});
});

describe("priors and evidence quality", () => {
	test("a prior shifts the ranking when evidence is equal", () => {
		const ranking = rankCauses([
			{ ...candidate("likely", [ev({ id: "s" })]), prior: 0.9 },
			{ ...candidate("unlikely", [ev({ id: "s" })]), prior: 0.1 },
		]);
		expect(ranking.causes[0].id).toBe("likely");
	});

	test("weight and reliability are separate, not pre-multiplied", () => {
		const strongFlaky = candidate("flaky", [ev({ id: "s", weight: 1, reliability: 0.3 })]);
		const weakSolid = candidate("solid", [ev({ id: "s", weight: 0.3, reliability: 1 })]);
		const ranking = rankCauses([strongFlaky, weakSolid]);
		// Equal contribution, but both numbers survive to the output.
		expect(ranking.causes[0].supporting[0].weight).not.toBe(
			ranking.causes[0].supporting[0].reliability,
		);
		expect(ranking.causes[0].support_score).toBeCloseTo(ranking.causes[1].support_score, 5);
	});

	test("out-of-range weights are clamped rather than trusted", () => {
		const ranking = rankCauses([
			candidate("a", [ev({ id: "s", weight: 5, reliability: 5 })]),
			candidate("b", [ev({ id: "s", weight: -3, reliability: 1 })]),
		]);
		expect(ranking.causes.find((c) => c.id === "a")!.support_score).toBe(1);
		expect(ranking.causes.find((c) => c.id === "b")!.support_score).toBe(0);
	});

	test("a candidate with no evidence at all gets essentially nothing", () => {
		const ranking = rankCauses([candidate("empty")]);
		expect(ranking.causes[0].confidence).toBeLessThan(0.01);
		expect(ranking.residual).toBeGreaterThan(0.9);
	});
});

describe("calibration", () => {
	test("an uncalibrated ranking says so", () => {
		const ranking = rankCauses([candidate("a", [ev({ id: "s" })])]);
		expect(ranking.caveats.some((c) => c.includes("uncalibrated"))).toBe(true);
	});

	test("a supplied map corrects the confidence and the raw value is retained", () => {
		// A corpus where 0.95-confidence predictions are right only 40% of the time.
		const map = fitCalibration(
			Array.from({ length: 40 }, (_, i) => ({
				id: `p${i}`,
				level: "file" as const,
				confidence: 0.95,
				ranked: [i % 5 < 2 ? "right" : "wrong"],
				truth: "right",
			})),
			10,
		);
		const ranking = rankCauses(
			[candidate("a", Array.from({ length: 8 }, (_, i) => ev({ id: `s${i}`, weight: 1, reliability: 1 })))],
			{ calibration: map },
		);
		expect(ranking.causes[0].raw_confidence).toBeGreaterThan(0.8);
		expect(ranking.causes[0].confidence).toBeLessThan(ranking.causes[0].raw_confidence);
		expect(ranking.caveats.some((c) => c.includes("uncalibrated"))).toBe(false);
	});

	test("an unobserved bin passes the raw confidence through unchanged", () => {
		const map = fitCalibration(
			Array.from({ length: 40 }, (_, i) => ({
				id: `p${i}`,
				level: "file" as const,
				confidence: 0.95,
				ranked: ["right"],
				truth: "right",
			})),
			10,
		);
		const ranking = rankCauses([candidate("a", [ev({ id: "s", weight: 0.2, reliability: 0.2 })])], {
			calibration: map,
		});
		expect(ranking.causes[0].confidence).toBe(ranking.causes[0].raw_confidence);
	});
});

describe("rendering", () => {
	test("contradictions are printed under the candidate that has them", () => {
		const text = renderRanking(
			rankCauses([
				candidate("a", [
					ev({ id: "s", description: "stack points here" }),
					ev({ id: "c", stance: "contradicts", description: "the file is unchanged" }),
				]),
			]),
		);
		expect(text).toContain("CONTRADICTS: the file is unchanged");
		expect(text).toContain("+ stack points here");
	});

	test("the residual is a line of the distribution, not a footnote", () => {
		const text = renderRanking(rankCauses([candidate("a", [ev({ id: "s" })])]));
		expect(text).toContain("(none of these)");
	});

	test("an indecisive ranking says so where a reader cannot miss it", () => {
		const text = renderRanking(
			rankCauses([
				candidate("a", [ev({ id: "s", weight: 0.2, reliability: 0.2 })]),
				candidate("b", [ev({ id: "s", weight: 0.2, reliability: 0.2 })]),
			]),
		);
		expect(text).toContain("NOT decisive");
	});

	test("vetoed candidates are listed with their reason", () => {
		const text = renderRanking(
			rankCauses([
				candidate("a", [
					ev({ id: "v", stance: "contradicts", decisive: true, description: "never executed" }),
				]),
			]),
		);
		expect(text).toContain("VETOED a — never executed");
	});
});
