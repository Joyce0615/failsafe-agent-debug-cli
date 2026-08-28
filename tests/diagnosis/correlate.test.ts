import { describe, expect, test } from "bun:test";
import {
	BASE_THRESHOLD,
	DEFAULT_WINDOW_MS,
	JOIN_STRENGTHS,
	MAX_THRESHOLD,
	SIGNAL_SOURCES,
	STRENGTH_CEILING,
	type Signal,
	chanceCoincidence,
	clusterSignals,
	correlate,
	correlationReport,
	direction,
	intervalGap,
	joinSignals,
	signalClass,
} from "../../src/diagnosis/correlate.js";

function sig(overrides: Partial<Signal> & { id: string; ts_ms: number }): Signal {
	return { source: "logs", label: `signal ${overrides.id}`, ...overrides };
}

describe("the join ladder", () => {
	test("a shared span id is the strongest join available", () => {
		const join = joinSignals(
			sig({ id: "a", ts_ms: 0, trace_id: "t1", span_id: "s1" }),
			sig({ id: "b", ts_ms: 999_999, trace_id: "t1", span_id: "s1" }),
		);
		expect(join).toEqual({ strength: "identity", key: "span_id", value: "s1" });
	});

	test("a shared trace id is identity even across a huge time gap", () => {
		const join = joinSignals(
			sig({ id: "a", ts_ms: 0, trace_id: "t1" }),
			sig({ id: "b", ts_ms: 10 ** 9, trace_id: "t1" }),
		);
		expect(join?.strength).toBe("identity");
	});

	test("service plus version outranks service alone", () => {
		const withVersion = joinSignals(
			sig({ id: "a", ts_ms: 0, service: "checkout", version: "1.2" }),
			sig({ id: "b", ts_ms: 0, service: "checkout", version: "1.2" }),
		);
		expect(withVersion?.key).toBe("service+version");
		const serviceOnly = joinSignals(
			sig({ id: "a", ts_ms: 0, service: "checkout", version: "1.2" }),
			sig({ id: "b", ts_ms: 10 ** 9, service: "checkout", version: "9.9" }),
		);
		expect(serviceOnly?.key).toBe("service");
		expect(serviceOnly?.strength).toBe("entity");
	});

	test("commit, file, and config key are content joins", () => {
		expect(
			joinSignals(sig({ id: "a", ts_ms: 0, commit: "abc" }), sig({ id: "b", ts_ms: 10 ** 9, commit: "abc" }))
				?.key,
		).toBe("commit");
		expect(
			joinSignals(
				sig({ id: "a", ts_ms: 0, file: "src/x.py" }),
				sig({ id: "b", ts_ms: 10 ** 9, file: "src/x.py" }),
			)?.strength,
		).toBe("content");
		expect(
			joinSignals(
				sig({ id: "a", ts_ms: 0, config_key: "TIMEOUT" }),
				sig({ id: "b", ts_ms: 10 ** 9, config_key: "TIMEOUT" }),
			)?.key,
		).toBe("config_key");
	});

	test("a stronger join is never downgraded just because time also matched", () => {
		const join = joinSignals(
			sig({ id: "a", ts_ms: 0, trace_id: "t1" }),
			sig({ id: "b", ts_ms: 10, trace_id: "t1" }),
		);
		expect(join?.strength).toBe("identity");
	});

	test("nothing but proximity yields a temporal join", () => {
		expect(joinSignals(sig({ id: "a", ts_ms: 0 }), sig({ id: "b", ts_ms: 1000 }))?.strength).toBe(
			"temporal",
		);
	});

	test("signals outside the window do not join at all", () => {
		expect(
			joinSignals(sig({ id: "a", ts_ms: 0 }), sig({ id: "b", ts_ms: DEFAULT_WINDOW_MS + 1 })),
		).toBeNull();
	});

	test("the ladder is ordered strongest first", () => {
		expect(JOIN_STRENGTHS).toEqual(["identity", "entity", "content", "temporal"]);
		for (let i = 1; i < JOIN_STRENGTHS.length; i++) {
			expect(STRENGTH_CEILING[JOIN_STRENGTHS[i]]).toBeLessThan(
				STRENGTH_CEILING[JOIN_STRENGTHS[i - 1]],
			);
		}
	});
});

