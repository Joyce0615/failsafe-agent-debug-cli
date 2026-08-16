/**
 * Localization confidence calibration and top-k coverage (item 45).
 *
 * A confidence number is only useful if it means something: of the diagnoses
 * Failsafe calls 0.8, roughly 80% should be right. Nothing in the codebase has
 * checked that, and confidences assembled from rule tiers and heuristics are
 * exactly the kind that drift overconfident.
 *
 * This module measures it, per localization granularity, without pretending a
 * single accuracy number is the whole story:
 *
 * - **Reliability curve** — confidence binned against observed accuracy, with
 *   expected and maximum calibration error and a Brier score.
 * - **Top-k coverage** — recall@k and mean reciprocal rank at module, file,
 *   function, and line level, because a system can be excellent at naming the
 *   file and useless at naming the line.
 * - **Abstention** — coverage and the *risk* on the answered subset. Declining
 *   to answer is only a virtue if what remains is more accurate; the report says
 *   whether it is.
 * - **OOD slices** — the same metrics restricted to tagged subsets, so
 *   in-distribution performance cannot hide an out-of-distribution collapse.
 *
 * It also fits a calibrator: histogram binning maps a raw confidence onto the
 * accuracy actually observed in its bin. Deliberately non-parametric — a
 * temperature scale would assume a shape this data has no reason to have.
 *
 * Pure: no fs, network, clock, or randomness.
 */
import type { HypothesisLevel } from "./hypothesis.js";
import { HYPOTHESIS_LEVELS } from "./hypothesis.js";

/** One evaluated localization attempt. */
export type LocalizationPrediction = {
	id: string;
	level: HypothesisLevel;
	/** Model confidence in the top-ranked candidate, 0..1. */
	confidence: number;
	/** Candidate locations at this level, best first. Empty means abstained. */
	ranked: string[];
	/** The correct location at this level. */
	truth: string;
	/**
	 * Tags used to cut the report — e.g. `{ ood: "true", language: "rust" }`.
	 * Any key/value pair becomes a slice.
	 */
	slice?: Record<string, string>;
};

/** Whether a prediction's top candidate is correct. Abstention is never correct. */
export function isCorrect(p: LocalizationPrediction): boolean {
	return p.ranked.length > 0 && p.ranked[0] === p.truth;
}

export function abstained(p: LocalizationPrediction): boolean {
	return p.ranked.length === 0;
}

/** Rank of the truth (1-based), or 0 when absent. */
export function truthRank(p: LocalizationPrediction): number {
	const idx = p.ranked.indexOf(p.truth);
	return idx >= 0 ? idx + 1 : 0;
}

export type ReliabilityBin = {
	/** Half-open `[lower, upper)`, except the final bin which includes 1. */
	lower: number;
	upper: number;
	count: number;
	mean_confidence: number;
	accuracy: number;
	/** `mean_confidence - accuracy`; positive means overconfident. */
	gap: number;
};

export type ReliabilityCurve = {
	bins: ReliabilityBin[];
	/** Count-weighted mean |gap|. The headline calibration number. */
	expected_calibration_error: number;
	/** Worst single-bin |gap| over bins with data. */
	maximum_calibration_error: number;
	/** Mean squared error of confidence against outcome. Lower is better. */
	brier_score: number;
	/** Count-weighted signed gap: positive means systematically overconfident. */
	bias: number;
	samples: number;
};

const EMPTY_CURVE: ReliabilityCurve = {
	bins: [],
	expected_calibration_error: 0,
	maximum_calibration_error: 0,
	brier_score: 0,
	bias: 0,
	samples: 0,
};

function clamp01(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return Math.min(1, Math.max(0, v));
}

/**
 * Bin confidences and compare each bin's mean confidence to its observed
 * accuracy.
 *
 * Abstentions are excluded: a system that declined to answer made no confidence
 * claim, and scoring it as a confident error would conflate two different
 * behaviors. Abstention is measured separately by {@link abstentionReport}.
 */
