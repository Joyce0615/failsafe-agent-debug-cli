import { describe, expect, test } from "bun:test";
import {
	type CaseRating,
	MIN_ACCEPTABLE_KAPPA,
	RUBRIC_DIMENSIONS,
	type Rating,
	type RubricCriterion,
	SOUNDNESS_THRESHOLD,
	agreementReport,
	cohenKappa,
	crossTabulate,
	scoreCriterion,
	scoreReasoning,
} from "../../src/bench/reasoning-rubric.js";

const RUBRIC: RubricCriterion[] = [
	{
		id: "sym1",
		dimension: "symptom_identification",
		question: "did it state the failing behaviour?",
		max_score: 1,
		weight: 1,
	},
	{
		id: "sym2",
		dimension: "symptom_identification",
		question: "did it distinguish symptom from cause?",
		max_score: 1,
		weight: 1,
	},
	{
		id: "loc1",
		dimension: "localization",
		question: "did it name the right file?",
		max_score: 2,
		weight: 2,
	},
	{
		id: "alt1",
		dimension: "alternative_consideration",
		question: "did it consider an alternative?",
		max_score: 1,
		weight: 1,
	},
];

function rating(
	criterion_id: string,
	rater: string,
	score: number | null,
	citation = "step 3",
): Rating {
	return { criterion_id, rater, score, ...(score !== null ? { citation } : {}) };
}

function caseRating(
	case_id: string,
	scores: Record<string, number | null>,
	outcome_correct: boolean,
	rater = "r1",
): CaseRating {
	return {
		case_id,
		outcome_correct,
		ratings: Object.entries(scores).map(([id, score]) => rating(id, rater, score)),
	};
}

describe("criterion scoring", () => {
	test("scores are normalized by the criterion's maximum", () => {
		const result = scoreCriterion(RUBRIC[2], [rating("loc1", "r1", 1)]);
		expect(result.normalized_score).toBe(0.5);
	});

	test("multiple raters are averaged", () => {
		const result = scoreCriterion(RUBRIC[0], [
			rating("sym1", "r1", 1),
			rating("sym1", "r2", 0),
		]);
		expect(result.normalized_score).toBe(0.5);
		expect(result.raters).toBe(2);
	});

	test("an unassessable rating is excluded and counted", () => {
		const result = scoreCriterion(RUBRIC[0], [
			rating("sym1", "r1", 1),
			rating("sym1", "r2", null),
		]);
		expect(result.normalized_score).toBe(1);
		expect(result.unassessable_raters).toBe(1);
	});

	test("all raters unable to assess yields null, not zero", () => {
		const result = scoreCriterion(RUBRIC[0], [rating("sym1", "r1", null)]);
		expect(result.normalized_score).toBeNull();
	});

	test("a score with no citation still counts but is flagged", () => {
		const result = scoreCriterion(RUBRIC[0], [
			{ criterion_id: "sym1", rater: "r1", score: 1 },
		]);
		expect(result.normalized_score).toBe(1);
		expect(result.uncited).toBe(1);
	});
});

