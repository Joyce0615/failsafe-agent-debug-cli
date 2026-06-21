import type { RuleSource } from "./types.js";

/**
 * Cross-tier confidence calibration.
 *
 * Raw confidence comes from heterogeneous sources: declared rules carry an
 * author-set value, learned rules derive theirs from success/occurrence
 * statistics, and built-in templates use fixed heuristic values. Without
 * calibration these numbers are not comparable.
 *
 * Calibration enforces:
 *  - Per-tier ceilings reflecting evidence strength:
 *      declared (human-asserted for this project) can be the most confident,
 *      built-in (deterministic regex match) next, learned (statistical) capped
 *      until it has enough samples.
 *  - Learned rules are weighted by sample size: a rule seen only once cannot
 *    claim the same confidence as one corroborated by many occurrences.
 *  - A shared band vocabulary (high/medium/low) so agents can reason about
 *    confidence uniformly regardless of which tier produced the diagnosis.
 */
export type ConfidenceBand = "high" | "medium" | "low";

/** Minimum occurrences for a learned rule to reach its full confidence weight. */
export const LEARNED_FULL_WEIGHT_SAMPLES = 5;

const TIER_CEILING: Record<RuleSource, number> = {
	declared: 0.98,
	builtin: 0.95,
	learned: 0.9,
};

/** Map a calibrated confidence to its band. */
export function confidenceBand(confidence: number): ConfidenceBand {
	if (confidence >= 0.85) return "high";
	if (confidence >= 0.6) return "medium";
	return "low";
}

/**
 * Calibrate a raw confidence value for a given rule tier so values are
 * comparable across tiers. Never throws; always returns a value in [0, ceiling].
 */
export function calibrateConfidence(
	source: RuleSource,
	raw: number,
	meta?: { occurrenceCount?: number },
): number {
	let c = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0));

	if (source === "learned") {
		// Weight by sample size: a single observation is not as trustworthy as
		// many. Reaches full weight at LEARNED_FULL_WEIGHT_SAMPLES occurrences.
		const samples = Math.max(0, meta?.occurrenceCount ?? 1);
		const sampleFactor = Math.min(1, samples / LEARNED_FULL_WEIGHT_SAMPLES);
		c = c * sampleFactor;
	}

	return Math.min(c, TIER_CEILING[source]);
}
