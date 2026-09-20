/**
 * RACE-bench-style rubrics for intermediate localization and reasoning
 * (item 81).
 *
 * Outcome-only evaluation cannot distinguish a system that reasoned correctly
 * from one that guessed and happened to be right, and the difference is the
 * whole prediction of whether it will work on the next bug. Scoring the
 * *intermediate* steps is how that distinction is made, and it introduces a
 * problem outcome scoring does not have: rubric judgments are judgments, and a
 * rubric that two competent raters score differently is measuring the rater.
 *
 * Three commitments follow.
 *
 * 1. **Outcome and reasoning are scored independently, and the cross-tab is the
 *    result.** `lucky` (right answer, unsound reasoning) and `unlucky` (sound
 *    reasoning, wrong answer) are reported as their own cells. A high `lucky`
 *    rate is the single most useful early warning a benchmark can produce,
 *    because it says the headline number will not survive a distribution shift.
 *
 * 2. **A criterion that cannot be assessed from the trace is `unassessable`,
 *    not failed.** Scoring "did not explain its choice of file" as a failure
 *    when the trace format has nowhere to put an explanation measures the
 *    harness. Unassessable criteria are excluded from the score *and* counted,
 *    so a rubric that is mostly unassessable is visibly unusable.
 *
 * 3. **Agreement is measured before the scores are believed.** `cohenKappa`
 *    and the pooled `agreementReport` come with the interpretation bands, and
 *    a rubric criterion below the threshold is flagged as unreliable rather
 *    than averaged into a total that inherits its noise.
 *
 * Pure: no I/O, no model calls. Ratings come in already made.
 */

/** Dimensions a rubric can cover, mirroring the stages of a diagnosis. */
export const RUBRIC_DIMENSIONS = [
	"symptom_identification",
	"evidence_gathering",
	"mechanism",
	"localization",
	"alternative_consideration",
	"conclusion_support",
] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

export type RubricCriterion = {
	id: string;
	dimension: RubricDimension;
	/** The question a rater answers. Must be answerable from the trace alone. */
	question: string;
	/** Highest score this criterion can award. 1 makes it binary. */
	max_score: number;
	/** Weight within its dimension. */
	weight: number;
};

export type Rating = {
	criterion_id: string;
	rater: string;
	/** `null` means the trace contains nothing to assess this against. */
	score: number | null;
	/** Where in the trace the rater found the evidence. Required for a non-null score. */
	citation?: string;
};

export type CaseRating = {
	case_id: string;
	ratings: Rating[];
	/** Whether the system's final answer was correct. Scored separately. */
	outcome_correct: boolean;
};

export type CriterionResult = {
	criterion: RubricCriterion;
	/** Mean score across raters who could assess it, normalized to 0..1. */
	normalized_score: number | null;
	raters: number;
	unassessable_raters: number;
	/** Ratings with a score but no citation: a judgment with no basis. */
	uncited: number;
};

/**
 * Aggregate one criterion across raters for one case.
 *
 * A rating with a score but no citation is counted separately rather than
 * discarded: it is a judgment the rater could not point at, which is worth
 * knowing about the rating process even though the score still counts.
 */
export function scoreCriterion(criterion: RubricCriterion, ratings: Rating[]): CriterionResult {
	const mine = ratings.filter((r) => r.criterion_id === criterion.id);
	const assessed = mine.filter((r) => r.score !== null);
	const uncited = assessed.filter((r) => !r.citation || r.citation.length === 0).length;

	return {
		criterion,
		normalized_score:
			assessed.length === 0
				? null
				: assessed.reduce((sum, r) => sum + (r.score ?? 0), 0) /
					(assessed.length * criterion.max_score),
		raters: mine.length,
		unassessable_raters: mine.length - assessed.length,
		uncited,
	};
}

export type DimensionResult = {
	dimension: RubricDimension;
	/** Weighted mean over assessable criteria, or `null` when none were. */
	score: number | null;
	criteria: number;
	assessable_criteria: number;
};

/** Fraction of a dimension's criteria that must be assessable to score it. */
export const MIN_ASSESSABLE_FRACTION = 0.5;

export type ReasoningScore = {
	case_id: string;
	outcome_correct: boolean;
	/** Weighted mean over assessable dimensions, or `null`. */
	reasoning_score: number | null;
	dimensions: DimensionResult[];
	criteria: CriterionResult[];
	/** Criteria no rater could assess. */
	unassessable: string[];
	/** True when the reasoning cleared the soundness threshold. */
	reasoning_sound: boolean;
	caveats: string[];
};

