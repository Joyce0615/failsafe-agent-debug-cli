import { describe, expect, test } from "bun:test";
import {
	DEFAULT_ATTRIBUTION_WINDOW_MS,
	MIN_SERIES_LENGTH,
	type Observation,
	REVISION_KINDS,
	type Revision,
	analyzeChangePoints,
	attributeChangePoints,
	attributionsByKind,
	detectChangePoints,
} from "../../src/diagnosis/change-point.js";

const HOUR = 60 * 60_000;

/** A series with a mean shift from `before` to `after` at index `at`. */
function shifted(before: number, after: number, at: number, n = 40): Observation[] {
	return Array.from({ length: n }, (_, i) => ({
		at_ms: i * HOUR,
		// A tiny deterministic wobble so the variance is not exactly zero.
		value: (i < at ? before : after) + ((i % 3) - 1) * 0.01,
	}));
}

function revision(overrides: Partial<Revision> & { id: string; at_ms: number }): Revision {
	return { kind: "model", description: "a → b", ...overrides };
}

describe("detection", () => {
	test("a clean mean shift is found at the right index", () => {
		const points = detectChangePoints(shifted(1, 5, 20));
		expect(points).toHaveLength(1);
		expect(points[0].index).toBe(20);
		expect(points[0].before_mean).toBeCloseTo(1, 1);
		expect(points[0].after_mean).toBeCloseTo(5, 1);
	});

	test("the delta is signed so a drop and a jump are different events", () => {
		expect(detectChangePoints(shifted(5, 1, 20))[0].delta).toBeLessThan(0);
		expect(detectChangePoints(shifted(1, 5, 20))[0].delta).toBeGreaterThan(0);
	});

	test("a stationary series yields no change point", () => {
		const flat = Array.from({ length: 40 }, (_, i) => ({
			at_ms: i * HOUR,
			value: 3 + ((i % 5) - 2) * 0.1,
		}));
		expect(detectChangePoints(flat)).toEqual([]);
	});

	test("the penalty stops noise from being carved into segments", () => {
		const noisy = Array.from({ length: 60 }, (_, i) => ({
			at_ms: i * HOUR,
			value: 10 + Math.sin(i * 2.7) * 3,
		}));
		// Whatever it finds, it must not find a change point every few points.
		expect(detectChangePoints(noisy).length).toBeLessThan(6);
	});

	test("removing the penalty does produce far more splits, which is why it exists", () => {
		const noisy = Array.from({ length: 60 }, (_, i) => ({
			at_ms: i * HOUR,
			value: 10 + Math.sin(i * 2.7) * 3,
		}));
		const penalized = detectChangePoints(noisy);
		const unpenalized = detectChangePoints(noisy, { penalty: 0, min_segment: 2 });
		expect(unpenalized.length).toBeGreaterThan(penalized.length);
	});

	test("two real shifts are both found, in order", () => {
		const series: Observation[] = [
			...Array.from({ length: 20 }, (_, i) => ({ at_ms: i * HOUR, value: 1 })),
			...Array.from({ length: 20 }, (_, i) => ({ at_ms: (20 + i) * HOUR, value: 8 })),
			...Array.from({ length: 20 }, (_, i) => ({ at_ms: (40 + i) * HOUR, value: 2 })),
		];
		const points = detectChangePoints(series);
		expect(points.length).toBeGreaterThanOrEqual(2);
		expect(points[0].index).toBeLessThan(points[1].index);
	});

	test("a series shorter than two minimum segments yields nothing", () => {
		expect(detectChangePoints(shifted(1, 5, 4, 8), { min_segment: 5 })).toEqual([]);
	});

	test("effect size is expressed in pooled standard deviations", () => {
		const big = detectChangePoints(shifted(1, 20, 20))[0];
		const small = detectChangePoints(shifted(1, 1.1, 20))[0];
		expect(Math.abs(big.effect_size)).toBeGreaterThan(Math.abs(small?.effect_size ?? 0));
	});
});

describe("refusal on short series", () => {
	test("fewer than the minimum observations refuses with a reason", () => {
		const report = analyzeChangePoints(shifted(1, 5, 5, 10), []);
		expect(report.change_points).toEqual([]);
		expect(report.refused_reason).toContain(String(MIN_SERIES_LENGTH));
	});

	test("the refusal is repeated in the caveats so it cannot be skipped", () => {
		const report = analyzeChangePoints(shifted(1, 5, 5, 10), []);
		expect(report.caveats[0]).toContain(String(MIN_SERIES_LENGTH));
	});

	test("at exactly the minimum, detection proceeds", () => {
		const report = analyzeChangePoints(shifted(1, 6, 10, MIN_SERIES_LENGTH), []);
		expect(report.refused_reason).toBeUndefined();
	});
});

