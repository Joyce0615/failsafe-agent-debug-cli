/**
 * Normalize evaluation evidence and score semantics (item 41, item 107 in
 * this project's own module-header numbering convention — confirmed as the
 * next free number via `grep -rohE "item [0-9]+" src --include="*.ts" |
 * sort -t' ' -k2 -n -u`, highest prior use was item 106 from item 40's
 * `release/readiness-portfolio.ts`).
 *
 * The OpenTelemetry GenAI conventions define `gen_ai.evaluation.result` as an
 * event: an evaluator name, an optional numeric score, an optional human label,
 * an optional free-form explanation, and — critically for this item — no
 * constraint at all on what the score's bounds, direction, or scale ARE.
 * `grep -rn "gen_ai.evaluation\|EvaluationResult\|rating_scale" src` before
 * this module matched nothing: nothing in this codebase ingests an evaluator's
 * score, and nothing stops two evaluators who both emit a number called
 * "score" from being silently averaged or trended together even when one
 * reports 1..5 (higher is better) and the other reports 0..1 (lower is better,
 * an error rate). `ci/regression-gates.ts` (item 93) already has the right
 * instinct — `WORSE_DIRECTION` is per-metric, not shared — but it operates on
 * raw numeric samples a caller has ALREADY reduced to a comparable unit; this
 * module is the step before that, where the scale itself has not yet been
 * validated as comparable.
 *
 * Three things this module refuses to fake:
 *
 * 1. **A missing score is an abstention, never a zero.** An evaluator that
 *    could not score a response (timeout, refusal, malformed output) and one
 *    that scored a response "1" (the worst score on its scale) must never
 *    collapse to the same number downstream — an abstention excluded from a
 *    mean is honest; an abstention silently coerced to 0 poisons every
 *    average it touches, usually in the direction that makes a system look
 *    worse than it is (or, on an inverted scale, better).
 * 2. **A score outside its own declared bounds is evidence of a bug in the
 *    evaluator, not a data point.** `normalizeEvaluationResult` checks this
 *    and reports `normalized_score: null` with a caveat rather than clamping
 *    it into range, which would silently manufacture a boundary value nobody
 *    actually observed.
 * 3. **Two scales are compatible only when they are the SAME scale, not merely
 *    the same kind.** `scalesCompatible` treats `bounded 1..5` and
 *    `bounded 0..10` as incompatible even though both are "bounded" — a
 *    caller comparing or trending across them is comparing two different
 *    units that happen to both be numbers. `buildEvaluationTrend` and
 *    `compareEvaluationPolicies` both call `scalesCompatible` (plus an
 *    evaluator-identity and evaluation-name check) before doing any
 *    arithmetic, and REFUSE — not approximate — when it fails.
 *
 * Pure: no I/O, no model calls. Results come in already recorded.
 */

/** Direction in which a higher raw score is better, or the reverse. */
export const SCORE_DIRECTIONS = ["higher_is_better", "lower_is_better"] as const;
export type ScoreDirection = (typeof SCORE_DIRECTIONS)[number];

/** The level at which an evaluation result applies, mirroring the conventions' `gen_ai.evaluation.*` scope. */
export const RESULT_LEVELS = ["span", "session", "dataset"] as const;
export type ResultLevel = (typeof RESULT_LEVELS)[number];

/**
 * A rating scale, declared explicitly rather than inferred from one score's
 * shape. `bounded` carries its own min/max; `categorical` carries its own
 * ordered label set (best-last is not assumed — `direction` still applies to
 * the label's POSITION in the array); `unbounded` admits the scale has no
 * fixed range and therefore cannot be normalized to 0..1 at all.
 */
export type RatingScale =
	| { kind: "bounded"; min: number; max: number; direction: ScoreDirection }
	| { kind: "categorical"; labels: string[]; direction: ScoreDirection }
	| { kind: "unbounded"; direction: ScoreDirection };

/** Evaluator identity: a name/id plus an optional version, composed into one stable string. */
export type EvaluatorIdentity = { id: string; version?: string };

/** One `gen_ai.evaluation.result` event, as a caller would hand it in. */
export type RawEvaluationResult = {
	/** `gen_ai.evaluation.name` — the metric, e.g. "Relevance", "IntentResolution". */
	evaluation_name: string;
	evaluator: EvaluatorIdentity;
	/** `gen_ai.evaluation.score.value`. Absent means the evaluator did not score this. */
	score_value?: number;
	/** `gen_ai.evaluation.score.label`. May be the only evidence for a categorical scale. */
	score_label?: string;
	rating_scale: RatingScale;
	result_level: ResultLevel;
	/** `error.type`, when the evaluation ended in an error instead of a score. */
	error_type?: string;
	/** Free-form rater explanation. Carried through, never parsed for a score. */
	explanation?: string;
	/** Low-cardinality tags for slicing (suite, locale, dataset split, ...). */
	tags?: Record<string, string>;
	/** Caller-supplied uncertainty on the score itself, when the evaluator reports one. */
	uncertainty?: number;
	at_ms: number;
};