describe("interval handling", () => {
	test("overlapping intervals have zero gap", () => {
		expect(
			intervalGap(sig({ id: "a", ts_ms: 0, end_ms: 100 }), sig({ id: "b", ts_ms: 50, end_ms: 150 })),
		).toBe(0);
	});

	test("the gap is measured edge to edge, not centre to centre", () => {
		expect(
			intervalGap(sig({ id: "a", ts_ms: 0, end_ms: 100 }), sig({ id: "b", ts_ms: 150 })),
		).toBe(50);
	});

	test("a long rollout can overlap a failure that a point comparison would miss", () => {
		const rollout = sig({ id: "d", ts_ms: 0, end_ms: 600_000, source: "deployment" });
		const failure = sig({ id: "f", ts_ms: 590_000 });
		expect(intervalGap(rollout, failure)).toBe(0);
		expect(direction(rollout, failure)).toBe("concurrent");
	});
});

describe("direction", () => {
	test("a candidate ending before the target precedes it", () => {
		expect(direction(sig({ id: "c", ts_ms: 0 }), sig({ id: "t", ts_ms: 100 }))).toBe("precedes");
	});

	test("a candidate starting after the target follows it", () => {
		expect(direction(sig({ id: "c", ts_ms: 200 }), sig({ id: "t", ts_ms: 100 }))).toBe("follows");
	});

	test("simultaneous signals are concurrent, not arbitrarily ordered", () => {
		expect(direction(sig({ id: "c", ts_ms: 100 }), sig({ id: "t", ts_ms: 100 }))).toBe(
			"concurrent",
		);
	});
});

describe("base rates", () => {
	test("a constantly occurring candidate makes coincidence certain", () => {
		// A deploy every four minutes over an hour, five-minute window.
		expect(chanceCoincidence(15, 5 * 60_000, 60 * 60_000)).toBe(1);
	});

	test("a rare candidate makes coincidence surprising", () => {
		expect(chanceCoincidence(1, 60_000, 24 * 60 * 60_000)).toBeLessThan(0.01);
	});

	test("zero occurrences or zero span yields zero chance rather than NaN", () => {
		expect(chanceCoincidence(0, 1000, 1000)).toBe(0);
		expect(chanceCoincidence(5, 1000, 0)).toBe(0);
	});

	test("the class key is specific enough to be meaningful", () => {
		expect(signalClass(sig({ id: "a", ts_ms: 0, source: "deployment", service: "checkout" }))).toBe(
			"deployment:checkout",
		);
		expect(
			signalClass(sig({ id: "a", ts_ms: 0, source: "configuration", config_key: "TIMEOUT" })),
		).toBe("configuration:TIMEOUT");
	});

	test("a noisy candidate ranks below a rare one despite identical proximity", () => {
		const target = sig({ id: "t", ts_ms: 1_000_000, service: "checkout" });
		const noisy = Array.from({ length: 40 }, (_, i) =>
			sig({
				id: `deploy${i}`,
				ts_ms: i * 25_000,
				source: "deployment",
				service: "checkout",
				label: "deploy",
			}),
		);
		const rare = sig({
			id: "cfg",
			ts_ms: 999_000,
			source: "configuration",
			service: "checkout",
			config_key: "TIMEOUT",
			label: "TIMEOUT changed",
		});
		const results = correlate(target, [...noisy, rare], { window_ms: 60_000 });
		expect(results[0].signal.id).toBe("cfg");
		const noisyResult = results.find((r) => r.signal.id.startsWith("deploy"));
		expect(noisyResult!.confidence).toBeLessThan(results[0].confidence);
		expect(noisyResult!.caveats.some((c) => c.includes("by chance"))).toBe(true);
	});
});