describe("attribution", () => {
	const points = detectChangePoints(shifted(1, 5, 20));

	test("a single candidate revision is attributed", () => {
		const result = attributeChangePoints(points, [
			revision({ id: "r1", at_ms: 20 * HOUR - 1000, kind: "model" }),
		]);
		expect(result[0].verdict).toBe("attributed");
		expect(result[0].revision?.id).toBe("r1");
	});

	test("several candidates are confounded and none is ranked", () => {
		const result = attributeChangePoints(points, [
			revision({ id: "r1", at_ms: 20 * HOUR - 3000, kind: "model" }),
			revision({ id: "r2", at_ms: 20 * HOUR - 2000, kind: "prompt" }),
			revision({ id: "r3", at_ms: 20 * HOUR - 1000, kind: "dependency" }),
		]);
		expect(result[0].verdict).toBe("confounded");
		expect(result[0].revision).toBeUndefined();
		expect(result[0].candidates).toHaveLength(3);
		expect(result[0].detail).toContain("cannot say which one");
	});

	test("a confound in one release names the staggered rollout as the resolution", () => {
		const result = attributeChangePoints(points, [
			revision({ id: "r1", at_ms: 20 * HOUR - 2000, release: "v42" }),
			revision({ id: "r2", at_ms: 20 * HOUR - 1000, kind: "prompt", release: "v42" }),
		]);
		expect(result[0].resolution).toContain("staggered rollout");
		expect(result[0].resolution).toContain("not further analysis");
	});

	test("a change with no candidate is unexplained, not attributed to the nearest thing", () => {
		const result = attributeChangePoints(points, [
			revision({ id: "old", at_ms: 20 * HOUR - 10 * DEFAULT_ATTRIBUTION_WINDOW_MS }),
		]);
		expect(result[0].verdict).toBe("unexplained");
		expect(result[0].candidates).toEqual([]);
	});

	test("a revision after the change point is never a candidate", () => {
		// The release that shipped in response to the incident is the most
		// seductive wrong answer available.
		const result = attributeChangePoints(points, [
			revision({ id: "response", at_ms: 20 * HOUR + 1000 }),
		]);
		expect(result[0].verdict).toBe("unexplained");
	});

	test("the window is configurable", () => {
		const revisions = [revision({ id: "r1", at_ms: 20 * HOUR - 5 * HOUR })];
		expect(attributeChangePoints(points, revisions, HOUR)[0].verdict).toBe("unexplained");
		expect(attributeChangePoints(points, revisions, 10 * HOUR)[0].verdict).toBe("attributed");
	});

	test("candidates are returned in time order", () => {
		const result = attributeChangePoints(points, [
			revision({ id: "later", at_ms: 20 * HOUR - 1000 }),
			revision({ id: "earlier", at_ms: 20 * HOUR - 5000 }),
		]);
		expect(result[0].candidates.map((c) => c.id)).toEqual(["earlier", "later"]);
	});
});

describe("the report", () => {
	test("counts split the three verdicts", () => {
		const series: Observation[] = [
			...Array.from({ length: 20 }, (_, i) => ({ at_ms: i * HOUR, value: 1 })),
			...Array.from({ length: 20 }, (_, i) => ({ at_ms: (20 + i) * HOUR, value: 9 })),
		];
		const report = analyzeChangePoints(series, [
			revision({ id: "r1", at_ms: 20 * HOUR - 1000 }),
		]);
		expect(report.counts.attributed).toBe(1);
		expect(report.counts.confounded + report.counts.unexplained).toBe(
			report.change_points.length - 1,
		);
	});

	test("a confounded report explains why no leader is offered", () => {
		const report = analyzeChangePoints(shifted(1, 9, 20), [
			revision({ id: "r1", at_ms: 20 * HOUR - 3000 }),
			revision({ id: "r2", at_ms: 20 * HOUR - 2000, kind: "prompt" }),
		]);
		expect(
			report.caveats.some((c) => c.includes("no evidential basis")),
		).toBe(true);
	});

	test("revisions that changed nothing are reported as the base rate", () => {
		const report = analyzeChangePoints(shifted(1, 9, 20), [
			revision({ id: "cause", at_ms: 20 * HOUR - 1000 }),
			revision({ id: "quiet1", at_ms: 2 * HOUR }),
			revision({ id: "quiet2", at_ms: 5 * HOUR }),
			revision({ id: "quiet3", at_ms: 9 * HOUR }),
		]);
		expect(report.caveats.some((c) => c.includes("base rate"))).toBe(true);
	});

	test("a stable series says so rather than reporting nothing", () => {
		const flat = Array.from({ length: 40 }, (_, i) => ({
			at_ms: i * HOUR,
			value: 3 + ((i % 5) - 2) * 0.1,
		}));
		const report = analyzeChangePoints(flat, []);
		expect(report.change_points).toEqual([]);
		expect(report.caveats.some((c) => c.includes("single stable regime"))).toBe(true);
	});

	test("observations are sorted before analysis", () => {
		const shuffled = [...shifted(1, 9, 20)].reverse();
		const report = analyzeChangePoints(shuffled, []);
		expect(report.change_points[0]?.index).toBe(20);
	});
});

describe("per-kind tallies", () => {
	test("only attributed changes earn a kind credit", () => {
		const attributions = attributeChangePoints(detectChangePoints(shifted(1, 9, 20)), [
			revision({ id: "r1", at_ms: 20 * HOUR - 3000, kind: "model" }),
			revision({ id: "r2", at_ms: 20 * HOUR - 2000, kind: "prompt" }),
		]);
		const tally = attributionsByKind(attributions);
		expect(tally.every((row) => row.attributed === 0)).toBe(true);
		expect(tally.find((row) => row.kind === "model")?.appeared_confounded).toBe(1);
	});

	test("a clean attribution credits exactly one kind", () => {
		const attributions = attributeChangePoints(detectChangePoints(shifted(1, 9, 20)), [
			revision({ id: "r1", at_ms: 20 * HOUR - 1000, kind: "dependency" }),
		]);
		const tally = attributionsByKind(attributions);
		expect(tally).toHaveLength(1);
		expect(tally[0].kind).toBe("dependency");
		expect(tally[0].attributed).toBe(1);
	});

	test("kinds with nothing to report are omitted", () => {
		expect(attributionsByKind([])).toEqual([]);
		expect(REVISION_KINDS.length).toBeGreaterThan(0);
	});
});
