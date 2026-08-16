import { describe, expect, test } from "bun:test";
import {
	CALIBRATION_TOLERANCE,
	DEFAULT_KS,
	type LocalizationPrediction,
	MIN_CALIBRATION_SAMPLES,
	abstentionReport,
	applyCalibration,
	calibrationReport,
	fitCalibration,
	isCorrect,
	loadPredictions,
	reliabilityCurve,
	sliceReports,
	topKCoverage,
	truthRank,
} from "../../src/diagnosis/calibration.js";
import type { HypothesisLevel } from "../../src/diagnosis/hypothesis.js";

function pred(
	overrides: Partial<LocalizationPrediction> & { id: string },
): LocalizationPrediction {
	return {
		level: "file",
		confidence: 0.8,
		ranked: ["src/a.ts"],
		truth: "src/a.ts",
		...overrides,
	};
}

/**
 * Build `n` predictions at a fixed confidence, of which `correctCount` are
 * right. Used to construct curves with a known calibration error.
 */
function cohort(
	n: number,
	confidence: number,
	correctCount: number,
	level: HypothesisLevel = "file",
	slice?: Record<string, string>,
): LocalizationPrediction[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `${level}-${confidence}-${i}`,
		level,
		confidence,
		ranked: [i < correctCount ? "truth" : "wrong"],
		truth: "truth",
		...(slice ? { slice } : {}),
	}));
}

describe("primitives", () => {
	test("an abstention is never correct and has no rank", () => {
		const p = pred({ id: "a", ranked: [] });
		expect(isCorrect(p)).toBe(false);
		expect(truthRank(p)).toBe(0);
	});

	test("rank is 1-based and 0 when the truth is unranked", () => {
		expect(truthRank(pred({ id: "b", ranked: ["x", "src/a.ts"] }))).toBe(2);
		expect(truthRank(pred({ id: "c", ranked: ["x", "y"] }))).toBe(0);
	});
});

describe("reliability curve", () => {
	test("a perfectly calibrated set has near-zero ECE", () => {
		const preds = [...cohort(100, 0.9, 90), ...cohort(100, 0.5, 50)];
		const curve = reliabilityCurve(preds);
		expect(curve.expected_calibration_error).toBeLessThan(0.02);
		expect(Math.abs(curve.bias)).toBeLessThan(0.02);
	});

	test("systematic overconfidence produces a positive bias", () => {
		const curve = reliabilityCurve(cohort(100, 0.9, 50));
		expect(curve.bias).toBeCloseTo(0.4, 2);
		expect(curve.expected_calibration_error).toBeCloseTo(0.4, 2);
		expect(curve.maximum_calibration_error).toBeCloseTo(0.4, 2);
	});

	test("systematic underconfidence produces a negative bias", () => {
		expect(reliabilityCurve(cohort(100, 0.3, 90)).bias).toBeCloseTo(-0.6, 2);
	});

	test("the Brier score rewards confident correctness and punishes confident error", () => {
		expect(reliabilityCurve(cohort(10, 1, 10)).brier_score).toBeCloseTo(0, 10);
		expect(reliabilityCurve(cohort(10, 1, 0)).brier_score).toBeCloseTo(1, 10);
	});

	test("a confidence of exactly 1 lands in the top bin, not out of range", () => {
		const curve = reliabilityCurve(cohort(10, 1, 10), 10);
		expect(curve.bins[9].count).toBe(10);
		expect(curve.samples).toBe(10);
	});

	test("abstentions are excluded rather than scored as confident errors", () => {
		const preds = [...cohort(10, 0.9, 9), pred({ id: "abstain", ranked: [], confidence: 0.9 })];
		expect(reliabilityCurve(preds).samples).toBe(10);
		expect(reliabilityCurve(preds).expected_calibration_error).toBeLessThan(0.02);
	});

	test("empty and all-abstained input yield an empty curve, not NaN", () => {
		expect(reliabilityCurve([]).samples).toBe(0);
		expect(reliabilityCurve([pred({ id: "a", ranked: [] })]).expected_calibration_error).toBe(0);
	});

	test("non-finite and out-of-range confidences are clamped", () => {
		const curve = reliabilityCurve([
			pred({ id: "a", confidence: Number.NaN }),
			pred({ id: "b", confidence: 5 }),
			pred({ id: "c", confidence: -2 }),
		]);
		expect(Number.isFinite(curve.expected_calibration_error)).toBe(true);
		expect(curve.samples).toBe(3);
	});
});