export type NormalizedEvaluationResult = {
	evaluation_name: string;
	evaluator_id: string;
	rating_scale: RatingScale;
	result_level: ResultLevel;
	at_ms: number;
	abstained: boolean;
	abstain_reason: string | null;
	/** Always 0..1, higher-is-better, regardless of the source scale's direction or bounds. `null` when it cannot be computed honestly. */
	normalized_score: number | null;
	uncertainty: number | null;
	tags: Record<string, string>;
	caveats: string[];
};

/** Compose an evaluator's identity into one stable, comparable string. */
export function evaluatorId(evaluator: EvaluatorIdentity): string {
	return evaluator.version ? `${evaluator.id}@${evaluator.version}` : evaluator.id;
}

/**
 * Normalize a bounded score to 0..1, higher-is-better, honoring the scale's
 * own declared direction. Returns `null` when the raw value is outside the
 * declared bounds — an out-of-bounds score is reported as a caveat by the
 * caller, never silently clamped here.
 */
function normalizeBounded(
	value: number,
	min: number,
	max: number,
	direction: ScoreDirection,
): number | null {
	if (value < min || value > max || max === min) return null;
	const fraction = (value - min) / (max - min);
	return direction === "higher_is_better" ? fraction : 1 - fraction;
}

/**
 * Normalize a categorical label to 0..1 by its position in the declared
 * label array (first = 0, last = 1, before direction is applied). A label not
 * present in the declared set returns `null` so the caller abstains rather
 * than guessing a position for an unknown category.
 */
function normalizeCategorical(
	label: string,
	labels: string[],
	direction: ScoreDirection,
): number | null {
	const idx = labels.indexOf(label);
	if (idx === -1 || labels.length < 2) return null;
	const fraction = idx / (labels.length - 1);
	return direction === "higher_is_better" ? fraction : 1 - fraction;
}

/**
 * Normalize one evaluation result.
 *
 * Abstention is checked first and is final: a result with no score has
 * nothing to normalize, however well-formed its scale declaration is.
 */
export function normalizeEvaluationResult(raw: RawEvaluationResult): NormalizedEvaluationResult {
	const caveats: string[] = [];
	const tags = raw.tags ?? {};
	const uncertainty = raw.uncertainty ?? null;
	const base = {
		evaluation_name: raw.evaluation_name,
		evaluator_id: evaluatorId(raw.evaluator),
		rating_scale: raw.rating_scale,
		result_level: raw.result_level,
		at_ms: raw.at_ms,
		uncertainty,
		tags,
	};

	const hasValue = raw.score_value !== undefined;
	const hasLabel = raw.score_label !== undefined;

	if (!hasValue && !hasLabel) {
		return {
			...base,
			abstained: true,
			abstain_reason: raw.error_type
				? `evaluator reported no score (error.type=${raw.error_type})`
				: "no score or label was reported for this evaluation",
			normalized_score: null,
			caveats,
		};
	}

	if (raw.rating_scale.kind === "categorical") {
		if (!hasLabel) {
			return {
				...base,
				abstained: true,
				abstain_reason: "categorical scale requires a score_label and none was supplied",
				normalized_score: null,
				caveats,
			};
		}
		const score = normalizeCategorical(
			raw.score_label as string,
			raw.rating_scale.labels,
			raw.rating_scale.direction,
		);
		if (score === null) {
			return {
				...base,
				abstained: true,
				abstain_reason: `score_label "${raw.score_label}" is not in the declared label set [${raw.rating_scale.labels.join(", ")}]`,
				normalized_score: null,
				caveats,
			};
		}
		return { ...base, abstained: false, abstain_reason: null, normalized_score: score, caveats };
	}

	if (raw.rating_scale.kind === "unbounded") {
		if (!hasValue) {
			return {
				...base,
				abstained: true,
				abstain_reason: raw.error_type
					? `evaluator reported no score (error.type=${raw.error_type})`
					: "no score was reported for this evaluation",
				normalized_score: null,
				caveats,
			};
		}
		caveats.push(
			"rating_scale is unbounded; a raw score has no fixed range and cannot be normalized to 0..1 without inventing one",
		);
		return { ...base, abstained: false, abstain_reason: null, normalized_score: null, caveats };
	}

	// bounded
	if (!hasValue) {
		return {
			...base,
			abstained: true,
			abstain_reason: raw.error_type
				? `evaluator reported no score (error.type=${raw.error_type})`
				: "no score was reported for this evaluation",
			normalized_score: null,
			caveats,
		};
	}
	const { min, max, direction } = raw.rating_scale;
	const value = raw.score_value as number;
	if (value < min || value > max) {
		caveats.push(
			`score ${value} is out of bounds for the declared bounded scale [${min}, ${max}]; treated as evaluator evidence of a bug, not a data point`,
		);
		return { ...base, abstained: false, abstain_reason: null, normalized_score: null, caveats };
	}
	const score = normalizeBounded(value, min, max, direction);
	return { ...base, abstained: false, abstain_reason: null, normalized_score: score, caveats };
}

