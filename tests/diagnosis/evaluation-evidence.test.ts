import { describe, expect, test } from "bun:test";
import {
	type RawEvaluationResult,
	buildEvaluationTrend,
	compareEvaluationPolicies,
	normalizeEvaluationResult,
	normalizeEvaluationSuite,
	renderEvaluationTrend,
	scalesCompatible,
} from "../../src/diagnosis/evaluation-evidence.js";

function raw(overrides: Partial<RawEvaluationResult> = {}): RawEvaluationResult {
	return {
		evaluation_name: "Relevance",
		evaluator: { id: "gpt-judge", version: "2026-01" },
		score_value: 4,
		score_label: "relevant",
		rating_scale: { kind: "bounded", min: 1, max: 5, direction: "higher_is_better" },
		result_level: "span",
		at_ms: 1000,
		...overrides,
	};
}

describe("normalizeEvaluationResult", () => {
	test("a well-formed result normalizes with no caveats and is not abstained", () => {
		const n = normalizeEvaluationResult(raw());
		expect(n.abstained).toBe(false);
		expect(n.normalized_score).toBeCloseTo(0.75, 5); // (4-1)/(5-1)
		expect(n.caveats).toEqual([]);
		expect(n.evaluator_id).toBe("gpt-judge@2026-01");
	});

	test("a missing score_value with an error.type is an explicit abstention, not a zero", () => {
		const n = normalizeEvaluationResult(raw({ score_value: undefined, error_type: "timeout" }));
		expect(n.abstained).toBe(true);
		expect(n.normalized_score).toBeNull();
		expect(n.abstain_reason).toContain("timeout");
	});

	test("a missing score_value with no error is also an abstention, reason says so", () => {
		const n = normalizeEvaluationResult(raw({ score_value: undefined }));
		expect(n.abstained).toBe(true);
		expect(n.abstain_reason).toMatch(/no score/i);
	});

	test("a score outside its declared bounds is flagged, not silently clamped or trusted", () => {
		const n = normalizeEvaluationResult(raw({ score_value: 9 }));
		expect(n.caveats.some((c) => /out of bounds/i.test(c))).toBe(true);
		expect(n.normalized_score).toBeNull();
	});

	test("a lower_is_better scale is inverted so normalized_score is always higher-is-better", () => {
		const n = normalizeEvaluationResult(
			raw({
				rating_scale: { kind: "bounded", min: 0, max: 10, direction: "lower_is_better" },
				score_value: 2,
			}),
		);
		// raw 2 of 0..10 lower-is-better => good score => normalized close to 1
		expect(n.normalized_score).toBeCloseTo(0.8, 5);
	});

	test("a categorical scale with no score_value but a score_label still normalizes via the label map", () => {
		const n = normalizeEvaluationResult(
			raw({
				rating_scale: {
					kind: "categorical",
					labels: ["fail", "pass"],
					direction: "higher_is_better",
				},
				score_value: undefined,
				score_label: "pass",
			}),
		);
		expect(n.abstained).toBe(false);
		expect(n.normalized_score).toBeCloseTo(1, 5);
	});

	test("a categorical scale with an unrecognized label abstains rather than guessing a position", () => {
		const n = normalizeEvaluationResult(
			raw({
				rating_scale: {
					kind: "categorical",
					labels: ["fail", "pass"],
					direction: "higher_is_better",
				},
				score_value: undefined,
				score_label: "inconclusive",
			}),
		);
		expect(n.abstained).toBe(true);
		expect(n.abstain_reason).toMatch(/not in the declared label set/i);
	});

	test("an unbounded scale cannot be normalized to 0..1 and is flagged rather than faked", () => {
		const n = normalizeEvaluationResult(
			raw({
				rating_scale: { kind: "unbounded", direction: "higher_is_better" },
				score_value: 42,
			}),
		);
		expect(n.normalized_score).toBeNull();
		expect(n.caveats.some((c) => /unbounded/i.test(c))).toBe(true);
	});

	test("evaluator identity composes id and version; a missing version still produces a stable id", () => {
		const n = normalizeEvaluationResult(raw({ evaluator: { id: "rule-based" } }));
		expect(n.evaluator_id).toBe("rule-based");
	});

	test("tags pass through unchanged and are not inferred or dropped", () => {
		const n = normalizeEvaluationResult(raw({ tags: { suite: "nightly", locale: "en" } }));
		expect(n.tags).toEqual({ suite: "nightly", locale: "en" });
	});

	test("uncertainty, when declared, is carried through; when absent, it is explicitly null, not 0", () => {
		const withUncertainty = normalizeEvaluationResult(raw({ uncertainty: 0.1 }));
		expect(withUncertainty.uncertainty).toBe(0.1);
		const without = normalizeEvaluationResult(raw());
		expect(without.uncertainty).toBeNull();
	});

	test("result_level is carried through unchanged (span/session/dataset)", () => {
		expect(normalizeEvaluationResult(raw({ result_level: "session" })).result_level).toBe(
			"session",
		);
		expect(normalizeEvaluationResult(raw({ result_level: "dataset" })).result_level).toBe(
			"dataset",
		);
	});
});

