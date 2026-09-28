import { describe, expect, test } from "bun:test";
import {
	CHAOS_KINDS,
	type ChaosScenario,
	OBSERVABILITY_EXPECTATIONS,
	RESILIENCE_VERDICTS,
	assessResilience,
	chaosItems,
	healthySink,
	injectChaos,
	observe,
	runChaosSuite,
} from "../../src/testing/chaos.js";

const ITEMS = chaosItems(20);

function scenario(overrides: Partial<ChaosScenario> & { kind: ChaosScenario["kind"] }): ChaosScenario {
	return {
		description: overrides.kind,
		start_ms: 0,
		duration_ms: 10 ** 9,
		...overrides,
	};
}

describe("every condition declares what must stay observable", () => {
	test("all six kinds have an expectation", () => {
		for (const kind of CHAOS_KINDS) {
			expect(OBSERVABILITY_EXPECTATIONS[kind].length).toBeGreaterThan(20);
		}
	});

	test("the exporter-outage expectation names the quiet-system failure", () => {
		expect(OBSERVABILITY_EXPECTATIONS.exporter_outage).toContain("reads as a quiet system");
	});

	test("the partial-telemetry expectation says a partial view must say so", () => {
		expect(OBSERVABILITY_EXPECTATIONS.partial_telemetry).toContain("does not say it is partial");
	});
});

describe("the control arm", () => {
	test("a healthy sink stores everything unchanged", () => {
		const sink = healthySink();
		const observed = observe(sink, ITEMS);
		expect(observed.accepted).toBe(ITEMS.length);
		expect(observed.errors_surfaced).toBe(0);
		expect(observed.silent_drops).toBe(0);
		expect(observed.bytes_stored).toBe(observed.bytes_offered);
	});

	test("an unaffected run is the verdict", () => {
		const report = assessResilience(
			scenario({ kind: "exporter_outage" }),
			observe(healthySink(), ITEMS),
		);
		expect(report.verdict).toBe("unaffected");
		expect(report.acceptable).toBe(true);
	});
});

describe("loud degradation is acceptable", () => {
	test("an exporter outage rejects with a reason on every item", () => {
		const handle = injectChaos(healthySink(), scenario({ kind: "exporter_outage" }));
		const observed = observe(handle.sink, ITEMS);
		expect(observed.errors_surfaced).toBe(ITEMS.length);
		expect(observed.silent_drops).toBe(0);
		const report = assessResilience(handle.scenario, observed);
		expect(report.verdict).toBe("degraded_loudly");
		expect(report.acceptable).toBe(true);
	});

	test("a full disk rejects the items it cannot fit and accepts the ones it can", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "disk_full", remaining_bytes: 350 }),
		);
		const observed = observe(handle.sink, ITEMS);
		expect(observed.accepted).toBe(3);
		expect(observed.errors_surfaced).toBe(17);
		expect(assessResilience(handle.scenario, observed).acceptable).toBe(true);
	});

	test("a restart surfaces the loss of in-flight items", () => {
		const handle = injectChaos(healthySink(), scenario({ kind: "restart" }));
		const observed = observe(handle.sink, ITEMS);
		expect(observed.errors_surfaced).toBe(ITEMS.length);
		expect(assessResilience(handle.scenario, observed).verdict).toBe("degraded_loudly");
	});

	test("the loss is quantified rather than merely acknowledged", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "disk_full", remaining_bytes: 350 }),
		);
		const report = assessResilience(handle.scenario, observe(handle.sink, ITEMS));
		expect(report.loss_fraction).toBeCloseTo(17 / 20, 5);
		expect(report.observed.bytes_stored).toBe(300);
	});
});

