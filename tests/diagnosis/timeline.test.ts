import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEDUPE_WINDOW_MS,
	EVENT_SOURCES,
	type RawEvent,
	UNANCHORED_UNCERTAINTY_MS,
	concurrencyGroups,
	estimateSkew,
	normalizeTimeline,
	rankTimelineCauses,
} from "../../src/diagnosis/timeline.js";

function event(overrides: Partial<RawEvent> & { id: string; ts_ms: number }): RawEvent {
	return {
		source: "output",
		clock: "local",
		label: `event ${overrides.id}`,
		...overrides,
	};
}

describe("clock skew estimation", () => {
	test("a single anchor pins the offset but not its stability", () => {
		const model = estimateSkew(
			[{ clock: "runner", ts_ms: 1_000, reference_ts_ms: 6_000 }],
			"local",
		);
		expect(model.offsets.runner).toBe(5_000);
		expect(model.residuals.runner).toBe(UNANCHORED_UNCERTAINTY_MS);
	});

	test("the median offset resists one badly matched anchor", () => {
		const model = estimateSkew(
			[
				{ clock: "runner", ts_ms: 1_000, reference_ts_ms: 1_100 },
				{ clock: "runner", ts_ms: 2_000, reference_ts_ms: 2_100 },
				{ clock: "runner", ts_ms: 3_000, reference_ts_ms: 3_100 },
				// Wrong pairing: would drag a mean offset by seconds.
				{ clock: "runner", ts_ms: 4_000, reference_ts_ms: 40_000 },
			],
			"local",
		);
		expect(model.offsets.runner).toBe(100);
	});

	test("residual spread grows when anchors disagree", () => {
		const tight = estimateSkew(
			[
				{ clock: "c", ts_ms: 0, reference_ts_ms: 10 },
				{ clock: "c", ts_ms: 100, reference_ts_ms: 110 },
				{ clock: "c", ts_ms: 200, reference_ts_ms: 210 },
			],
			"local",
		);
		const loose = estimateSkew(
			[
				{ clock: "c", ts_ms: 0, reference_ts_ms: 10 },
				{ clock: "c", ts_ms: 100, reference_ts_ms: 400 },
				{ clock: "c", ts_ms: 200, reference_ts_ms: 900 },
			],
			"local",
		);
		expect(loose.residuals.c).toBeGreaterThan(tight.residuals.c);
	});

	test("an unanchored clock is assumed unskewed and said so loudly", () => {
		const model = estimateSkew([], "local", ["local", "collector"]);
		expect(model.offsets.collector).toBe(0);
		expect(model.residuals.collector).toBe(UNANCHORED_UNCERTAINTY_MS);
		expect(model.unanchored).toEqual(["collector"]);
	});

	test("the reference clock has no offset and no residual", () => {
		const model = estimateSkew([], "local", ["local"]);
		expect(model.offsets.local).toBe(0);
		expect(model.residuals.local).toBe(0);
		expect(model.unanchored).toEqual([]);
	});
});

describe("normalization", () => {
	test("skew is applied so cross-clock events sort correctly", () => {
		const timeline = normalizeTimeline(
			[
				event({ id: "trace", ts_ms: 1_000, clock: "collector", source: "trace" }),
				event({ id: "log", ts_ms: 5_500, clock: "local" }),
			],
			{
				reference: "local",
				anchors: [{ clock: "collector", ts_ms: 0, reference_ts_ms: 5_000 }],
			},
		);
		// Raw order says trace first; corrected order says the log came first.
		expect(timeline.events.map((e) => e.id)).toEqual(["log", "trace"]);
		expect(timeline.events[1].ts_ms).toBe(6_000);
		expect(timeline.events[1].raw_ts_ms).toBe(1_000);
	});

	test("coarse precision widens the uncertainty interval", () => {
		const timeline = normalizeTimeline([
			event({ id: "second", ts_ms: 1_000, precision_ms: 1000 }),
			event({ id: "milli", ts_ms: 9_000, precision_ms: 1 }),
		]);
		const coarse = timeline.events.find((e) => e.id === "second");
		const fine = timeline.events.find((e) => e.id === "milli");
		expect(coarse?.uncertainty_ms).toBeGreaterThan(fine?.uncertainty_ms ?? 0);
	});

	test("an unanchored clock's uncertainty is charged to its events", () => {
		const timeline = normalizeTimeline([event({ id: "a", ts_ms: 0, clock: "other" })], {
			reference: "local",
		});
		expect(timeline.events[0].uncertainty_ms).toBeGreaterThanOrEqual(UNANCHORED_UNCERTAINTY_MS);
		expect(timeline.uncertainty.some((u) => u.includes("No clock anchor"))).toBe(true);
	});

	test("secrets are redacted before the event enters the timeline", () => {
		const timeline = normalizeTimeline([
			event({
				id: "a",
				ts_ms: 0,
				label: "auth failed with sk-abcdefghijklmnopqrstuvwxyz012345",
				attributes: { header: "Bearer abcdefghijklmnop" },
			}),
		]);
		expect(timeline.events[0].label).toBe("auth failed with [REDACTED]");
		expect(timeline.events[0].attributes.header).toBe("[REDACTED]");
		expect(timeline.events[0].redacted).toBe(true);
		expect(timeline.redacted_events).toBe(1);
		expect(timeline.uncertainty.some((u) => u.includes("redacted"))).toBe(true);
	});

	test("every artifact source is representable", () => {
		expect(EVENT_SOURCES).toEqual(["output", "test", "trace", "config", "diff", "debugger"]);
		const timeline = normalizeTimeline(
			EVENT_SOURCES.map((source, i) =>
				event({ id: source, ts_ms: i * 10_000, source, label: `from ${source}` }),
			),
		);
		expect(timeline.events).toHaveLength(EVENT_SOURCES.length);
	});

	test("an empty input yields an empty timeline, not a crash", () => {
		const timeline = normalizeTimeline([]);
		expect(timeline.events).toEqual([]);
		expect(timeline.concurrency_groups).toEqual([]);
	});
});