describe("correlation confidence", () => {
	const target = sig({ id: "t", ts_ms: 100_000, trace_id: "tr1", service: "checkout" });

	test("a temporal-only link is capped below its ceiling and carries a caveat", () => {
		const results = correlate(target, [sig({ id: "c", ts_ms: 99_000 })]);
		expect(results[0].join.strength).toBe("temporal");
		expect(results[0].confidence).toBeLessThanOrEqual(STRENGTH_CEILING.temporal);
		expect(results[0].caveats[0]).toContain("joined only by time");
	});

	test("an identity link outranks a temporal one at the same lag", () => {
		const results = correlate(target, [
			sig({ id: "same-trace", ts_ms: 99_000, trace_id: "tr1" }),
			sig({ id: "just-near", ts_ms: 99_000 }),
		]);
		expect(results[0].signal.id).toBe("same-trace");
		expect(results[0].confidence).toBeGreaterThan(results[1].confidence);
	});

	test("no join at all means no correlation, not a weak one", () => {
		expect(correlate(target, [sig({ id: "far", ts_ms: 100_000 + 10 ** 9 })])).toEqual([]);
	});

	test("a candidate that follows the target is kept, labelled, and penalized", () => {
		const results = correlate(target, [sig({ id: "after", ts_ms: 101_000, trace_id: "tr1" })]);
		expect(results[0].direction).toBe("follows");
		expect(results[0].caveats.some((c) => c.includes("cannot be a cause"))).toBe(true);
		expect(results[0].confidence).toBeLessThan(STRENGTH_CEILING.identity * 0.5);
	});

	test("lag is signed so precursors are distinguishable from consequences", () => {
		const results = correlate(target, [
			sig({ id: "before", ts_ms: 99_000, trace_id: "tr1" }),
			sig({ id: "after", ts_ms: 101_000, trace_id: "tr1" }),
		]);
		expect(results.find((r) => r.signal.id === "before")!.lag_ms).toBeLessThan(0);
		expect(results.find((r) => r.signal.id === "after")!.lag_ms).toBeGreaterThan(0);
	});

	test("the target never correlates with itself", () => {
		expect(correlate(target, [target])).toEqual([]);
	});

	test("results are deterministically ordered", () => {
		const candidates = [
			sig({ id: "b", ts_ms: 99_000 }),
			sig({ id: "a", ts_ms: 99_000 }),
			sig({ id: "c", ts_ms: 99_000 }),
		];
		const first = correlate(target, candidates).map((r) => r.signal.id);
		const second = correlate(target, [...candidates].reverse()).map((r) => r.signal.id);
		expect(first).toEqual(second);
	});

	test("even a unique candidate cannot exceed its join's ceiling", () => {
		const results = correlate(
			target,
			[sig({ id: "unique", ts_ms: 99_999, trace_id: "tr1", label: "one of a kind" })],
			{ observation_span_ms: 10 ** 9 },
		);
		expect(results[0].confidence).toBeLessThanOrEqual(STRENGTH_CEILING.identity);
	});
});