describe("normalizeEvaluationSuite", () => {
	test("normalizes every result and reports how many abstained", () => {
		const suite = normalizeEvaluationSuite([raw(), raw({ score_value: undefined })]);
		expect(suite.results).toHaveLength(2);
		expect(suite.abstention_rate).toBeCloseTo(0.5, 5);
	});

	test("an empty suite reports zero abstention rate, not NaN", () => {
		const suite = normalizeEvaluationSuite([]);
		expect(suite.abstention_rate).toBe(0);
		expect(suite.results).toEqual([]);
	});
});

describe("scalesCompatible", () => {
	const bounded15 = {
		kind: "bounded" as const,
		min: 1,
		max: 5,
		direction: "higher_is_better" as const,
	};
	test("identical bounded scales are compatible", () => {
		expect(scalesCompatible(bounded15, bounded15)).toBe(true);
	});

	test("bounded scales with different ranges are NOT compatible even though both are bounded", () => {
		const bounded010 = {
			kind: "bounded" as const,
			min: 0,
			max: 10,
			direction: "higher_is_better" as const,
		};
		expect(scalesCompatible(bounded15, bounded010)).toBe(false);
	});

	test("a bounded scale and a categorical scale are never compatible", () => {
		const categorical = {
			kind: "categorical" as const,
			labels: ["fail", "pass"],
			direction: "higher_is_better" as const,
		};
		expect(scalesCompatible(bounded15, categorical)).toBe(false);
	});

	test("categorical scales with different label sets are not compatible, even same length", () => {
		const a = {
			kind: "categorical" as const,
			labels: ["fail", "pass"],
			direction: "higher_is_better" as const,
		};
		const b = {
			kind: "categorical" as const,
			labels: ["bad", "good"],
			direction: "higher_is_better" as const,
		};
		expect(scalesCompatible(a, b)).toBe(false);
	});

	test("two unbounded scales are never compatible since neither has a defined range", () => {
		const a = { kind: "unbounded" as const, direction: "higher_is_better" as const };
		const b = { kind: "unbounded" as const, direction: "higher_is_better" as const };
		expect(scalesCompatible(a, b)).toBe(false);
	});
});