export function reliabilityCurve(
	predictions: LocalizationPrediction[],
	binCount = 10,
): ReliabilityCurve {
	const answered = predictions.filter((p) => !abstained(p));
	if (answered.length === 0 || binCount < 1) return EMPTY_CURVE;

	const bins: ReliabilityBin[] = [];
	const buckets: LocalizationPrediction[][] = Array.from({ length: binCount }, () => []);
	for (const p of answered) {
		const c = clamp01(p.confidence);
		// The top bin is closed so a confidence of exactly 1 has a home.
		const idx = Math.min(binCount - 1, Math.floor(c * binCount));
		buckets[idx].push(p);
	}

	let ece = 0;
	let mce = 0;
	let bias = 0;
	for (let i = 0; i < binCount; i++) {
		const bucket = buckets[i];
		const lower = i / binCount;
		const upper = (i + 1) / binCount;
		if (bucket.length === 0) {
			bins.push({ lower, upper, count: 0, mean_confidence: 0, accuracy: 0, gap: 0 });
			continue;
		}
		const meanConfidence = bucket.reduce((a, p) => a + clamp01(p.confidence), 0) / bucket.length;
		const accuracy = bucket.filter(isCorrect).length / bucket.length;
		const gap = meanConfidence - accuracy;
		bins.push({
			lower,
			upper,
			count: bucket.length,
			mean_confidence: meanConfidence,
			accuracy,
			gap,
		});
		const weight = bucket.length / answered.length;
		ece += weight * Math.abs(gap);
		bias += weight * gap;
		mce = Math.max(mce, Math.abs(gap));
	}

	const brier =
		answered.reduce((a, p) => {
			const outcome = isCorrect(p) ? 1 : 0;
			const diff = clamp01(p.confidence) - outcome;
			return a + diff * diff;
		}, 0) / answered.length;

	return {
		bins,
		expected_calibration_error: ece,
		maximum_calibration_error: mce,
		brier_score: brier,
		bias,
		samples: answered.length,
	};
}

export type CoverageMetrics = {
	samples: number;
	/** recall@k keyed by k. */
	recall_at_k: Record<number, number>;
	mean_reciprocal_rank: number;
};

export const DEFAULT_KS = [1, 3, 5] as const;

/** Top-k recall and MRR over a set of predictions. */
export function topKCoverage(
	predictions: LocalizationPrediction[],
	ks: readonly number[] = DEFAULT_KS,
): CoverageMetrics {
	const n = predictions.length;
	const recall: Record<number, number> = {};
	for (const k of ks) {
		recall[k] =
			n === 0
				? 0
				: predictions.filter((p) => {
						const rank = truthRank(p);
						return rank > 0 && rank <= k;
					}).length / n;
	}
	const mrr =
		n === 0
			? 0
			: predictions.reduce((a, p) => {
					const rank = truthRank(p);
					return a + (rank > 0 ? 1 / rank : 0);
				}, 0) / n;
	return { samples: n, recall_at_k: recall, mean_reciprocal_rank: mrr };
}

export type AbstentionReport = {
	total: number;
	abstained: number;
	abstention_rate: number;
	/** Fraction of predictions that were answered. */
	coverage: number;
	/** Error rate on the answered subset. */
	risk: number;
	/** Accuracy over everything, counting abstentions as wrong. */
	accuracy_all: number;
	/** Accuracy over answered only. */
	accuracy_answered: number;
	/**
	 * `accuracy_answered - accuracy_all`. Positive means abstention is doing its
	 * job: what the system chose to answer really is more reliable. Zero or
	 * negative means it is declining at random (or worse, declining the ones it
	 * would have got right).
	 */
	selective_gain: number;
};