describe("unassessable is not failed", () => {
	test("unassessable criteria are excluded and reported", () => {
		const score = scoreReasoning(
			RUBRIC,
			caseRating("c1", { sym1: 1, sym2: 1, loc1: null, alt1: null }, true),
		);
		expect(score.unassessable.sort()).toEqual(["alt1", "loc1"]);
		expect(score.caveats[0]).toContain("rather than counted as failures");
	});

	test("a mostly-unassessable dimension scores null rather than from the remainder", () => {
		const score = scoreReasoning(
			RUBRIC,
			caseRating("c1", { sym1: 1, sym2: null, loc1: 2, alt1: 1 }, true),
		);
		const symptom = score.dimensions.find((d) => d.dimension === "symptom_identification")!;
		// Half the criteria assessable is the boundary and is allowed.
		expect(symptom.score).toBe(1);
	});

	test("below the assessable fraction the dimension is skipped and named", () => {
		const wide: RubricCriterion[] = [
			...RUBRIC,
			{
				id: "sym3",
				dimension: "symptom_identification",
				question: "third",
				max_score: 1,
				weight: 1,
			},
		];
		const score = scoreReasoning(
			wide,
			caseRating("c1", { sym1: 1, sym2: null, sym3: null, loc1: 2, alt1: 1 }, true),
		);
		const symptom = score.dimensions.find((d) => d.dimension === "symptom_identification")!;
		expect(symptom.score).toBeNull();
		expect(score.caveats.some((c) => c.includes("too few assessable criteria"))).toBe(true);
	});

	test("nothing assessable at all yields a null reasoning score", () => {
		const score = scoreReasoning(
			RUBRIC,
			caseRating("c1", { sym1: null, sym2: null, loc1: null, alt1: null }, true),
		);
		expect(score.reasoning_score).toBeNull();
		expect(score.reasoning_sound).toBe(false);
	});

	test("weights apply within a dimension", () => {
		const weighted: RubricCriterion[] = [
			{ id: "a", dimension: "localization", question: "q", max_score: 1, weight: 3 },
			{ id: "b", dimension: "localization", question: "q", max_score: 1, weight: 1 },
		];
		const score = scoreReasoning(weighted, caseRating("c1", { a: 1, b: 0 }, true));
		expect(score.dimensions[0].score).toBe(0.75);
	});

	test("only dimensions present in the rubric appear", () => {
		const score = scoreReasoning(RUBRIC, caseRating("c1", { sym1: 1 }, true));
		const present = score.dimensions.map((d) => d.dimension);
		expect(present).toContain("symptom_identification");
		expect(present).not.toContain("mechanism");
		expect(RUBRIC_DIMENSIONS).toContain("mechanism");
	});
});

describe("soundness", () => {
	test("a high score is sound", () => {
		const score = scoreReasoning(
			RUBRIC,
			caseRating("c1", { sym1: 1, sym2: 1, loc1: 2, alt1: 1 }, true),
		);
		expect(score.reasoning_score).toBe(1);
		expect(score.reasoning_sound).toBe(true);
	});

	test("a low score is not sound", () => {
		const score = scoreReasoning(
			RUBRIC,
			caseRating("c1", { sym1: 0, sym2: 0, loc1: 0, alt1: 0 }, true),
		);
		expect(score.reasoning_sound).toBe(false);
	});

	test("the threshold is where the boundary sits", () => {
		expect(SOUNDNESS_THRESHOLD).toBeGreaterThan(0.5);
		expect(SOUNDNESS_THRESHOLD).toBeLessThan(1);
	});
});

describe("the outcome/reasoning cross-tab is the result", () => {
	function scores(spec: Array<{ sound: boolean; correct: boolean }>) {
		return spec.map((s, i) =>
			scoreReasoning(
				RUBRIC,
				caseRating(
					`c${i}`,
					s.sound
						? { sym1: 1, sym2: 1, loc1: 2, alt1: 1 }
						: { sym1: 0, sym2: 0, loc1: 0, alt1: 0 },
					s.correct,
				),
			),
		);
	}

	test("lucky and unlucky are their own cells", () => {
		const table = crossTabulate(
			scores([
				{ sound: true, correct: true },
				{ sound: false, correct: true },
				{ sound: true, correct: false },
				{ sound: false, correct: false },
			]),
		);
		expect(table.sound_and_correct).toBe(1);
		expect(table.lucky).toBe(1);
		expect(table.unlucky).toBe(1);
		expect(table.sound_and_incorrect_reasoning_absent).toBe(1);
	});

	test("a high luck rate is called out as a fragility warning", () => {
		const table = crossTabulate(
			scores([
				{ sound: false, correct: true },
				{ sound: false, correct: true },
				{ sound: true, correct: true },
			]),
		);
		expect(table.luck_rate).toBeCloseTo(2 / 3, 5);
		expect(table.interpretation).toContain("unlikely to survive a distribution shift");
	});

	test("a low luck rate is reported without the warning", () => {
		const table = crossTabulate(
			scores([
				{ sound: true, correct: true },
				{ sound: true, correct: true },
				{ sound: true, correct: true },
				{ sound: false, correct: true },
			]),
		);
		expect(table.interpretation).not.toContain("unlikely to survive");
	});

	test("cases whose reasoning could not be scored are counted apart", () => {
		const unscorable = scoreReasoning(
			RUBRIC,
			caseRating("x", { sym1: null, sym2: null, loc1: null, alt1: null }, true),
		);
		const table = crossTabulate([...scores([{ sound: true, correct: true }]), unscorable]);
		expect(table.unscored).toBe(1);
		expect(table.total).toBe(2);
	});

	test("no correct outcomes yields a null luck rate rather than a division by zero", () => {
		const table = crossTabulate(scores([{ sound: true, correct: false }]));
		expect(table.luck_rate).toBeNull();
		expect(table.interpretation).toContain("no correct outcomes");
	});
});

