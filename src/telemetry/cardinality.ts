/**
 * Bounded-cardinality attributes and explained dimension drops (item 66).
 *
 * Item 41 caps distinct values per key and substitutes a placeholder. That
 * stops the worst outcome and leaves the reader with no idea what happened:
 * an attribute that quietly became `[HIGH_CARDINALITY]` looks identical to one
 * that was always that value, and every dashboard built on it is now wrong in a
 * way nobody can see. This module supplies the missing half — measurement,
 * named reduction strategies, and an explanation of what each drop cost.
 *
 * Three things it insists on:
 *
 * 1. **Counting cardinality must not itself be a cardinality problem.** An
 *    exact distinct-value set over an unbounded key is the leak it was meant to
 *    detect. `CardinalitySketch` is exact up to a capacity and then reports
 *    `at_least` — an honest lower bound rather than an extrapolated estimate
 *    with an error bar nobody will read.
 *
 * 2. **The killer is the product, not any single key.** Teams bound every
 *    attribute to 100 distinct values and are then surprised when three of them
 *    produce a million series. `estimateSeries` multiplies, names the pair of
 *    keys contributing most to the blow-up, and is the only number in this
 *    module that reflects what a metrics backend will actually store.
 *
 * 3. **A dropped dimension must say what became unanswerable.** "user_id was
 *    reduced" is not useful. "You can group by bucket-of-64 users but no longer
 *    identify an individual, and per-user rate alerts will not work" is. Every
 *    reduction carries that sentence, because the cost of a reduction is
 *    entirely in the questions it forecloses.
 *
 * Pure: no I/O, no global state beyond what a caller constructs.
 */

/**
 * Distinct-value counter that is exact up to a capacity and honest afterwards.
 *
 * Deliberately not a HyperLogLog. An approximate count with 2% error would be
 * more elegant and less useful here: the decision this feeds is "did this key
 * blow its budget", which needs a trustworthy answer near the threshold, and
 * "at least 2048" is both trustworthy and sufficient.
 */
export class CardinalitySketch {
	private readonly values = new Set<string>();
	private overflowed = false;
	private observations = 0;

	constructor(readonly capacity = 2048) {}

	add(value: string): void {
		this.observations++;
		if (this.values.size >= this.capacity && !this.values.has(value)) {
			this.overflowed = true;
			return;
		}
		this.values.add(value);
	}

	/** Distinct values counted. A lower bound once `exact` is false. */
	get distinct(): number {
		return this.values.size;
	}

	get exact(): boolean {
		return !this.overflowed;
	}

	get count(): number {
		return this.observations;
	}

	/** The values themselves, only meaningful while exact. */
	sample(limit = 10): string[] {
		return [...this.values].slice(0, limit);
	}

	describe(): string {
		return this.exact ? `${this.distinct} distinct` : `at least ${this.distinct} distinct`;
	}
}

export const REDUCTION_STRATEGIES = [
	"keep",
	"bucket_numeric",
	"truncate_path",
	"hash_bucket",
	"drop",
] as const;
export type ReductionStrategy = (typeof REDUCTION_STRATEGIES)[number];

export type KeyRule = {
	strategy: ReductionStrategy;
	/** For `hash_bucket`: how many buckets. For `bucket_numeric`: bucket width. */
	parameter?: number;
	/** For `truncate_path`: how many leading segments to keep. */
	segments?: number;
};

export type CardinalityBudget = {
	/** Distinct values tolerated per key before a reduction is required. */
	max_per_key: number;
	/**
	 * Ceiling on the *product* of retained cardinalities. This is the number
	 * that decides whether a metrics backend survives.
	 */
	max_series: number;
	/** Per-key overrides. Keys absent here are governed by `max_per_key`. */
	rules?: Record<string, KeyRule>;
};

export const DEFAULT_BUDGET: CardinalityBudget = {
	max_per_key: 100,
	max_series: 10_000,
};

/** FNV-1a, for stable bucket assignment across processes. */
function hashBucket(value: string, buckets: number): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % Math.max(1, buckets);
}

/**
 * Apply a reduction to one value.
 *
 * Returns `undefined` for `drop`, which is different from returning an empty
 * string: an absent attribute and an attribute whose value is `""` are
 * different facts, and conflating them is how a "no region" bucket appears in
 * a dashboard and gets investigated.
 */