describe("duplicate collapsing", () => {
	test("the same failure seen in output and the test report becomes one event", () => {
		const timeline = normalizeTimeline([
			event({ id: "a", ts_ms: 1_000, source: "output", label: "test_login failed" }),
			event({ id: "b", ts_ms: 1_050, source: "test", label: "test_login failed" }),
		]);
		expect(timeline.events).toHaveLength(1);
		expect(timeline.events[0].occurrences).toBe(2);
		expect(timeline.events[0].sources.sort()).toEqual(["output", "test"]);
		expect(timeline.duplicates_collapsed).toBe(1);
	});

	test("the same label far apart in time is two real events", () => {
		const timeline = normalizeTimeline([
			event({ id: "a", ts_ms: 0, label: "retry" }),
			event({ id: "b", ts_ms: 60_000, label: "retry" }),
		]);
		expect(timeline.events).toHaveLength(2);
	});

	test("the same label in different components is not a duplicate", () => {
		const timeline = normalizeTimeline([
			event({ id: "a", ts_ms: 0, label: "timeout", component: "payments" }),
			event({ id: "b", ts_ms: 10, label: "timeout", component: "inventory" }),
		]);
		expect(timeline.events).toHaveLength(2);
	});

	test("collapsing keeps the earliest stamp and the widest uncertainty", () => {
		const timeline = normalizeTimeline([
			event({ id: "a", ts_ms: 1_000, label: "boom", precision_ms: 1 }),
			event({ id: "b", ts_ms: 1_100, label: "boom", precision_ms: 1000, source: "test" }),
		]);
		expect(timeline.events[0].ts_ms).toBe(1_000);
		expect(timeline.events[0].uncertainty_ms).toBeGreaterThanOrEqual(500);
	});

	test("a failure flag survives collapsing even if only one report had it", () => {
		const timeline = normalizeTimeline([
			event({ id: "a", ts_ms: 0, label: "boom", failed: false }),
			event({ id: "b", ts_ms: 10, label: "boom", failed: true, source: "test" }),
		]);
		expect(timeline.events[0].failed).toBe(true);
	});

	test("the dedupe window is configurable", () => {
		const raw = [
			event({ id: "a", ts_ms: 0, label: "x" }),
			event({ id: "b", ts_ms: 400, label: "x", source: "test" }),
		];
		expect(normalizeTimeline(raw).events).toHaveLength(2);
		expect(normalizeTimeline(raw, { dedupe_window_ms: 1000 }).events).toHaveLength(1);
		expect(DEFAULT_DEDUPE_WINDOW_MS).toBe(250);
	});
});