export function abstentionReport(predictions: LocalizationPrediction[]): AbstentionReport {
	const total = predictions.length;
	if (total === 0) {
		return {
			total: 0,
			abstained: 0,
			abstention_rate: 0,
			coverage: 0,
			risk: 0,
			accuracy_all: 0,
			accuracy_answered: 0,
			selective_gain: 0,
		};
	}
	const answered = predictions.filter((p) => !abstained(p));
	const correct = predictions.filter(isCorrect).length;
	const accuracyAll = correct / total;
	const accuracyAnswered = answered.length === 0 ? 0 : correct / answered.length;
	return {
		total,
		abstained: total - answered.length,
		abstention_rate: (total - answered.length) / total,
		coverage: answered.length / total,
		risk: answered.length === 0 ? 0 : 1 - accuracyAnswered,
		accuracy_all: accuracyAll,
		accuracy_answered: accuracyAnswered,
		selective_gain: accuracyAnswered - accuracyAll,
	};
}

export type SliceReport = {
	key: string;
	value: string;
	samples: number;
	accuracy: number;
	expected_calibration_error: number;
	mean_reciprocal_rank: number;
	abstention_rate: number;
};

/**
 * Cut the metrics by every tag present in the data.
 *
 * Slicing by *every* tag rather than only a caller-named one is deliberate: an
 * out-of-distribution collapse that nobody thought to look for is precisely the
 * one that matters.
 */
