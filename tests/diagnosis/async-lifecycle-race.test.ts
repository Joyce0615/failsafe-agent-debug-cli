import { describe, expect, test } from "bun:test";
import {
	type LifecycleEvent,
	detectBoundaryRaces,
	detectDuplicateDeliveryRaces,
	diagnoseAsyncLifecycleRaces,
	reconstructTaskSchedule,
	renderAsyncLifecycleRaceReport,
} from "../../src/diagnosis/async-lifecycle-race.js";
import type { PartialOrderResult } from "../../src/diagnosis/partial-order.js";

/**
 * A minimal fake `PartialOrderResult` built directly from a declared
 * ordering + concurrency set, so these tests exercise this module's own
 * logic in isolation from `partial-order.ts`'s clock/causal-link machinery
 * (which has its own dedicated test suite).
 */
function fakeOrder(opts: {
	before?: [string, string][];
	concurrent?: [string, string][];
}): PartialOrderResult {
	const beforeSet = new Set((opts.before ?? []).map(([a, b]) => `${a}\u0000${b}`));
	const concurrentSet = new Set(
		(opts.concurrent ?? []).flatMap(([a, b]) => [`${a}\u0000${b}`, `${b}\u0000${a}`]),
	);
	return {
		edges: [],
		rejected_clock_edges: [],
		contradictions: [],
		happensBefore: (a, b) => beforeSet.has(`${a}\u0000${b}`),
		concurrent: (a, b) => a !== b && concurrentSet.has(`${a}\u0000${b}`),
		uncertainty: [],
	};
}

function ev(
	id: string,
	task_id: string,
	kind: LifecycleEvent["kind"],
	effect_applied: boolean,
): LifecycleEvent {
	return { id, task_id, kind, effect_applied };
}

