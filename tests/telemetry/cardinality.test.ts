import { describe, expect, test } from "bun:test";
import {
	type CardinalityBudget,
	CardinalitySketch,
	DEFAULT_BUDGET,
	REDUCTION_STRATEGIES,
	analyzeDimensions,
	estimateSeries,
	explainCardinality,
	reduceValue,
	suggestStrategy,
} from "../../src/telemetry/cardinality.js";

describe("counting cardinality is itself bounded", () => {
	test("an exact count is exact and says so", () => {
		const sketch = new CardinalitySketch(10);
		for (const v of ["a", "b", "a", "c"]) sketch.add(v);
		expect(sketch.distinct).toBe(3);
		expect(sketch.count).toBe(4);
		expect(sketch.exact).toBe(true);
		expect(sketch.describe()).toBe("3 distinct");
	});

	test("beyond capacity it reports a lower bound rather than an estimate", () => {
		const sketch = new CardinalitySketch(5);
		for (let i = 0; i < 100; i++) sketch.add(`v${i}`);
		expect(sketch.exact).toBe(false);
		expect(sketch.distinct).toBe(5);
		expect(sketch.describe()).toBe("at least 5 distinct");
		expect(sketch.count).toBe(100);
	});

	test("repeats of an already-known value do not trip the overflow", () => {
		const sketch = new CardinalitySketch(3);
		for (const v of ["a", "b", "c"]) sketch.add(v);
		for (let i = 0; i < 100; i++) sketch.add("a");
		expect(sketch.exact).toBe(true);
		expect(sketch.distinct).toBe(3);
	});

	test("an empty sketch is exact and empty", () => {
		const sketch = new CardinalitySketch();
		expect(sketch.distinct).toBe(0);
		expect(sketch.exact).toBe(true);
		expect(sketch.sample()).toEqual([]);
	});
});

describe("reduction strategies", () => {
	test("keep is the identity and drop yields undefined, not an empty string", () => {
		expect(reduceValue("x", { strategy: "keep" })).toBe("x");
		expect(reduceValue("x", { strategy: "drop" })).toBeUndefined();
	});

	test("hash bucketing is stable and stays within the bucket count", () => {
		const buckets = new Set<string>();
		for (let i = 0; i < 500; i++) {
			buckets.add(reduceValue(`user-${i}`, { strategy: "hash_bucket", parameter: 8 })!);
		}
		expect(buckets.size).toBeLessThanOrEqual(8);
		expect(reduceValue("user-1", { strategy: "hash_bucket", parameter: 8 })).toBe(
			reduceValue("user-1", { strategy: "hash_bucket", parameter: 8 }),
		);
	});

	test("path truncation keeps the requested prefix and marks the cut", () => {
		expect(reduceValue("/api/v1/users/42/orders", { strategy: "truncate_path", segments: 2 })).toBe(
			"api/v1/*",
		);
	});

	test("a path already within the segment budget is untouched", () => {
		expect(reduceValue("/api/v1", { strategy: "truncate_path", segments: 2 })).toBe("/api/v1");
	});

	test("numeric bucketing produces half-open ranges", () => {
		expect(reduceValue("47", { strategy: "bucket_numeric", parameter: 10 })).toBe("40-50");
		expect(reduceValue("50", { strategy: "bucket_numeric", parameter: 10 })).toBe("50-60");
		expect(reduceValue("-3", { strategy: "bucket_numeric", parameter: 10 })).toBe("-10-0");
	});

	test("a non-numeric value under a numeric rule passes through so the mismatch surfaces", () => {
		// Bucketing it as 0 would hide the misconfiguration.
		expect(reduceValue("unknown", { strategy: "bucket_numeric", parameter: 10 })).toBe("unknown");
	});

	test("every declared strategy is implemented", () => {
		for (const strategy of REDUCTION_STRATEGIES) {
			expect(() => reduceValue("1/2", { strategy })).not.toThrow();
		}
	});
});