export type EvaluationSuiteReport = {
	results: NormalizedEvaluationResult[];
	abstention_rate: number;
};

/** Normalize a whole batch of results and report the abstention rate across it. */
export function normalizeEvaluationSuite(raws: RawEvaluationResult[]): EvaluationSuiteReport {
	const results = raws.map(normalizeEvaluationResult);
	const abstention_rate =
		results.length === 0 ? 0 : results.filter((r) => r.abstained).length / results.length;
	return { results, abstention_rate };
}

/**
 * Whether two rating scales are the same comparable unit — not merely the
 * same `kind`. Bounded scales must share identical min/max/direction;
 * categorical scales must share an identical label set (order and all) and
 * direction; unbounded scales are never compatible with anything, including
 * another unbounded scale, because neither side has a defined range to
 * compare within.
 */
export function scalesCompatible(a: RatingScale, b: RatingScale): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "unbounded" || b.kind === "unbounded") return false;
	if (a.direction !== b.direction) return false;
	if (a.kind === "bounded" && b.kind === "bounded") {
		return a.min === b.min && a.max === b.max;
	}
	if (a.kind === "categorical" && b.kind === "categorical") {
		return a.labels.length === b.labels.length && a.labels.every((l, i) => l === b.labels[i]);
	}
	return false;
}

export type EvaluationTrendPoint = { at_ms: number; normalized_score: number };

export type EvaluationTrend = {
	refused: boolean;
	refused_reason: string | null;
	points: EvaluationTrendPoint[];
	caveats: string[];
};

/**
 * Build a time-ordered trend of normalized scores from a batch of raw
 * results.
 *
 * Refuses outright — rather than averaging across what it is given — when
 * the batch mixes more than one evaluator, more than one `evaluation_name`
 * metric, or scales `scalesCompatible` rejects. Abstained results are
 * excluded from the point series but never silently hidden: an all-abstained
 * batch produces an empty, non-refused trend with an explicit caveat, because
 * "nothing was ever scored" is a different fact from "the scales could not be
 * compared."
 */
export function buildEvaluationTrend(raws: RawEvaluationResult[]): EvaluationTrend {
	if (raws.length === 0) {
		return { refused: false, refused_reason: null, points: [], caveats: [] };
	}

	const evaluators = new Set(raws.map((r) => evaluatorId(r.evaluator)));
	if (evaluators.size > 1) {
		return {
			refused: true,
			refused_reason: `inputs span ${evaluators.size} distinct evaluator(s) (${[...evaluators].join(", ")}); a trend across different evaluators is not one trend`,
			points: [],
			caveats: [],
		};
	}

	const metrics = new Set(raws.map((r) => r.evaluation_name));
	if (metrics.size > 1) {
		return {
			refused: true,
			refused_reason: `inputs span ${metrics.size} distinct evaluation_name metric(s) (${[...metrics].join(", ")}); these are different metrics, not one trend`,
			points: [],
			caveats: [],
		};
	}

	const firstScale = raws[0]?.rating_scale as RatingScale;
	for (const r of raws) {
		if (!scalesCompatible(firstScale, r.rating_scale)) {
			return {
				refused: true,
				refused_reason:
					"inputs declare incompatible rating scales; comparing or trending across them would compare different units",
				points: [],
				caveats: [],
			};
		}
	}

	const normalized = raws.map(normalizeEvaluationResult);
	const abstained = normalized.filter((n) => n.abstained).length;
	const points = normalized
		.filter((n) => !n.abstained && n.normalized_score !== null)
		.map((n) => ({ at_ms: n.at_ms, normalized_score: n.normalized_score as number }))
		.sort((a, b) => a.at_ms - b.at_ms);

	const caveats: string[] = [];
	if (abstained > 0) {
		caveats.push(
			`${abstained} of ${raws.length} result(s) abstained (no score) and are excluded from the trend`,
		);
	}
	const outOfBounds = normalized.filter(
		(n) => !n.abstained && n.normalized_score === null && n.caveats.length > 0,
	).length;
	if (outOfBounds > 0) {
		caveats.push(
			`${outOfBounds} result(s) carried a score outside the declared scale bounds and are excluded`,
		);
	}

	return { refused: false, refused_reason: null, points, caveats };
}