export function reduceValue(value: string, rule: KeyRule): string | undefined {
	switch (rule.strategy) {
		case "keep":
			return value;
		case "drop":
			return undefined;
		case "hash_bucket":
			return `bucket_${hashBucket(value, rule.parameter ?? 64)}`;
		case "truncate_path": {
			const segments = rule.segments ?? 2;
			const parts = value.split("/").filter((p) => p.length > 0);
			if (parts.length <= segments) return value;
			return `${parts.slice(0, segments).join("/")}/*`;
		}
		case "bucket_numeric": {
			const width = rule.parameter ?? 10;
			const n = Number(value);
			// A non-numeric value under a numeric rule is a misconfiguration, and
			// bucketing it as 0 would hide that. Pass it through untouched so the
			// mismatch shows up in the cardinality report instead.
			if (!Number.isFinite(n)) return value;
			const lower = Math.floor(n / width) * width;
			return `${lower}-${lower + width}`;
		}
	}
}

/**
 * Which reduction to apply to a key that has blown its budget.
 *
 * Chosen from the key's *name and observed values*, because the right reduction
 * is a semantic question: an id wants hashing, a path wants truncation, a
 * duration wants bucketing. A single universal strategy would be wrong for two
 * of the three.
 */
export function suggestStrategy(key: string, sketch: CardinalitySketch): KeyRule {
	const lower = key.toLowerCase();
	const samples = sketch.sample(20);

	if (samples.length > 0 && samples.every((v) => Number.isFinite(Number(v)))) {
		return { strategy: "bucket_numeric", parameter: 10 };
	}
	if (samples.length > 0 && samples.every((v) => v.includes("/"))) {
		return { strategy: "truncate_path", segments: 2 };
	}
	if (/(^|[._-])(id|uuid|guid|token|session|request|trace|span)([._-]|$)/.test(lower)) {
		return { strategy: "hash_bucket", parameter: 64 };
	}
	// Nothing recognizable: dropping loses less than a bucketed value nobody can
	// interpret.
	return { strategy: "drop" };
}

export type DimensionReport = {
	key: string;
	observed: number;
	distinct: number;
	exact: boolean;
	within_budget: boolean;
	strategy: ReductionStrategy;
	/** Distinct values after the reduction, or the original when kept. */
	retained_cardinality: number;
	/** What a reader can no longer ask. Empty when nothing was reduced. */
	lost_queries: string[];
	sample: string[];
};

/**
 * Sentences describing what each reduction forecloses.
 *
 * Written out rather than generated, because the useful version of "what did I
 * lose" is specific, and a template would produce something technically true
 * and practically useless.
 */
function lostQueriesFor(key: string, rule: KeyRule): string[] {
	switch (rule.strategy) {
		case "keep":
			return [];
		case "drop":
			return [
				`cannot group, filter, or alert by '${key}' at all`,
				`any dashboard already broken down by '${key}' will silently collapse into one series`,
			];
		case "hash_bucket":
			return [
				`cannot identify an individual '${key}'; only its bucket of ${rule.parameter ?? 64}`,
				`per-'${key}' rate alerts will not fire, because one noisy value is averaged with its bucket-mates`,
				"two unrelated values sharing a bucket are indistinguishable",
			];
		case "truncate_path":
			return [
				`cannot distinguish paths below the first ${rule.segments ?? 2} segments of '${key}'`,
				"a failure specific to one leaf path appears as a failure of its whole subtree",
			];
		case "bucket_numeric":
			return [
				`cannot read an exact '${key}'; only a ${rule.parameter ?? 10}-wide range`,
				"percentiles computed from the bucketed value are accurate only to the bucket width",
			];
	}
}

/**
 * Analyse a batch of attribute records and decide what to do with each key.
 *
 * Takes complete records rather than a stream so the *joint* cardinality can be
 * computed. Per-key analysis alone cannot see the product, which is the number
 * that actually matters.
 */