describe("uncertain ordering", () => {
	test("well-separated precise events are individually ordered", () => {
		const timeline = normalizeTimeline([
			event({ id: "a", ts_ms: 0, label: "a" }),
			event({ id: "b", ts_ms: 10_000, label: "b" }),
		]);
		expect(timeline.concurrency_groups).toEqual([["a"], ["b"]]);
	});

	test("events with overlapping uncertainty are reported as unordered", () => {
		const timeline = normalizeTimeline([
			event({ id: "a", ts_ms: 0, label: "a", precision_ms: 1000 }),
			event({ id: "b", ts_ms: 400, label: "b", precision_ms: 1000 }),
		]);
		expect(timeline.concurrency_groups).toEqual([["a", "b"]]);
		expect(timeline.uncertainty.some((u) => u.includes("undetermined"))).toBe(true);
	});

	test("grouping is transitive: A~B and B~C means A, B, C are all unordered", () => {
		const groups = concurrencyGroups([
			{
				id: "a",
				source: "output",
				clock: "l",
				raw_ts_ms: 0,
				ts_ms: 0,
				uncertainty_ms: 100,
				label: "a",
				failed: false,
				attributes: {},
				redacted: false,
				occurrences: 1,
				sources: ["output"],
			},
			{
				id: "b",
				source: "output",
				clock: "l",
				raw_ts_ms: 150,
				ts_ms: 150,
				uncertainty_ms: 100,
				label: "b",
				failed: false,
				attributes: {},
				redacted: false,
				occurrences: 1,
				sources: ["output"],
			},
			{
				id: "c",
				source: "output",
				clock: "l",
				raw_ts_ms: 300,
				ts_ms: 300,
				uncertainty_ms: 100,
				label: "c",
				failed: false,
				attributes: {},
				redacted: false,
				occurrences: 1,
				sources: ["output"],
			},
		]);
		expect(groups).toEqual([["a", "b", "c"]]);
	});
});

describe("causal ranking over a timeline", () => {
	test("an earlier config change is ranked as the root of a later test failure", () => {
		const result = rankTimelineCauses([
			event({
				id: "cfg",
				ts_ms: 0,
				source: "config",
				label: "timeout_ms lowered to 50",
				failed: true,
				component: "payments",
			}),
			event({
				id: "test",
				ts_ms: 60_000,
				source: "test",
				label: "test_checkout failed",
				failed: true,
				component: "checkout",
			}),
		]);
		expect(result.ranking.root_causes[0].node_id).toBe("cfg");
		expect(result.ranking.root_causes[0].downstream_failures).toBe(1);
		expect(result.edges).toEqual([{ from: "cfg", to: "test", type: "causes" }]);
	});

	test("failures whose order is undetermined get no causal edge in either direction", () => {
		const result = rankTimelineCauses([
			event({ id: "a", ts_ms: 0, label: "a down", failed: true, precision_ms: 2000 }),
			event({ id: "b", ts_ms: 500, label: "b down", failed: true, precision_ms: 2000 }),
		]);
		expect(result.edges).toEqual([]);
		expect(result.ranking.root_causes).toHaveLength(2);
		expect(result.ranking.uncertainty.some((u) => u.includes("undetermined"))).toBe(true);
	});

	test("only immediately adjacent groups are linked, so a long timeline stays sparse", () => {
		const result = rankTimelineCauses([
			event({ id: "a", ts_ms: 0, label: "a", failed: true }),
			event({ id: "b", ts_ms: 10_000, label: "b", failed: true }),
			event({ id: "c", ts_ms: 20_000, label: "c", failed: true }),
		]);
		expect(result.edges).toEqual([
			{ from: "a", to: "b", type: "causes" },
			{ from: "b", to: "c", type: "causes" },
		]);
		expect(result.ranking.root_causes.map((r) => r.node_id)).toEqual(["a"]);
	});

	test("skew correction changes which failure is judged the root", () => {
		const raw: RawEvent[] = [
			event({
				id: "collector-event",
				ts_ms: 0,
				clock: "collector",
				source: "trace",
				label: "upstream 500",
				failed: true,
			}),
			event({ id: "local-event", ts_ms: 1_000, label: "request failed", failed: true }),
		];
		const naive = rankTimelineCauses(raw, { reference: "local" });
		expect(naive.ranking.root_causes[0].node_id).toBe("collector-event");

		const corrected = rankTimelineCauses(raw, {
			reference: "local",
			anchors: [
				{ clock: "collector", ts_ms: 0, reference_ts_ms: 5_000 },
				{ clock: "collector", ts_ms: 100, reference_ts_ms: 5_100 },
			],
		});
		expect(corrected.ranking.root_causes[0].node_id).toBe("local-event");
	});

	test("non-failure events are excluded from the causal graph", () => {
		const result = rankTimelineCauses([
			event({ id: "info", ts_ms: 0, label: "starting" }),
			event({ id: "boom", ts_ms: 10_000, label: "crashed", failed: true }),
		]);
		expect(result.ranking.root_causes.map((r) => r.node_id)).toEqual(["boom"]);
	});

	test("timeline caveats are carried into the ranking's uncertainty", () => {
		const result = rankTimelineCauses(
			[
				event({ id: "a", ts_ms: 0, clock: "unknown-clock", label: "a", failed: true }),
				event({ id: "b", ts_ms: 60_000, label: "b", failed: true }),
			],
			{ reference: "local" },
		);
		expect(result.ranking.uncertainty.some((u) => u.includes("No clock anchor"))).toBe(true);
	});
});
