import { describe, expect, test } from "bun:test";
import type { Revision } from "../../src/diagnosis/change-point.js";
import {
	buildLongitudinalDriftReport,
	DRIFT_DIMENSIONS,
	type LongitudinalSeries,
	renderLongitudinalDriftReport,
} from "../../src/diagnosis/longitudinal-drift.js";

function flat(
	provider: string,
	value: number,
	n: number,
	startMs = 0,
	stepMs = 60_000,
): Array<{ at_ms: number; value: number; provider: string }> {
	return Array.from({ length: n }, (_, i) => ({
		at_ms: startMs + i * stepMs,
		value,
		provider,
	}));
}

describe("buildLongitudinalDriftReport", () => {
	test("a dimension with no data at all is reported as null, not an empty report", () => {
		const series: LongitudinalSeries = {
			attribution: [],
			remediation: [],
			abstention: [],
			privacy_loss: [],
			cost: [],
			latency: [],
		};
		const report = buildLongitudinalDriftReport({ series, revisions: [] });
		for (const dim of DRIFT_DIMENSIONS) {
			expect(report.by_dimension[dim]).toBeNull();
		}
		expect(report.regressed_dimensions).toEqual([]);
	});

	test("a short series refuses rather than guessing a change point (propagates item 72's own refusal)", () => {
		const series: LongitudinalSeries = {
			attribution: [],
			remediation: [],
			abstention: [],
			privacy_loss: [],
			cost: flat("openai", 1, 5),
			latency: [],
		};
		const report = buildLongitudinalDriftReport({ series, revisions: [] });
		expect(report.by_dimension.cost?.refused_reason).toBeDefined();
		expect(report.regressed_dimensions).toEqual([]);
	});

	test("a jump in an up_is_worse dimension (cost) attributed to one revision is a regression", () => {
		const before = flat("openai", 1.0, 15, 0);
		const after = flat("openai", 5.0, 15, 15 * 60_000);
		const revisions: Revision[] = [
			{
				id: "r1",
				kind: "model",
				at_ms: 15 * 60_000 - 1000,
				description: "gpt-x upgrade",
				release: "2026.10",
			},
		];
		const series: LongitudinalSeries = {
			attribution: [],
			remediation: [],
			abstention: [],
			privacy_loss: [],
			cost: [...before, ...after],
			latency: [],
		};
		const report = buildLongitudinalDriftReport({ series, revisions });
		expect(report.regressed_dimensions).toContain("cost");
		const costReport = report.by_dimension.cost;
		expect(costReport?.regressions.length).toBeGreaterThan(0);
		expect(costReport?.regressions[0].verdict).toBe("attributed");
		expect(costReport?.regressions[0].revision?.id).toBe("r1");
	});

	test("a jump in a down_is_worse dimension (attribution agreement) in the IMPROVING direction is not a regression", () => {
		const before = flat("openai", 0.2, 15, 0);
		const after = flat("openai", 0.9, 15, 15 * 60_000);
		const series: LongitudinalSeries = {
			attribution: [...before, ...after],
			remediation: [],
			abstention: [],
			privacy_loss: [],
			cost: [],
			latency: [],
		};
		const report = buildLongitudinalDriftReport({ series, revisions: [] });
		expect(report.regressed_dimensions).not.toContain("attribution");
		// The change point is still detected and reported, just not as a regression.
		expect(report.by_dimension.attribution?.change_points.length).toBeGreaterThan(0);
	});

	test("a drop in a down_is_worse dimension (attribution agreement) IS a regression", () => {
		const before = flat("openai", 0.95, 15, 0);
		const after = flat("openai", 0.3, 15, 15 * 60_000);
		const series: LongitudinalSeries = {
			attribution: [...before, ...after],
			remediation: [],
			abstention: [],
			privacy_loss: [],
			cost: [],
			latency: [],
		};
		const report = buildLongitudinalDriftReport({ series, revisions: [] });
		expect(report.regressed_dimensions).toContain("attribution");
	});

	test("distinct providers represented in a dimension's series are named in its caveats", () => {
		const series: LongitudinalSeries = {
			attribution: [],
			remediation: [],
			abstention: [],
			privacy_loss: [],
			cost: [...flat("openai", 1, 10), ...flat("anthropic", 1, 10)],
			latency: [],
		};
		const report = buildLongitudinalDriftReport({ series, revisions: [] });
		const caveats = report.by_dimension.cost?.caveats.join(" ") ?? "";
		expect(caveats).toContain("openai");
		expect(caveats).toContain("anthropic");
	});
});

describe("renderLongitudinalDriftReport", () => {
	test("renders a heading and one section per tracked dimension with data", () => {
		const series: LongitudinalSeries = {
			attribution: [],
			remediation: [],
			abstention: [],
			privacy_loss: [],
			cost: flat("openai", 1, 15),
			latency: [],
		};
		const report = buildLongitudinalDriftReport({ series, revisions: [] });
		const rendered = renderLongitudinalDriftReport(report);
		expect(rendered).toContain("Longitudinal Diagnostic Drift");
		expect(rendered).toContain("cost");
	});
});