export type PolicyComparison = {
	refused: boolean;
	refused_reason: string | null;
	before_mean: number | null;
	after_mean: number | null;
	/** Signed change in normalized (0..1, higher-is-better) units. */
	delta: number | null;
	before_n: number;
	after_n: number;
};

function meanScored(results: NormalizedEvaluationResult[]): number | null {
	const scored = results.filter((r) => !r.abstained && r.normalized_score !== null);
	if (scored.length === 0) return null;
	return scored.reduce((sum, r) => sum + (r.normalized_score as number), 0) / scored.length;
}

/**
 * Compare two batches of evaluation results (e.g. before/after a policy
 * change) as one normalized-score delta.
 *
 * Refuses the comparison — rather than reporting a delta between two
 * incomparable things — when either side changes evaluator or evaluation
 * metric relative to the other, when the scales are not `scalesCompatible`,
 * or when either side has no scored (non-abstained) results at all: a delta
 * against nothing is not a measurement.
 */
export function compareEvaluationPolicies(
	before: RawEvaluationResult[],
	after: RawEvaluationResult[],
): PolicyComparison {
	const combined = [...before, ...after];
	if (combined.length === 0) {
		return {
			refused: true,
			refused_reason: "no evaluation results were supplied on either side",
			before_mean: null,
			after_mean: null,
			delta: null,
			before_n: 0,
			after_n: 0,
		};
	}

	const evaluators = new Set(combined.map((r) => evaluatorId(r.evaluator)));
	if (evaluators.size > 1) {
		return {
			refused: true,
			refused_reason: `before/after span ${evaluators.size} distinct evaluator(s); the evaluator changed, not just the policy, so a delta would not isolate the policy's effect`,
			before_mean: null,
			after_mean: null,
			delta: null,
			before_n: before.length,
			after_n: after.length,
		};
	}

	const metrics = new Set(combined.map((r) => r.evaluation_name));
	if (metrics.size > 1) {
		return {
			refused: true,
			refused_reason: `before/after span ${metrics.size} distinct evaluation_name metric(s); these are different metrics`,
			before_mean: null,
			after_mean: null,
			delta: null,
			before_n: before.length,
			after_n: after.length,
		};
	}

	const firstScale = combined[0]?.rating_scale as RatingScale;
	for (const r of combined) {
		if (!scalesCompatible(firstScale, r.rating_scale)) {
			return {
				refused: true,
				refused_reason:
					"before/after declare incompatible rating scales; the comparison would be between different units",
				before_mean: null,
				after_mean: null,
				delta: null,
				before_n: before.length,
				after_n: after.length,
			};
		}
	}

	const beforeMean = meanScored(before.map(normalizeEvaluationResult));
	const afterMean = meanScored(after.map(normalizeEvaluationResult));
	if (beforeMean === null || afterMean === null) {
		return {
			refused: true,
			refused_reason: `${beforeMean === null ? "before" : "after"} side has no scored (non-abstained) results to compare`,
			before_mean: beforeMean,
			after_mean: afterMean,
			delta: null,
			before_n: before.length,
			after_n: after.length,
		};
	}

	return {
		refused: false,
		refused_reason: null,
		before_mean: beforeMean,
		after_mean: afterMean,
		delta: afterMean - beforeMean,
		before_n: before.length,
		after_n: after.length,
	};
}

/** Render a human-readable summary of an {@link EvaluationTrend}. */
export function renderEvaluationTrend(trend: EvaluationTrend): string {
	const lines: string[] = ["# Evaluation Trend", ""];
	if (trend.refused) {
		lines.push(`**Refused:** ${trend.refused_reason}`);
		return lines.join("\n");
	}
	lines.push(`${trend.points.length} point(s)`);
	for (const caveat of trend.caveats) lines.push(`- caveat: ${caveat}`);
	return lines.join("\n");
}
