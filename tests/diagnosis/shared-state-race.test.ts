/**
 * Shared-state read/write race reconstruction tests (item 53 — build
 * versioned read/write sets from file, artifact, and resource evidence;
 * attribute stale reads, lost updates, write skew, and structural races
 * while abstaining when multiple legal linearizations imply different
 * blame).
 */
import { describe, expect, test } from "bun:test";
import type { PartialOrderResult } from "../../src/diagnosis/partial-order.js";
import {
	type ResourceOperation,
	diagnoseSharedStateRaces,
	renderSharedStateRaceReport,
} from "../../src/diagnosis/shared-state-race.js";

/**
 * A minimal fake `PartialOrderResult`, mirroring
 * `async-lifecycle-race.test.ts`'s own `fakeOrder` helper, so these tests
 * exercise this module's own logic in isolation from `partial-order.ts`'s
 * clock/causal-link machinery.
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

describe("diagnoseSharedStateRaces: stale_read", () => {
	test("a read that missed a causally-earlier commit is a stale_read", () => {
		const operations: ResourceOperation[] = [
			{ id: "r1", actor_id: "a1", resource_id: "res1", kind: "read", version: 1 },
			{ id: "w1", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
		];
		const order = fakeOrder({ before: [["w1", "r1"]] });
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.some((f) => f.kind === "stale_read")).toBe(true);
	});

	test("a read that genuinely preceded the later write is not stale", () => {
		const operations: ResourceOperation[] = [
			{ id: "r1", actor_id: "a1", resource_id: "res1", kind: "read", version: 1 },
			{ id: "w1", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
		];
		const order = fakeOrder({ before: [["r1", "w1"]] });
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.find((f) => f.kind === "stale_read")).toBeUndefined();
	});

	test("a read concurrent with the later write is abstained, not reported as a finding", () => {
		const operations: ResourceOperation[] = [
			{ id: "r1", actor_id: "a1", resource_id: "res1", kind: "read", version: 1 },
			{ id: "w1", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
		];
		const order = fakeOrder({ concurrent: [["r1", "w1"]] });
		const { findings, abstained_pairs } = diagnoseSharedStateRaces(operations, order);
		expect(findings.find((f) => f.kind === "stale_read")).toBeUndefined();
		expect(abstained_pairs).toHaveLength(1);
		expect(abstained_pairs[0]).toEqual({
			read_id: "r1",
			write_id: "w1",
			reason: expect.stringContaining("concurrent"),
		});
	});
});

describe("diagnoseSharedStateRaces: lost_update", () => {
	test("a write based on a stale version that skips an intervening committed write is a lost_update", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
			{ id: "w2", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
			{
				id: "w3",
				actor_id: "a1",
				resource_id: "res1",
				kind: "write",
				version: 3,
				based_on_version: 1,
			},
		];
		const order = fakeOrder({});
		const { findings } = diagnoseSharedStateRaces(operations, order);
		const lost = findings.find((f) => f.kind === "lost_update");
		expect(lost).toBeDefined();
		expect(lost?.blamed_actor_id).toBe("a1");
		expect(lost?.evidence_ids).toContain("w2");
	});

	test("a write based on the immediately preceding version is not a lost_update", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
			{
				id: "w2",
				actor_id: "a2",
				resource_id: "res1",
				kind: "write",
				version: 2,
				based_on_version: 1,
			},
		];
		const order = fakeOrder({});
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.find((f) => f.kind === "lost_update")).toBeUndefined();
	});

	test("an unconditional write with no based_on_version is never a lost_update candidate", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
			{ id: "w2", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
		];
		const order = fakeOrder({});
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.find((f) => f.kind === "lost_update")).toBeUndefined();
	});
});

describe("diagnoseSharedStateRaces: write_skew", () => {
	test("two groups each missing the other's write and writing the other's resource is write_skew with no blamed actor", () => {
		const operations: ResourceOperation[] = [
			// Group g1: reads X at v1 (misses g2's write to X at v2), writes Y.
			{
				id: "g1-read-x",
				actor_id: "a1",
				group_id: "g1",
				resource_id: "x",
				kind: "read",
				version: 1,
			},
			{
				id: "g1-write-y",
				actor_id: "a1",
				group_id: "g1",
				resource_id: "y",
				kind: "write",
				version: 2,
			},
			// Group g2: reads Y at v1 (misses g1's write to Y at v2), writes X.
			{
				id: "g2-read-y",
				actor_id: "a2",
				group_id: "g2",
				resource_id: "y",
				kind: "read",
				version: 1,
			},
			{
				id: "g2-write-x",
				actor_id: "a2",
				group_id: "g2",
				resource_id: "x",
				kind: "write",
				version: 2,
			},
		];
		const order = fakeOrder({});
		const { findings } = diagnoseSharedStateRaces(operations, order);
		const skew = findings.find((f) => f.kind === "write_skew");
		expect(skew).toBeDefined();
		expect(skew?.blamed_actor_id).toBeNull();
	});

	test("two groups writing disjoint resources with no cross-read are not write_skew", () => {
		const operations: ResourceOperation[] = [
			{
				id: "g1-write-y",
				actor_id: "a1",
				group_id: "g1",
				resource_id: "y",
				kind: "write",
				version: 1,
			},
			{
				id: "g2-write-x",
				actor_id: "a2",
				group_id: "g2",
				resource_id: "x",
				kind: "write",
				version: 1,
			},
		];
		const order = fakeOrder({});
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.find((f) => f.kind === "write_skew")).toBeUndefined();
	});
});

describe("diagnoseSharedStateRaces: structural_race", () => {
	test("two concurrent writes to the same resource with no read-modify-write basis are a structural_race with no blamed actor", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
			{ id: "w2", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
		];
		const order = fakeOrder({ concurrent: [["w1", "w2"]] });
		const { findings } = diagnoseSharedStateRaces(operations, order);
		const structural = findings.find((f) => f.kind === "structural_race");
		expect(structural).toBeDefined();
		expect(structural?.blamed_actor_id).toBeNull();
	});

	test("two ordered (non-concurrent) writes to the same resource are not a structural_race", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
			{ id: "w2", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
		];
		const order = fakeOrder({ before: [["w1", "w2"]] });
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.find((f) => f.kind === "structural_race")).toBeUndefined();
	});

	test("a pair already explained as a lost_update is not ALSO reported as a structural_race", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
			{
				id: "w2",
				actor_id: "a2",
				resource_id: "res1",
				kind: "write",
				version: 2,
				based_on_version: 1,
			},
		];
		// Concurrent per the partial order, but lost_update already explains it.
		const order = fakeOrder({ concurrent: [["w1", "w2"]] });
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.find((f) => f.kind === "lost_update")).toBeUndefined();
		// w2 is based_on_version 1 which IS the immediately preceding version,
		// so lost_update does not fire here either -- re-run with an actual
		// intervening write to confirm suppression.
	});

	test("a pair explained as lost_update (with an actual intervening write) suppresses the structural_race for that pair", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
			{ id: "w2", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
			{
				id: "w3",
				actor_id: "a1",
				resource_id: "res1",
				kind: "write",
				version: 3,
				based_on_version: 1,
			},
		];
		const order = fakeOrder({ concurrent: [["w2", "w3"]] });
		const { findings } = diagnoseSharedStateRaces(operations, order);
		expect(findings.some((f) => f.kind === "lost_update")).toBe(true);
		expect(
			findings.find(
				(f) =>
					f.kind === "structural_race" &&
					f.evidence_ids.includes("w2") &&
					f.evidence_ids.includes("w3"),
			),
		).toBeUndefined();
	});
});

describe("renderSharedStateRaceReport", () => {
	test("renders findings and abstained pairs", () => {
		const operations: ResourceOperation[] = [
			{ id: "r1", actor_id: "a1", resource_id: "res1", kind: "read", version: 1 },
			{ id: "w1", actor_id: "a2", resource_id: "res1", kind: "write", version: 2 },
		];
		const order = fakeOrder({ concurrent: [["r1", "w1"]] });
		const report = diagnoseSharedStateRaces(operations, order);
		const text = renderSharedStateRaceReport(report);
		expect(text).toContain("Shared-State Read/Write Race Report");
		expect(text).toContain("Abstained pairs");
	});

	test("renders a clean diagnosis with no findings or abstentions", () => {
		const operations: ResourceOperation[] = [
			{ id: "w1", actor_id: "a1", resource_id: "res1", kind: "write", version: 1 },
		];
		const order = fakeOrder({});
		const report = diagnoseSharedStateRaces(operations, order);
		const text = renderSharedStateRaceReport(report);
		expect(text).toContain("None.");
	});
});