describe("top-k coverage", () => {
	const preds = [
		pred({ id: "a", ranked: ["truth"], truth: "truth" }),
		pred({ id: "b", ranked: ["x", "truth"], truth: "truth" }),
		pred({ id: "c", ranked: ["x", "y", "z", "truth"], truth: "truth" }),
		pred({ id: "d", ranked: ["x"], truth: "truth" }),
	];

	test("recall@k grows with k and never exceeds 1", () => {
		const cov = topKCoverage(preds);
		expect(cov.recall_at_k[1]).toBeCloseTo(0.25, 10);
		expect(cov.recall_at_k[3]).toBeCloseTo(0.5, 10);
		expect(cov.recall_at_k[5]).toBeCloseTo(0.75, 10);
	});

	test("MRR averages reciprocal ranks with misses contributing zero", () => {
		expect(topKCoverage(preds).mean_reciprocal_rank).toBeCloseTo((1 + 0.5 + 0.25 + 0) / 4, 10);
	});

	test("custom k values are honored", () => {
		expect(topKCoverage(preds, [2]).recall_at_k[2]).toBeCloseTo(0.5, 10);
		expect(DEFAULT_KS).toEqual([1, 3, 5]);
	});

	test("an empty set scores zero rather than NaN", () => {
		expect(topKCoverage([]).mean_reciprocal_rank).toBe(0);
		expect(topKCoverage([]).recall_at_k[1]).toBe(0);
	});
});

describe("abstention", () => {
	test("selective gain is positive when abstention removes the hard cases", () => {
		const preds = [
			...cohort(8, 0.9, 8),
			pred({ id: "s1", ranked: [] }),
			pred({ id: "s2", ranked: [] }),
		];
		const report = abstentionReport(preds);
		expect(report.abstention_rate).toBeCloseTo(0.2, 10);
		expect(report.coverage).toBeCloseTo(0.8, 10);
		expect(report.risk).toBeCloseTo(0, 10);
		expect(report.selective_gain).toBeGreaterThan(0);
	});

	test("selective gain is zero when nothing is declined", () => {
		expect(abstentionReport(cohort(10, 0.5, 5)).selective_gain).toBe(0);
	});

	test("abstaining on everything is coverage zero, not accuracy one", () => {
		const report = abstentionReport([pred({ id: "a", ranked: [] })]);
		expect(report.coverage).toBe(0);
		expect(report.accuracy_answered).toBe(0);
		expect(report.risk).toBe(0);
	});

	test("an empty set reports zeros", () => {
		expect(abstentionReport([]).total).toBe(0);
	});
});

describe("slices", () => {
	test("every tag becomes a slice, sorted deterministically", () => {
		const preds = [
			...cohort(10, 0.9, 9, "file", { ood: "false", language: "python" }),
			...cohort(10, 0.9, 2, "file", { ood: "true", language: "rust" }),
		];
		const slices = sliceReports(preds);
		expect(slices.map((s) => `${s.key}=${s.value}`)).toEqual([
			"language=python",
			"language=rust",
			"ood=false",
			"ood=true",
		]);
	});

	test("an out-of-distribution collapse is visible in its slice", () => {
		const preds = [
			...cohort(20, 0.9, 18, "file", { ood: "false" }),
			...cohort(20, 0.9, 2, "file", { ood: "true" }),
		];
		const slices = sliceReports(preds);
		const inDist = slices.find((s) => s.value === "false");
		const ood = slices.find((s) => s.value === "true");
		expect(inDist?.accuracy).toBeCloseTo(0.9, 10);
		expect(ood?.accuracy).toBeCloseTo(0.1, 10);
		expect(ood?.expected_calibration_error).toBeGreaterThan(0.5);
	});

	test("untagged predictions produce no slices", () => {
		expect(sliceReports(cohort(5, 0.5, 3))).toEqual([]);
	});
});