/** Normalized reasoning score at or above which the reasoning counts as sound. */
export const SOUNDNESS_THRESHOLD = 0.7;

/**
 * Score one case against a rubric.
 *
 * A dimension whose criteria are mostly unassessable scores `null` rather than
 * being computed from the remainder: two criteria out of six is not a
 * measurement of the dimension, it is a measurement of two criteria wearing the
 * dimension's name.
 */
export function scoreReasoning(rubric: RubricCriterion[], rating: CaseRating): ReasoningScore {
	const criteria = rubric.map((c) => scoreCriterion(c, rating.ratings));
	const unassessable = criteria
		.filter((c) => c.normalized_score === null)
		.map((c) => c.criterion.id);

	const dimensions: DimensionResult[] = RUBRIC_DIMENSIONS.map((dimension) => {
		const inDimension = criteria.filter((c) => c.criterion.dimension === dimension);
		const assessable = inDimension.filter((c) => c.normalized_score !== null);
		const enough =
			inDimension.length > 0 && assessable.length / inDimension.length >= MIN_ASSESSABLE_FRACTION;
		const weight = assessable.reduce((sum, c) => sum + c.criterion.weight, 0);
		return {
			dimension,
			score:
				enough && weight > 0
					? assessable.reduce((sum, c) => sum + (c.normalized_score ?? 0) * c.criterion.weight, 0) /
						weight
					: null,
			criteria: inDimension.length,
			assessable_criteria: assessable.length,
		};
	}).filter((d) => d.criteria > 0);

	const scored = dimensions.filter((d) => d.score !== null);
	const reasoningScore =
		scored.length === 0 ? null : scored.reduce((sum, d) => sum + (d.score ?? 0), 0) / scored.length;

	const caveats: string[] = [];
	if (unassessable.length > 0) {
		caveats.push(
			`${unassessable.length} of ${rubric.length} criteria could not be assessed from the trace; they are excluded from the score rather than counted as failures`,
		);
	}
	const skipped = dimensions.filter((d) => d.score === null);
	if (skipped.length > 0) {
		caveats.push(
			`${skipped.length} dimension(s) had too few assessable criteria to score: ${skipped.map((d) => d.dimension).join(", ")}`,
		);
	}
	const uncited = criteria.reduce((sum, c) => sum + c.uncited, 0);
	if (uncited > 0) {
		caveats.push(
			`${uncited} rating(s) awarded a score with no citation into the trace; the score stands but the judgment has no stated basis`,
		);
	}

	return {
		case_id: rating.case_id,
		outcome_correct: rating.outcome_correct,
		reasoning_score: reasoningScore,
		dimensions,
		criteria,
		unassessable,
		reasoning_sound: reasoningScore !== null && reasoningScore >= SOUNDNESS_THRESHOLD,
		caveats,
	};
}

export type OutcomeReasoningTable = {
	/** Right answer for the right reasons. */
	sound_and_correct: number;
	/** Right answer, unsound reasoning: the cell that predicts fragility. */
	lucky: number;
	/** Sound reasoning, wrong answer: usually a corpus or ground-truth problem. */
	unlucky: number;
	sound_and_incorrect_reasoning_absent: number;
	/** Cases whose reasoning could not be scored at all. */
	unscored: number;
	total: number;
	/** lucky / (lucky + sound_and_correct): share of right answers unsupported. */
	luck_rate: number | null;
	interpretation: string;
};

/**
 * Cross-tabulate outcome against reasoning.
 *
 * This table is the product. A headline accuracy with a high `lucky` share is a
 * number that will not survive a distribution shift, and no amount of outcome
 * evaluation can see that coming.
 */
export function crossTabulate(scores: ReasoningScore[]): OutcomeReasoningTable {
	const scored = scores.filter((s) => s.reasoning_score !== null);
	const soundCorrect = scored.filter((s) => s.reasoning_sound && s.outcome_correct).length;
	const lucky = scored.filter((s) => !s.reasoning_sound && s.outcome_correct).length;
	const unlucky = scored.filter((s) => s.reasoning_sound && !s.outcome_correct).length;
	const neither = scored.filter((s) => !s.reasoning_sound && !s.outcome_correct).length;
	const correct = soundCorrect + lucky;

	return {
		sound_and_correct: soundCorrect,
		lucky,
		unlucky,
		sound_and_incorrect_reasoning_absent: neither,
		unscored: scores.length - scored.length,
		total: scores.length,
		luck_rate: correct > 0 ? lucky / correct : null,
		interpretation:
			correct === 0
				? "no correct outcomes to attribute"
				: lucky / correct > 0.3
					? `${((lucky / correct) * 100).toFixed(0)}% of correct answers came from unsound reasoning; the headline accuracy is unlikely to survive a distribution shift`
					: `${((lucky / correct) * 100).toFixed(0)}% of correct answers came from unsound reasoning`,
	};
}