export function analyzeDimensions(
	records: Array<Record<string, string>>,
	budget: CardinalityBudget = DEFAULT_BUDGET,
): { dimensions: DimensionReport[]; rules: Record<string, KeyRule> } {
	const sketches = new Map<string, CardinalitySketch>();
	for (const record of records) {
		for (const [key, value] of Object.entries(record)) {
			const sketch = sketches.get(key) ?? sketches.set(key, new CardinalitySketch()).get(key)!;
			sketch.add(value);
		}
	}

	const rules: Record<string, KeyRule> = {};
	const dimensions: DimensionReport[] = [];

	for (const [key, sketch] of [...sketches.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const configured = budget.rules?.[key];
		const within = sketch.exact && sketch.distinct <= budget.max_per_key;
		const rule: KeyRule =
			configured ?? (within ? { strategy: "keep" } : suggestStrategy(key, sketch));
		rules[key] = rule;

		const reduced = new CardinalitySketch();
		for (const record of records) {
			const raw = record[key];
			if (raw === undefined) continue;
			const value = reduceValue(raw, rule);
			if (value !== undefined) reduced.add(value);
		}

		dimensions.push({
			key,
			observed: sketch.count,
			distinct: sketch.distinct,
			exact: sketch.exact,
			within_budget: within,
			strategy: rule.strategy,
			retained_cardinality: rule.strategy === "drop" ? 0 : reduced.distinct,
			lost_queries: lostQueriesFor(key, rule),
			sample: sketch.sample(5),
		});
	}

	return { dimensions, rules };
}

export type SeriesEstimate = {
	/** Product of retained cardinalities: what a metrics backend will store. */
	estimated_series: number;
	within_budget: boolean;
	/**
	 * The two keys whose product contributes most to the total. Naming a pair
	 * rather than a single key is deliberate: the blow-up is multiplicative and
	 * the fix is usually to reduce one of two, not the single largest.
	 */
	dominant_pair?: { keys: [string, string]; product: number };
	/** Keys ordered by their contribution, largest first. */
	contributors: Array<{ key: string; cardinality: number }>;
};

/**
 * Estimate the series count from retained cardinalities.
 *
 * Multiplicative, which is the whole point. Every key can be inside its own
 * budget while the combination is three orders of magnitude over, and per-key
 * analysis will report everything as fine right up until the backend falls over.
 */
export function estimateSeries(
	dimensions: DimensionReport[],
	budget: CardinalityBudget = DEFAULT_BUDGET,
): SeriesEstimate {
	const live = dimensions
		.filter((d) => d.strategy !== "drop" && d.retained_cardinality > 0)
		.map((d) => ({ key: d.key, cardinality: d.retained_cardinality }))
		.sort((a, b) => b.cardinality - a.cardinality || a.key.localeCompare(b.key));

	const total = live.reduce((product, d) => product * d.cardinality, 1);
	const dominant =
		live.length >= 2
			? {
					keys: [live[0].key, live[1].key] as [string, string],
					product: live[0].cardinality * live[1].cardinality,
				}
			: undefined;

	return {
		estimated_series: live.length === 0 ? 0 : total,
		within_budget: (live.length === 0 ? 0 : total) <= budget.max_series,
		...(dominant ? { dominant_pair: dominant } : {}),
		contributors: live,
	};
}

export type CardinalityExplanation = {
	dimensions: DimensionReport[];
	series: SeriesEstimate;
	/** Human-readable account of every reduction and what it cost. */
	explanations: string[];
	warnings: string[];
};

/**
 * The whole story: what was measured, what was reduced, what it cost, and
 * whether the result still fits.
 *
 * `explanations` is the deliverable. A cardinality report that lists numbers
 * and not consequences gets skimmed and filed; one that says "per-user alerts
 * will not fire" gets acted on.
 */
export function explainCardinality(
	records: Array<Record<string, string>>,
	budget: CardinalityBudget = DEFAULT_BUDGET,
): CardinalityExplanation {
	const { dimensions } = analyzeDimensions(records, budget);
	const series = estimateSeries(dimensions, budget);

	const explanations: string[] = [];
	for (const dimension of dimensions) {
		if (dimension.strategy === "keep") continue;
		explanations.push(
			`'${dimension.key}' had ${dimension.exact ? "" : "at least "}${dimension.distinct} distinct values (budget ${budget.max_per_key}); applied ${dimension.strategy}, leaving ${dimension.retained_cardinality}. ${dimension.lost_queries.join(" ")}`,
		);
	}

	const warnings: string[] = [];
	if (!series.within_budget) {
		warnings.push(
			`estimated ${series.estimated_series} series against a budget of ${budget.max_series}; every key is individually bounded but their product is not`,
		);
		if (series.dominant_pair) {
			warnings.push(
				`'${series.dominant_pair.keys[0]}' × '${series.dominant_pair.keys[1]}' alone accounts for ${series.dominant_pair.product} series; reducing either is worth more than reducing everything else combined`,
			);
		}
	}
	for (const dimension of dimensions) {
		if (!dimension.exact) {
			warnings.push(
				`'${dimension.key}' exceeded the sketch capacity: ${dimension.distinct} is a lower bound, not a count`,
			);
		}
	}

	return { dimensions, series, explanations, warnings };
}