export function sliceReports(
	predictions: LocalizationPrediction[],
	ks: readonly number[] = DEFAULT_KS,
): SliceReport[] {
	const groups = new Map<string, LocalizationPrediction[]>();
	for (const p of predictions) {
		for (const [key, value] of Object.entries(p.slice ?? {})) {
			const composite = `${key}\u0000${value}`;
			const existing = groups.get(composite);
			if (existing) existing.push(p);
			else groups.set(composite, [p]);
		}
	}
	return [...groups.entries()]
		.map(([composite, subset]) => {
			const [key, value] = composite.split("\u0000");
			return {
				key,
				value,
				samples: subset.length,
				accuracy: subset.filter(isCorrect).length / subset.length,
				expected_calibration_error: reliabilityCurve(subset).expected_calibration_error,
				mean_reciprocal_rank: topKCoverage(subset, ks).mean_reciprocal_rank,
				abstention_rate: abstentionReport(subset).abstention_rate,
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
}

/** Piecewise-constant map from a raw confidence bin to its observed accuracy. */
export type CalibrationMap = {
	bin_count: number;
	/** `bins[i]` is the accuracy observed in bin i, or `null` when it had no data. */
	bins: Array<number | null>;
};

/**
 * Fit a histogram-binning calibrator.
 *
 * Non-parametric on purpose: a temperature scale would impose a logistic shape
 * that confidences assembled from rule tiers have no reason to follow. Bins with
 * no data are left `null` and fall through to the identity at apply time, so an
 * unobserved region is not silently invented.
 */
export function fitCalibration(
	predictions: LocalizationPrediction[],
	binCount = 10,
): CalibrationMap {
	const curve = reliabilityCurve(predictions, binCount);
	return {
		bin_count: binCount,
		bins:
			curve.bins.length === binCount
				? curve.bins.map((b) => (b.count > 0 ? b.accuracy : null))
				: Array.from({ length: binCount }, () => null),
	};
}

/** Apply a fitted calibrator. Unobserved bins pass the raw confidence through. */
export function applyCalibration(map: CalibrationMap, confidence: number): number {
	const c = clamp01(confidence);
	const idx = Math.min(map.bin_count - 1, Math.floor(c * map.bin_count));
	const value = map.bins[idx];
	return value === null || value === undefined ? c : value;
}

export type CalibrationReport = {
	samples: number;
	overall: {
		accuracy: number;
		reliability: ReliabilityCurve;
		coverage: CoverageMetrics;
		abstention: AbstentionReport;
	};
	/** The same metrics restricted to each localization granularity. */
	by_level: Array<{
		level: HypothesisLevel;
		samples: number;
		accuracy: number;
		reliability: ReliabilityCurve;
		coverage: CoverageMetrics;
	}>;
	slices: SliceReport[];
	/** Bins where confidence exceeds observed accuracy by more than the tolerance. */
	overconfident_bins: ReliabilityBin[];
	verdict: "calibrated" | "overconfident" | "underconfident" | "insufficient_data";
	recommendation: string;
};

/** Minimum samples before a calibration verdict is meaningful. */
export const MIN_CALIBRATION_SAMPLES = 30;
/** ECE below which confidences are treated as calibrated. */
export const CALIBRATION_TOLERANCE = 0.05;

export function calibrationReport(
	predictions: LocalizationPrediction[],
	opts: { bins?: number; ks?: readonly number[] } = {},
): CalibrationReport {
	const bins = opts.bins ?? 10;
	const ks = opts.ks ?? DEFAULT_KS;
	const reliability = reliabilityCurve(predictions, bins);
	const abstention = abstentionReport(predictions);

	const byLevel = HYPOTHESIS_LEVELS.map((level) => {
		const subset = predictions.filter((p) => p.level === level);
		return {
			level,
			samples: subset.length,
			accuracy: subset.length === 0 ? 0 : subset.filter(isCorrect).length / subset.length,
			reliability: reliabilityCurve(subset, bins),
			coverage: topKCoverage(subset, ks),
		};
	}).filter((entry) => entry.samples > 0);

	const overconfident = reliability.bins.filter(
		(b) => b.count > 0 && b.gap > CALIBRATION_TOLERANCE,
	);

	let verdict: CalibrationReport["verdict"];
	let recommendation: string;
	if (reliability.samples < MIN_CALIBRATION_SAMPLES) {
		verdict = "insufficient_data";
		recommendation = `Only ${reliability.samples} answered prediction(s); at least ${MIN_CALIBRATION_SAMPLES} are needed before a calibration verdict means anything.`;
	} else if (reliability.expected_calibration_error <= CALIBRATION_TOLERANCE) {
		verdict = "calibrated";
		recommendation = `ECE ${reliability.expected_calibration_error.toFixed(3)} is within tolerance; confidences can be read at face value.`;
	} else if (reliability.bias > 0) {
		verdict = "overconfident";
		recommendation = `ECE ${reliability.expected_calibration_error.toFixed(3)} with a +${reliability.bias.toFixed(3)} bias: confidences overstate accuracy in ${overconfident.length} bin(s). Fit a calibrator with fitCalibration() or lower the rule-tier confidence ceilings.`;
	} else {
		verdict = "underconfident";
		recommendation = `ECE ${reliability.expected_calibration_error.toFixed(3)} with a ${reliability.bias.toFixed(3)} bias: the system is more accurate than it claims, so downstream gates are abstaining more than they need to.`;
	}

	return {
		samples: predictions.length,
		overall: {
			accuracy: abstention.accuracy_all,
			reliability,
			coverage: topKCoverage(predictions, ks),
			abstention,
		},
		by_level: byLevel,
		slices: sliceReports(predictions, ks),
		overconfident_bins: overconfident,
		verdict,
		recommendation,
	};
}

/**
 * Parse localization predictions from JSONL, skipping malformed rows.
 *
 * Tolerant by design: an eval export with a few bad lines should still produce a
 * report rather than an exception, and the row count in the report makes any
 * silent loss visible.
 */
export function loadPredictions(jsonl: string): LocalizationPrediction[] {
	const out: LocalizationPrediction[] = [];
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const row = JSON.parse(trimmed) as Record<string, unknown>;
			const level = row.level;
			const truth = row.truth;
			if (typeof truth !== "string" || truth.length === 0) continue;
			if (!(HYPOTHESIS_LEVELS as readonly string[]).includes(level as string)) continue;
			const ranked = Array.isArray(row.ranked)
				? row.ranked.filter((v): v is string => typeof v === "string")
				: [];
			out.push({
				id: typeof row.id === "string" ? row.id : `row-${out.length + 1}`,
				level: level as HypothesisLevel,
				confidence: typeof row.confidence === "number" ? clamp01(row.confidence) : 0,
				ranked,
				truth,
				...(row.slice && typeof row.slice === "object"
					? {
							slice: Object.fromEntries(
								Object.entries(row.slice as Record<string, unknown>).map(([k, v]) => [
									k,
									String(v),
								]),
							),
						}
					: {}),
			});
		} catch {
			// Malformed line: skip.
		}
	}
	return out;
}