describe("strategy suggestion is semantic", () => {
	function sketchOf(values: string[]): CardinalitySketch {
		const sketch = new CardinalitySketch();
		for (const v of values) sketch.add(v);
		return sketch;
	}

	test("all-numeric values are bucketed", () => {
		expect(suggestStrategy("duration", sketchOf(["1", "2", "300"])).strategy).toBe(
			"bucket_numeric",
		);
	});

	test("path-shaped values are truncated", () => {
		expect(
			suggestStrategy("route", sketchOf(["/a/b/c", "/a/b/d", "/a/e/f"])).strategy,
		).toBe("truncate_path");
	});

	test("identifier-named keys are hashed into buckets", () => {
		for (const key of ["user_id", "session.id", "trace-id", "span_id", "uuid"]) {
			expect(suggestStrategy(key, sketchOf(["abc", "def"])).strategy).toBe("hash_bucket");
		}
	});

	test("the separator requirement is what keeps 'valid' from reading as an id", () => {
		// The conservative regex costs a camelCase `requestId`, which needs an
		// explicit rule. That is the right trade: mis-hashing a real dimension is
		// worse than asking for one line of config.
		expect(suggestStrategy("valid", sketchOf(["yes ok", "no ok"])).strategy).toBe("drop");
		expect(suggestStrategy("requestid", sketchOf(["a b", "c d"])).strategy).toBe("drop");
	});

	test("a key that looks like nothing recognizable is dropped rather than mangled", () => {
		expect(suggestStrategy("free_text", sketchOf(["hello there", "goodbye"])).strategy).toBe(
			"drop",
		);
	});

	test("a substring match does not make an id key", () => {
		expect(suggestStrategy("validated", sketchOf(["yes no", "maybe so"])).strategy).toBe("drop");
	});
});

describe("dimension analysis", () => {
	const records = Array.from({ length: 200 }, (_, i) => ({
		service: `svc-${i % 3}`,
		user_id: `user-${i}`,
		route: `/api/v1/items/${i}`,
		latency_ms: String(i * 3),
	}));

	test("a key inside its budget is kept and loses nothing", () => {
		const { dimensions } = analyzeDimensions(records);
		const service = dimensions.find((d) => d.key === "service")!;
		expect(service.within_budget).toBe(true);
		expect(service.strategy).toBe("keep");
		expect(service.lost_queries).toEqual([]);
		expect(service.retained_cardinality).toBe(3);
	});

	test("a key over its budget is reduced and the reduction shrinks it", () => {
		const { dimensions } = analyzeDimensions(records);
		const user = dimensions.find((d) => d.key === "user_id")!;
		expect(user.within_budget).toBe(false);
		expect(user.strategy).toBe("hash_bucket");
		expect(user.retained_cardinality).toBeLessThan(user.distinct);
	});

	test("an explicit rule overrides the suggestion", () => {
		const budget: CardinalityBudget = {
			...DEFAULT_BUDGET,
			rules: { user_id: { strategy: "drop" } },
		};
		const { dimensions } = analyzeDimensions(records, budget);
		const user = dimensions.find((d) => d.key === "user_id")!;
		expect(user.strategy).toBe("drop");
		expect(user.retained_cardinality).toBe(0);
	});

	test("a rule can also force a reduction on a key that was within budget", () => {
		const budget: CardinalityBudget = {
			...DEFAULT_BUDGET,
			rules: { service: { strategy: "drop" } },
		};
		const { dimensions } = analyzeDimensions(records, budget);
		expect(dimensions.find((d) => d.key === "service")!.strategy).toBe("drop");
	});

	test("dimensions are reported in a stable order", () => {
		const keys = analyzeDimensions(records).dimensions.map((d) => d.key);
		expect(keys).toEqual([...keys].sort());
	});

	test("an empty batch produces no dimensions rather than throwing", () => {
		const { dimensions, rules } = analyzeDimensions([]);
		expect(dimensions).toEqual([]);
		expect(rules).toEqual({});
	});

	test("a record missing a key does not create a phantom value for it", () => {
		const { dimensions } = analyzeDimensions([{ a: "1" }, { b: "2" }]);
		expect(dimensions.find((d) => d.key === "a")!.observed).toBe(1);
		expect(dimensions.find((d) => d.key === "b")!.observed).toBe(1);
	});
});