describe("the report", () => {
	const target = sig({ id: "t", ts_ms: 100_000, service: "checkout", trace_id: "tr1" });

	test("a wide search raises the confidence floor", () => {
		const few = correlationReport(target, [sig({ id: "a", ts_ms: 99_000, trace_id: "tr1" })]);
		const many = correlationReport(
			target,
			Array.from({ length: 200 }, (_, i) => sig({ id: `c${i}`, ts_ms: 99_000 - i })),
		);
		expect(few.adjusted_threshold).toBe(BASE_THRESHOLD);
		expect(many.adjusted_threshold).toBeGreaterThan(few.adjusted_threshold);
		expect(many.adjusted_threshold).toBeLessThanOrEqual(MAX_THRESHOLD);
	});

	test("the width of the search is stated, not just applied", () => {
		const report = correlationReport(
			target,
			Array.from({ length: 50 }, (_, i) => sig({ id: `c${i}`, ts_ms: 99_000 - i })),
		);
		expect(report.candidates_examined).toBe(50);
		expect(report.caveats.some((c) => c.includes("candidates examined"))).toBe(true);
	});

	test("surviving correlations are those at or above the adjusted floor", () => {
		const report = correlationReport(target, [
			sig({ id: "strong", ts_ms: 99_000, trace_id: "tr1", label: "same request" }),
			sig({ id: "weak", ts_ms: 99_500 }),
		]);
		expect(report.surviving.every((c) => c.confidence >= report.adjusted_threshold)).toBe(true);
		expect(report.surviving.map((c) => c.signal.id)).toContain("strong");
	});

	test("absent sources are named, because looking and not looking differ", () => {
		const report = correlationReport(target, [
			sig({ id: "a", ts_ms: 99_000, source: "logs" }),
			sig({ id: "b", ts_ms: 99_000, source: "traces" }),
		]);
		expect(report.sources_present).toEqual(["logs", "traces"]);
		expect(report.sources_missing).toContain("configuration");
		expect(report.sources_missing).toContain("deployment");
		expect(report.caveats.some((c) => c.includes("no candidates from"))).toBe(true);
	});

	test("an all-temporal result set says so plainly", () => {
		const report = correlationReport(target, [
			sig({ id: "a", ts_ms: 99_000 }),
			sig({ id: "b", ts_ms: 99_100 }),
		]);
		expect(report.caveats.some((c) => c.includes("temporal only"))).toBe(true);
	});

	test("a complete source set produces no missing-source caveat", () => {
		const report = correlationReport(
			target,
			SIGNAL_SOURCES.map((source, i) => sig({ id: `s${i}`, ts_ms: 99_000, source })),
		);
		expect(report.sources_missing).toEqual([]);
		expect(report.caveats.some((c) => c.includes("no candidates from"))).toBe(false);
	});

	test("no candidates at all is a well-formed empty report", () => {
		const report = correlationReport(target, []);
		expect(report.candidates_examined).toBe(0);
		expect(report.correlations).toEqual([]);
		expect(report.surviving).toEqual([]);
		expect(report.adjusted_threshold).toBe(BASE_THRESHOLD);
	});
});

describe("clustering", () => {
	test("signals sharing a join land in one cluster", () => {
		const clusters = clusterSignals([
			sig({ id: "a", ts_ms: 0, trace_id: "t1" }),
			sig({ id: "b", ts_ms: 10 ** 9, trace_id: "t1" }),
			sig({ id: "c", ts_ms: 5 * 10 ** 9, service: "other" }),
		]);
		expect(clusters).toHaveLength(2);
		expect(clusters[0].map((s) => s.id)).toEqual(["a", "b"]);
	});

	test("clustering is transitive, which is the conservative reading", () => {
		const clusters = clusterSignals([
			sig({ id: "a", ts_ms: 0, trace_id: "t1" }),
			sig({ id: "b", ts_ms: 10 ** 9, trace_id: "t1", service: "svc" }),
			sig({ id: "c", ts_ms: 5 * 10 ** 9, service: "svc" }),
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0]).toHaveLength(3);
	});

	test("unrelated signals stay in their own clusters", () => {
		const clusters = clusterSignals([
			sig({ id: "a", ts_ms: 0, service: "x" }),
			sig({ id: "b", ts_ms: 10 ** 9, service: "y" }),
			sig({ id: "c", ts_ms: 2 * 10 ** 9, service: "z" }),
		]);
		expect(clusters).toHaveLength(3);
	});

	test("clusters and their members are deterministically ordered", () => {
		const signals = [
			sig({ id: "z", ts_ms: 100, service: "a" }),
			sig({ id: "y", ts_ms: 50, service: "a" }),
			sig({ id: "x", ts_ms: 10 ** 9, service: "b" }),
		];
		const first = clusterSignals(signals).map((c) => c.map((s) => s.id));
		const second = clusterSignals([...signals].reverse()).map((c) => c.map((s) => s.id));
		expect(first).toEqual(second);
		expect(first[0]).toEqual(["y", "z"]);
	});

	test("an empty input yields no clusters", () => {
		expect(clusterSignals([])).toEqual([]);
	});
});