/**
 * Cohen's kappa between two raters on one criterion.
 *
 * Returns `null` when there is nothing to compare or when the raters used only
 * one category — in which case kappa is undefined and the conventional
 * substitutes (0 or 1) are both actively misleading: perfect agreement on a
 * constant is not evidence of anything.
 */
export function cohenKappa(a: Array<number | null>, b: Array<number | null>): number | null {
	const pairs: Array<[number, number]> = [];
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] === null || b[i] === null) continue;
		pairs.push([a[i] as number, b[i] as number]);
	}
	if (pairs.length === 0) return null;

	const categories = [...new Set(pairs.flat())];
	if (categories.length < 2) return null;

	const observed = pairs.filter(([x, y]) => x === y).length / pairs.length;
	let expected = 0;
	for (const category of categories) {
		const pa = pairs.filter(([x]) => x === category).length / pairs.length;
		const pb = pairs.filter(([, y]) => y === category).length / pairs.length;
		expected += pa * pb;
	}
	if (expected >= 1) return null;
	return (observed - expected) / (1 - expected);
}

/** Kappa below which a criterion's ratings are not worth aggregating. */
export const MIN_ACCEPTABLE_KAPPA = 0.6;

export type CriterionAgreement = {
	criterion_id: string;
	/** Mean pairwise Cohen's kappa across rater pairs. */
	kappa: number | null;
	pairs: number;
	reliable: boolean;
	interpretation: string;
};

function interpretKappa(kappa: number | null): string {
	if (kappa === null) return "undefined: too few comparable ratings or only one category used";
	if (kappa < 0) return "worse than chance: the raters disagree systematically";
	if (kappa < 0.2) return "slight";
	if (kappa < 0.4) return "fair";
	if (kappa < 0.6) return "moderate";
	if (kappa < 0.8) return "substantial";
	return "almost perfect";
}

/**
 * Agreement per criterion, across all cases.
 *
 * Computed before any score is believed. A criterion two competent raters
 * disagree about is measuring the rater, and averaging it into a total exports
 * that noise into every number downstream.
 */
export function agreementReport(
	rubric: RubricCriterion[],
	cases: CaseRating[],
): { criteria: CriterionAgreement[]; unreliable: string[]; caveats: string[] } {
	const raters = [...new Set(cases.flatMap((c) => c.ratings.map((r) => r.rater)))].sort();

	const criteria: CriterionAgreement[] = rubric.map((criterion) => {
		const kappas: number[] = [];
		for (let i = 0; i < raters.length; i++) {
			for (let j = i + 1; j < raters.length; j++) {
				const a = cases.map(
					(c) =>
						c.ratings.find((r) => r.criterion_id === criterion.id && r.rater === raters[i])
							?.score ?? null,
				);
				const b = cases.map(
					(c) =>
						c.ratings.find((r) => r.criterion_id === criterion.id && r.rater === raters[j])
							?.score ?? null,
				);
				const kappa = cohenKappa(a, b);
				if (kappa !== null) kappas.push(kappa);
			}
		}
		const mean = kappas.length > 0 ? kappas.reduce((x, y) => x + y, 0) / kappas.length : null;
		return {
			criterion_id: criterion.id,
			kappa: mean,
			pairs: kappas.length,
			reliable: mean !== null && mean >= MIN_ACCEPTABLE_KAPPA,
			interpretation: interpretKappa(mean),
		};
	});

	const unreliable = criteria.filter((c) => !c.reliable).map((c) => c.criterion_id);
	const caveats: string[] = [];
	if (raters.length < 2) {
		caveats.push(
			`only ${raters.length} rater(s); inter-rater agreement cannot be computed, so nothing here establishes that the rubric measures the system rather than the rater`,
		);
	}
	if (unreliable.length > 0) {
		caveats.push(
			`${unreliable.length} criterion(a) fall below κ=${MIN_ACCEPTABLE_KAPPA}: ${unreliable.join(", ")}. Scores derived from them carry the raters' disagreement`,
		);
	}

	return { criteria, unreliable, caveats };
}