describe("agreement is measured before the scores are believed", () => {
	test("perfect agreement on a varied set gives kappa 1", () => {
		expect(cohenKappa([1, 0, 1, 0], [1, 0, 1, 0])).toBe(1);
	});

	test("systematic disagreement gives a negative kappa", () => {
		expect(cohenKappa([1, 0, 1, 0], [0, 1, 0, 1])!).toBeLessThan(0);
	});

	test("agreement on a constant is undefined, not perfect", () => {
		// Both raters said 1 every time; kappa is undefined and reporting 1 would
		// present a vacuous agreement as a strong one.
		expect(cohenKappa([1, 1, 1], [1, 1, 1])).toBeNull();
	});

	test("null ratings are excluded from the comparison", () => {
		expect(cohenKappa([1, null, 0], [1, 0, 0])).toBe(1);
	});

	test("no comparable ratings yields null", () => {
		expect(cohenKappa([null, null], [1, 0])).toBeNull();
		expect(cohenKappa([], [])).toBeNull();
	});

	test("a criterion two raters disagree on is flagged unreliable", () => {
		const cases: CaseRating[] = [0, 1, 2, 3].map((i) => ({
			case_id: `c${i}`,
			outcome_correct: true,
			ratings: [rating("sym1", "r1", i % 2), rating("sym1", "r2", (i + 1) % 2)],
		}));
		const report = agreementReport([RUBRIC[0]], cases);
		expect(report.criteria[0].reliable).toBe(false);
		expect(report.criteria[0].interpretation).toContain("disagree systematically");
		expect(report.unreliable).toEqual(["sym1"]);
	});

	test("a criterion the raters agree on is reliable", () => {
		const cases: CaseRating[] = [0, 1, 2, 3].map((i) => ({
			case_id: `c${i}`,
			outcome_correct: true,
			ratings: [rating("sym1", "r1", i % 2), rating("sym1", "r2", i % 2)],
		}));
		const report = agreementReport([RUBRIC[0]], cases);
		expect(report.criteria[0].kappa).toBe(1);
		expect(report.criteria[0].reliable).toBe(true);
		expect(report.criteria[0].interpretation).toBe("almost perfect");
	});

	test("a single rater cannot establish that the rubric measures the system", () => {
		const report = agreementReport([RUBRIC[0]], [caseRating("c1", { sym1: 1 }, true)]);
		expect(report.caveats[0]).toContain("cannot be computed");
		expect(report.criteria[0].kappa).toBeNull();
	});

	test("unreliable criteria are named in the caveats with the threshold", () => {
		const cases: CaseRating[] = [0, 1, 2, 3].map((i) => ({
			case_id: `c${i}`,
			outcome_correct: true,
			ratings: [rating("sym1", "r1", i % 2), rating("sym1", "r2", (i + 1) % 2)],
		}));
		const report = agreementReport([RUBRIC[0]], cases);
		expect(report.caveats.some((c) => c.includes(String(MIN_ACCEPTABLE_KAPPA)))).toBe(true);
	});

	test("three raters produce pairwise comparisons", () => {
		const cases: CaseRating[] = [0, 1, 2, 3].map((i) => ({
			case_id: `c${i}`,
			outcome_correct: true,
			ratings: [
				rating("sym1", "r1", i % 2),
				rating("sym1", "r2", i % 2),
				rating("sym1", "r3", i % 2),
			],
		}));
		expect(agreementReport([RUBRIC[0]], cases).criteria[0].pairs).toBe(3);
	});
});