describe("detectDuplicateDeliveryRaces", () => {
	test("two concurrent retry_fired events for the same task with both effects applied -> duplicated", () => {
		const events = [ev("r1", "t1", "retry_fired", true), ev("r2", "t1", "retry_fired", true)];
		const order = fakeOrder({ concurrent: [["r1", "r2"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings).toHaveLength(1);
		expect(findings[0].kind).toBe("retry_duplication");
		expect(findings[0].effect_duplicated).toBe(true);
		expect(findings[0].legs).toEqual(["r1", "r2"]);
	});

	test("two concurrent retry_fired events but only one effect applied -> raced, not duplicated", () => {
		const events = [ev("r1", "t1", "retry_fired", true), ev("r2", "t1", "retry_fired", false)];
		const order = fakeOrder({ concurrent: [["r1", "r2"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings).toHaveLength(1);
		expect(findings[0].effect_duplicated).toBe(false);
	});

	test("two retry_fired events that are ordered (not concurrent) produce no finding", () => {
		const events = [ev("r1", "t1", "retry_fired", true), ev("r2", "t1", "retry_fired", false)];
		const order = fakeOrder({ before: [["r1", "r2"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings).toHaveLength(0);
	});

	test("webhook_delivered duplicates are classified as webhook_duplicate_delivery", () => {
		const events = [
			ev("w1", "t1", "webhook_delivered", true),
			ev("w2", "t1", "webhook_delivered", true),
		];
		const order = fakeOrder({ concurrent: [["w1", "w2"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings[0].kind).toBe("webhook_duplicate_delivery");
	});

	test("subscription_fired duplicates are classified as subscription_duplicate_fire", () => {
		const events = [
			ev("s1", "t1", "subscription_fired", true),
			ev("s2", "t1", "subscription_fired", true),
		];
		const order = fakeOrder({ concurrent: [["s1", "s2"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings[0].kind).toBe("subscription_duplicate_fire");
	});

	test("different delivery kinds concurrent with each other are NOT compared (different kind groups)", () => {
		const events = [ev("r1", "t1", "retry_fired", true), ev("w1", "t1", "webhook_delivered", true)];
		const order = fakeOrder({ concurrent: [["r1", "w1"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings).toHaveLength(0);
	});

	test("events across different tasks are never compared even if concurrent", () => {
		const events = [ev("r1", "t1", "retry_fired", true), ev("r2", "t2", "retry_fired", true)];
		const order = fakeOrder({ concurrent: [["r1", "r2"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings).toHaveLength(0);
	});

	test("non-delivery kinds (created, completed) never produce a duplicate-delivery finding", () => {
		const events = [ev("c1", "t1", "created", true), ev("c2", "t1", "completed", true)];
		const order = fakeOrder({ concurrent: [["c1", "c2"]] });
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings).toHaveLength(0);
	});

	test("three mutually concurrent retries produce three pairwise findings, each counted once", () => {
		const events = [
			ev("r1", "t1", "retry_fired", true),
			ev("r2", "t1", "retry_fired", true),
			ev("r3", "t1", "retry_fired", true),
		];
		const order = fakeOrder({
			concurrent: [
				["r1", "r2"],
				["r1", "r3"],
				["r2", "r3"],
			],
		});
		const findings = detectDuplicateDeliveryRaces(events, order);
		expect(findings).toHaveLength(3);
	});
});

describe("detectBoundaryRaces", () => {
	test("cancel_requested concurrent with completed, effect applied -> cancellation_race", () => {
		const events = [
			ev("cancel", "t1", "cancel_requested", false),
			ev("done", "t1", "completed", true),
		];
		const order = fakeOrder({ concurrent: [["cancel", "done"]] });
		const findings = detectBoundaryRaces(events, order);
		expect(findings).toHaveLength(1);
		expect(findings[0].kind).toBe("cancellation_race");
		expect(findings[0].legs).toEqual(["cancel", "done"]);
	});

	test("expired concurrent with retry_fired -> expiry_race", () => {
		const events = [ev("exp", "t1", "expired", false), ev("retry", "t1", "retry_fired", true)];
		const order = fakeOrder({ concurrent: [["exp", "retry"]] });
		const findings = detectBoundaryRaces(events, order);
		expect(findings[0].kind).toBe("expiry_race");
	});

	test("effect_duplicated is true only when BOTH the boundary event and the other event applied an effect", () => {
		const events = [
			ev("cancel", "t1", "cancel_requested", true), // cancel handler itself ran the effect
			ev("done", "t1", "completed", true),
		];
		const order = fakeOrder({ concurrent: [["cancel", "done"]] });
		const findings = detectBoundaryRaces(events, order);
		expect(findings[0].effect_duplicated).toBe(true);
	});

	test("a boundary event not concurrent with anything produces no finding", () => {
		const events = [
			ev("cancel", "t1", "cancel_requested", false),
			ev("done", "t1", "completed", true),
		];
		const order = fakeOrder({ before: [["done", "cancel"]] });
		const findings = detectBoundaryRaces(events, order);
		expect(findings).toHaveLength(0);
	});

	test("two boundary events (cancel + expire) both concurrent with the same effect event produce two findings", () => {
		const events = [
			ev("cancel", "t1", "cancel_requested", false),
			ev("exp", "t1", "expired", false),
			ev("done", "t1", "completed", true),
		];
		const order = fakeOrder({
			concurrent: [
				["cancel", "done"],
				["exp", "done"],
			],
		});
		const findings = detectBoundaryRaces(events, order);
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.kind).sort()).toEqual(["cancellation_race", "expiry_race"]);
	});

	test("boundary races across different tasks are never compared", () => {
		const events = [
			ev("cancel", "t1", "cancel_requested", false),
			ev("done", "t2", "completed", true),
		];
		const order = fakeOrder({ concurrent: [["cancel", "done"]] });
		const findings = detectBoundaryRaces(events, order);
		expect(findings).toHaveLength(0);
	});
});

describe("diagnoseAsyncLifecycleRaces", () => {
	test("combines duplicate-delivery and boundary findings, and lists duplicated_task_ids once per task", () => {
		const events = [
			ev("r1", "t1", "retry_fired", true),
			ev("r2", "t1", "retry_fired", true),
			ev("cancel", "t2", "cancel_requested", false),
			ev("done", "t2", "completed", true),
		];
		const order = fakeOrder({
			concurrent: [
				["r1", "r2"],
				["cancel", "done"],
			],
		});
		const report = diagnoseAsyncLifecycleRaces(events, order);
		expect(report.findings).toHaveLength(2);
		expect(report.duplicated_task_ids).toEqual(["t1"]);
	});

	test("no races anywhere -> empty findings and empty duplicated_task_ids", () => {
		const events = [ev("a", "t1", "created", true), ev("b", "t1", "completed", true)];
		const order = fakeOrder({ before: [["a", "b"]] });
		const report = diagnoseAsyncLifecycleRaces(events, order);
		expect(report.findings).toEqual([]);
		expect(report.duplicated_task_ids).toEqual([]);
	});
});

describe("reconstructTaskSchedule", () => {
	test("produces a valid linear extension honoring happensBefore", () => {
		const events = [
			ev("c", "t1", "completed", true),
			ev("a", "t1", "created", true),
			ev("b", "t1", "started", true),
		];
		const order = fakeOrder({
			before: [
				["a", "b"],
				["b", "c"],
				["a", "c"],
			],
		});
		const schedule = reconstructTaskSchedule(events, order);
		expect(schedule.order).toEqual(["a", "b", "c"]);
		expect(schedule.undetermined_pairs).toEqual([]);
	});

	test("reports undetermined_pairs for every concurrent pair", () => {
		const events = [ev("a", "t1", "created", true), ev("b", "t1", "retry_fired", true)];
		const order = fakeOrder({ concurrent: [["a", "b"]] });
		const schedule = reconstructTaskSchedule(events, order);
		expect(schedule.undetermined_pairs).toEqual([["a", "b"]]);
	});

	test("throws on an empty event list rather than guessing a task_id", () => {
		expect(() => reconstructTaskSchedule([], fakeOrder({}))).toThrow();
	});

	test("task_id is taken from the supplied events", () => {
		const events = [ev("a", "t42", "created", true)];
		const schedule = reconstructTaskSchedule(events, fakeOrder({}));
		expect(schedule.task_id).toBe("t42");
	});
});

describe("renderAsyncLifecycleRaceReport", () => {
	test("renders a header, per-finding lines, and a duplicated-task summary", () => {
		const events = [ev("r1", "t1", "retry_fired", true), ev("r2", "t1", "retry_fired", true)];
		const order = fakeOrder({ concurrent: [["r1", "r2"]] });
		const report = diagnoseAsyncLifecycleRaces(events, order);
		const text = renderAsyncLifecycleRaceReport(report);
		expect(text).toContain("Asynchronous Lifecycle Race Report");
		expect(text).toContain("retry_duplication");
		expect(text).toContain("EFFECT DUPLICATED");
		expect(text).toContain("Tasks with a confirmed effect duplication: 1");
	});

	test("renders 'No races found.' when there are no findings", () => {
		const report = diagnoseAsyncLifecycleRaces([], fakeOrder({}));
		const text = renderAsyncLifecycleRaceReport(report);
		expect(text).toContain("No races found.");
	});
});