describe("silent degradation is the failure to catch", () => {
	test("partial telemetry drops items with no error at all", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "partial_telemetry", drop_fraction: 0.5 }),
		);
		const observed = observe(handle.sink, ITEMS);
		expect(observed.silent_drops).toBeGreaterThan(0);
		expect(observed.errors_surfaced).toBe(0);
		const report = assessResilience(handle.scenario, observed);
		expect(report.verdict).toBe("degraded_silently");
		expect(report.acceptable).toBe(false);
	});

	test("a total silent loss is its own verdict, not a worse partial one", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "partial_telemetry", drop_fraction: 0.999999 }),
		);
		const observed = observe(handle.sink, ITEMS);
		const report = assessResilience(handle.scenario, observed);
		expect(report.verdict).toBe("total_silent_loss");
		expect(report.detail).toContain("indistinguishable from a system with nothing to report");
	});

	test("the silent fraction of the loss is reported", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "partial_telemetry", drop_fraction: 0.5 }),
		);
		const report = assessResilience(handle.scenario, observe(handle.sink, ITEMS));
		expect(report.silent_fraction).toBe(1);
	});

	test("a clock jump alters timestamps without losing anything, and is still not unaffected", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "clock_jump", clock_delta_ms: 60_000 }),
		);
		const observed = observe(handle.sink, ITEMS);
		expect(observed.accepted).toBe(ITEMS.length);
		expect(observed.timestamps_altered).toBe(ITEMS.length);
		expect(assessResilience(handle.scenario, observed).verdict).not.toBe("unaffected");
	});

	test("a slow exporter shifts timestamps rather than dropping", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "slow_exporter", added_latency_ms: 500 }),
		);
		const observed = observe(handle.sink, ITEMS);
		expect(observed.timestamps_altered).toBe(ITEMS.length);
		expect(observed.silent_drops).toBe(0);
	});

	test("every verdict is a declared member of the vocabulary", () => {
		for (const kind of CHAOS_KINDS) {
			const handle = injectChaos(healthySink(), scenario({ kind, drop_fraction: 0.5 }));
			const report = assessResilience(handle.scenario, observe(handle.sink, ITEMS));
			expect(RESILIENCE_VERDICTS).toContain(report.verdict);
		}
	});
});

describe("chaos is bounded and reversible", () => {
	test("the condition applies only within its window", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "exporter_outage", start_ms: 1050, duration_ms: 50 }),
		);
		const observed = observe(handle.sink, ITEMS);
		expect(observed.errors_surfaced).toBeGreaterThan(0);
		expect(observed.accepted).toBeGreaterThan(0);
	});

	test("restore ends the condition immediately and is idempotent", () => {
		const handle = injectChaos(healthySink(), scenario({ kind: "exporter_outage" }));
		expect(handle.active(1000)).toBe(true);
		handle.restore();
		handle.restore();
		expect(handle.active(1000)).toBe(false);
		expect(observe(handle.sink, ITEMS).accepted).toBe(ITEMS.length);
	});

	test("active() answers for a given instant, not for the whole run", () => {
		const handle = injectChaos(
			healthySink(),
			scenario({ kind: "disk_full", start_ms: 5000, duration_ms: 1000 }),
		);
		expect(handle.active(4999)).toBe(false);
		expect(handle.active(5000)).toBe(true);
		expect(handle.active(6000)).toBe(false);
	});
});

describe("the suite", () => {
	test("silent failures are named", () => {
		const result = runChaosSuite(
			[
				scenario({ kind: "exporter_outage" }),
				scenario({ kind: "partial_telemetry", drop_fraction: 0.5 }),
			],
			ITEMS,
		);
		expect(result.silent_failures).toEqual(["partial_telemetry"]);
		expect(result.caveats.some((c) => c.includes("evidence was never emitted"))).toBe(true);
	});

	test("untested conditions are reported, because a partial run reads like a complete one", () => {
		const result = runChaosSuite([scenario({ kind: "exporter_outage" })], ITEMS);
		expect(result.untested).toHaveLength(CHAOS_KINDS.length - 1);
		expect(result.caveats.some((c) => c.includes("reads identically to a complete one"))).toBe(
			true,
		);
	});

	test("a full suite has nothing untested", () => {
		const result = runChaosSuite(
			CHAOS_KINDS.map((kind) => scenario({ kind, drop_fraction: 0.5, remaining_bytes: 350 })),
			ITEMS,
		);
		expect(result.untested).toEqual([]);
		expect(result.reports).toHaveLength(CHAOS_KINDS.length);
	});

	test("an empty item stream is called out as passing vacuously", () => {
		const result = runChaosSuite([scenario({ kind: "exporter_outage" })], []);
		expect(result.caveats.some((c) => c.includes("vacuously"))).toBe(true);
	});

	test("each scenario gets a fresh sink so they cannot contaminate each other", () => {
		const result = runChaosSuite(
			[
				scenario({ kind: "disk_full", remaining_bytes: 350 }),
				scenario({ kind: "disk_full", remaining_bytes: 350 }),
			],
			ITEMS,
		);
		expect(result.reports[0].observed.accepted).toBe(result.reports[1].observed.accepted);
	});
});