describe("calibration fitting", () => {
	test("a fitted map corrects a systematically overconfident bin", () => {
		const map = fitCalibration(cohort(100, 0.9, 50));
		expect(applyCalibration(map, 0.9)).toBeCloseTo(0.5, 2);
	});

	test("an unobserved bin passes the raw confidence through untouched", () => {
		const map = fitCalibration(cohort(50, 0.9, 25));
		expect(applyCalibration(map, 0.15)).toBeCloseTo(0.15, 10);
	});

	test("fitting on no data is the identity everywhere", () => {
		const map = fitCalibration([]);
		expect(applyCalibration(map, 0.42)).toBeCloseTo(0.42, 10);
	});

	test("applying is idempotent on an already-calibrated set", () => {
		const preds = [...cohort(50, 0.9, 45), ...cohort(50, 0.5, 25)];
		const map = fitCalibration(preds);
		expect(applyCalibration(map, 0.9)).toBeCloseTo(0.9, 2);
		expect(applyCalibration(map, 0.5)).toBeCloseTo(0.5, 2);
	});
});

describe("full report", () => {
	test("a well-calibrated corpus is reported as calibrated", () => {
		const report = calibrationReport([...cohort(100, 0.9, 90), ...cohort(100, 0.4, 40)]);
		expect(report.verdict).toBe("calibrated");
		expect(report.overconfident_bins).toEqual([]);
		expect(report.overall.reliability.expected_calibration_error).toBeLessThanOrEqual(
			CALIBRATION_TOLERANCE,
		);
	});

	test("an overconfident corpus names the offending bins and how to fix it", () => {
		const report = calibrationReport(cohort(100, 0.95, 40));
		expect(report.verdict).toBe("overconfident");
		expect(report.overconfident_bins.length).toBeGreaterThan(0);
		expect(report.recommendation).toContain("fitCalibration");
	});

	test("an underconfident corpus is called out separately", () => {
		const report = calibrationReport(cohort(100, 0.2, 90));
		expect(report.verdict).toBe("underconfident");
		expect(report.recommendation).toContain("more accurate than it claims");
	});

	test("too little data yields no verdict rather than a confident one", () => {
		const report = calibrationReport(cohort(5, 0.9, 1));
		expect(report.verdict).toBe("insufficient_data");
		expect(report.recommendation).toContain(String(MIN_CALIBRATION_SAMPLES));
	});

	test("granularity is broken out: strong on file, weak on line", () => {
		const report = calibrationReport([
			...cohort(40, 0.8, 36, "file"),
			...cohort(40, 0.8, 8, "line"),
		]);
		const file = report.by_level.find((l) => l.level === "file");
		const line = report.by_level.find((l) => l.level === "line");
		expect(file?.accuracy).toBeCloseTo(0.9, 10);
		expect(line?.accuracy).toBeCloseTo(0.2, 10);
		// Levels with no data are omitted rather than reported as zero.
		expect(report.by_level.map((l) => l.level)).toEqual(["file", "line"]);
	});

	test("levels are reported coarse-to-fine", () => {
		const report = calibrationReport([
			...cohort(2, 0.5, 1, "line"),
			...cohort(2, 0.5, 1, "module"),
			...cohort(2, 0.5, 1, "function"),
		]);
		expect(report.by_level.map((l) => l.level)).toEqual(["module", "function", "line"]);
	});
});

describe("prediction loading", () => {
	test("parses well-formed rows including slices", () => {
		const jsonl = [
			JSON.stringify({
				id: "p1",
				level: "file",
				confidence: 0.7,
				ranked: ["a", "b"],
				truth: "b",
				slice: { ood: true },
			}),
			JSON.stringify({ id: "p2", level: "line", confidence: 0.2, ranked: [], truth: "c" }),
		].join("\n");
		const preds = loadPredictions(jsonl);
		expect(preds).toHaveLength(2);
		expect(preds[0].slice).toEqual({ ood: "true" });
		expect(preds[1].ranked).toEqual([]);
	});

	test("malformed, truthless, and unknown-level rows are skipped, not guessed", () => {
		const jsonl = [
			"{not json",
			JSON.stringify({ id: "x", level: "file", ranked: ["a"] }),
			JSON.stringify({ id: "y", level: "package", ranked: ["a"], truth: "a" }),
			JSON.stringify({ id: "z", level: "file", ranked: ["a"], truth: "a" }),
		].join("\n");
		const preds = loadPredictions(jsonl);
		expect(preds.map((p) => p.id)).toEqual(["z"]);
	});

	test("a missing confidence defaults to zero rather than being invented", () => {
		const preds = loadPredictions(
			JSON.stringify({ id: "a", level: "file", ranked: ["a"], truth: "a" }),
		);
		expect(preds[0].confidence).toBe(0);
	});

	test("blank input yields no predictions", () => {
		expect(loadPredictions("\n\n   \n")).toEqual([]);
	});
});