describe("the product is what kills a backend", () => {
	test("every key inside budget can still blow the series ceiling", () => {
		const records = Array.from({ length: 1000 }, (_, i) => ({
			a: `a${i % 50}`,
			b: `b${i % 50}`,
			c: `c${i % 50}`,
		}));
		const { dimensions } = analyzeDimensions(records, { max_per_key: 100, max_series: 10_000 });
		expect(dimensions.every((d) => d.within_budget)).toBe(true);
		const series = estimateSeries(dimensions, { max_per_key: 100, max_series: 10_000 });
		expect(series.estimated_series).toBe(125_000);
		expect(series.within_budget).toBe(false);
	});

	test("the dominant pair is named, because the fix is to reduce one of two", () => {
		const records = Array.from({ length: 400 }, (_, i) => ({
			big1: `x${i % 60}`,
			big2: `y${i % 60}`,
			small: `z${i % 2}`,
		}));
		const { dimensions } = analyzeDimensions(records, { max_per_key: 100, max_series: 100 });
		const series = estimateSeries(dimensions, { max_per_key: 100, max_series: 100 });
		expect(series.dominant_pair?.keys.sort()).toEqual(["big1", "big2"]);
		expect(series.dominant_pair?.product).toBe(3600);
	});

	test("dropped dimensions do not contribute to the product", () => {
		const records = Array.from({ length: 300 }, (_, i) => ({
			svc: `s${i % 3}`,
			noise: `free text ${i}`,
		}));
		const { dimensions } = analyzeDimensions(records);
		expect(dimensions.find((d) => d.key === "noise")!.strategy).toBe("drop");
		const series = estimateSeries(dimensions);
		expect(series.estimated_series).toBe(3);
		expect(series.contributors.map((c) => c.key)).toEqual(["svc"]);
	});

	test("no live dimensions means zero series, not one", () => {
		const series = estimateSeries([]);
		expect(series.estimated_series).toBe(0);
		expect(series.within_budget).toBe(true);
		expect(series.dominant_pair).toBeUndefined();
	});

	test("a single dimension has no dominant pair to name", () => {
		const records = Array.from({ length: 10 }, (_, i) => ({ svc: `s${i % 3}` }));
		const { dimensions } = analyzeDimensions(records);
		expect(estimateSeries(dimensions).dominant_pair).toBeUndefined();
	});
});

describe("explaining what was lost", () => {
	const records = Array.from({ length: 300 }, (_, i) => ({
		service: `svc-${i % 3}`,
		user_id: `user-${i}`,
	}));

	test("every reduction states what became unanswerable", () => {
		const result = explainCardinality(records);
		expect(result.explanations).toHaveLength(1);
		expect(result.explanations[0]).toContain("user_id");
		expect(result.explanations[0]).toContain("hash_bucket");
		expect(result.explanations[0]).toContain("alerts will not fire");
	});

	test("a kept dimension produces no explanation, because nothing was lost", () => {
		const result = explainCardinality(
			Array.from({ length: 10 }, (_, i) => ({ service: `svc-${i % 3}` })),
		);
		expect(result.explanations).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("dropping is described as collapsing existing dashboards, not as tidying", () => {
		const result = explainCardinality(records, {
			...DEFAULT_BUDGET,
			rules: { user_id: { strategy: "drop" } },
		});
		expect(result.explanations[0]).toContain("silently collapse into one series");
	});

	test("truncation explains that a leaf failure looks like a subtree failure", () => {
		const paths = Array.from({ length: 300 }, (_, i) => ({ route: `/api/v1/items/${i}` }));
		const result = explainCardinality(paths);
		expect(result.explanations[0]).toContain("whole subtree");
	});

	test("bucketing explains the percentile caveat", () => {
		const nums = Array.from({ length: 300 }, (_, i) => ({ latency_ms: String(i) }));
		const result = explainCardinality(nums);
		expect(result.explanations[0]).toContain("accurate only to the bucket width");
	});

	test("a series blow-up is warned about and blamed on the right pair", () => {
		const wide = Array.from({ length: 400 }, (_, i) => ({
			a: `a${i % 60}`,
			b: `b${i % 60}`,
		}));
		const result = explainCardinality(wide, { max_per_key: 100, max_series: 100 });
		expect(result.warnings.some((w) => w.includes("their product is not"))).toBe(true);
		expect(result.warnings.some((w) => w.includes("worth more than reducing everything else"))).toBe(
			true,
		);
	});

	test("an inexact count is flagged as a lower bound in the warnings", () => {
		const huge = Array.from({ length: 5000 }, (_, i) => ({ blob: `free text ${i}` }));
		const result = explainCardinality(huge);
		expect(result.warnings.some((w) => w.includes("lower bound, not a count"))).toBe(true);
	});
});