describe("buildEvaluationTrend", () => {
	function series(scores: number[], evaluationName = "Relevance", startMs = 0) {
		return scores.map((s, i) =>
			raw({ score_value: s, at_ms: startMs + i * 1000, evaluation_name: evaluationName }),
		);
	}

	test("a trend across one evaluator/scale/metric computes normalized points in order", () => {
		const trend = buildEvaluationTrend(series([1, 2, 3, 4, 5]));
		expect(trend.refused).toBe(false);
		expect(trend.points).toHaveLength(5);
		expect(trend.points[0]?.at_ms).toBeLessThan(trend.points[4]?.at_ms ?? 0);
	});

	test("mixing two incompatible scales in one trend request refuses rather than silently averaging", () => {
		const mixed = [
			raw({
				score_value: 4,
				rating_scale: { kind: "bounded", min: 1, max: 5, direction: "higher_is_better" },
			}),
			raw({
				score_value: 8,
				rating_scale: { kind: "bounded", min: 0, max: 10, direction: "higher_is_better" },
			}),
		];
		const trend = buildEvaluationTrend(mixed);
		expect(trend.refused).toBe(true);
		expect(trend.refused_reason).toMatch(/incompatible/i);
	});

	test("mixing two distinct evaluators on the same scale also refuses: a trend is per-evaluator too", () => {
		const mixed = [raw({ evaluator: { id: "judge-a" } }), raw({ evaluator: { id: "judge-b" } })];
		const trend = buildEvaluationTrend(mixed);
		expect(trend.refused).toBe(true);
		expect(trend.refused_reason).toMatch(/evaluator/i);
	});

	test("mixing two distinct evaluation_name metrics refuses: relevance and toxicity are not one trend", () => {
		const mixed = [raw({ evaluation_name: "Relevance" }), raw({ evaluation_name: "Toxicity" })];
		const trend = buildEvaluationTrend(mixed);
		expect(trend.refused).toBe(true);
		expect(trend.refused_reason).toMatch(/evaluation_name|metric/i);
	});

	test("an all-abstained input series produces an empty, non-refused trend with an explicit caveat", () => {
		const allAbstained = [raw({ score_value: undefined }), raw({ score_value: undefined })];
		const trend = buildEvaluationTrend(allAbstained);
		expect(trend.refused).toBe(false);
		expect(trend.points).toEqual([]);
		expect(trend.caveats.some((c) => /abstained/i.test(c))).toBe(true);
	});

	test("an empty input list produces an empty, non-refused trend", () => {
		const trend = buildEvaluationTrend([]);
		expect(trend.refused).toBe(false);
		expect(trend.points).toEqual([]);
	});
});

describe("compareEvaluationPolicies", () => {
	function at(score: number) {
		return raw({ score_value: score });
	}

	test("comparing two policies on the same compatible scale reports a signed delta", () => {
		const before = [at(2), at(2), at(2)];
		const after = [at(4), at(4), at(4)];
		const cmp = compareEvaluationPolicies(before, after);
		expect(cmp.refused).toBe(false);
		expect(cmp.delta).toBeGreaterThan(0);
	});

	test("comparing across incompatible scales refuses the comparison outright", () => {
		const before = [
			raw({
				score_value: 4,
				rating_scale: { kind: "bounded", min: 1, max: 5, direction: "higher_is_better" },
			}),
		];
		const after = [
			raw({
				score_value: 8,
				rating_scale: { kind: "bounded", min: 0, max: 10, direction: "higher_is_better" },
			}),
		];
		const cmp = compareEvaluationPolicies(before, after);
		expect(cmp.refused).toBe(true);
		expect(cmp.refused_reason).toMatch(/incompatible/i);
	});

	test("comparing across different evaluators refuses: the judge changed, not just the policy", () => {
		const before = [raw({ evaluator: { id: "judge-a" } })];
		const after = [raw({ evaluator: { id: "judge-b" } })];
		const cmp = compareEvaluationPolicies(before, after);
		expect(cmp.refused).toBe(true);
		expect(cmp.refused_reason).toMatch(/evaluator/i);
	});

	test("one side being fully abstained refuses the comparison rather than comparing against nothing", () => {
		const before = [raw({ score_value: undefined })];
		const after = [at(4)];
		const cmp = compareEvaluationPolicies(before, after);
		expect(cmp.refused).toBe(true);
		expect(cmp.refused_reason).toMatch(/abstained|no scored/i);
	});
});

describe("renderEvaluationTrend", () => {
	test("renders a refusal reason when refused", () => {
		const mixed = [raw({ evaluator: { id: "a" } }), raw({ evaluator: { id: "b" } })];
		const text = renderEvaluationTrend(buildEvaluationTrend(mixed));
		expect(text).toMatch(/refused/i);
	});

	test("renders point count and caveats when not refused", () => {
		const trend = buildEvaluationTrend([raw({ score_value: 1 }), raw({ score_value: 5 })]);
		const text = renderEvaluationTrend(trend);
		expect(text).toContain("2");
	});
});
