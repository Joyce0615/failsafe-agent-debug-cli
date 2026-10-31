/**
 * Time-travel state inspection (item 25).
 *
 * Content-addressed checkpoints over a recorded debug trajectory, and
 * deterministic forward/backward views that never re-run a step --
 * especially not one with a consequential effect (console output, an
 * exception).
 */
import { describe, expect, test } from "bun:test";
import type { StateDelta, StateSnapshot } from "../../src/types/debug.js";
import {
	type Checkpoint,
	Timeline,
	buildTimeline,
	checkpointSnapshot,
	hasConsequentialEffect,
	snapshotHash,
} from "../../src/debug/time-travel.js";

function snap(file: string, line: number, vars: Record<string, string> = {}): StateSnapshot {
	return {
		thread_id: "1",
		frame_id: "1",
		location: { file, line },
		scopes: [
			{
				name: "Locals",
				variables: Object.entries(vars).map(([name, value]) => ({ name, value })),
			},
		],
	};
}

function delta(
	from: StateSnapshot,
	to: StateSnapshot,
	opts?: { console?: boolean; exception?: boolean },
): StateDelta {
	return {
		debug_session_id: "s1",
		from_location: from.location,
		to_location: to.location,
		step_kind: "over",
		changed_variables: [],
		branch_events: [],
		exceptions: opts?.exception ? [{ type: "ValueError", message: "boom" }] : [],
		console_events: opts?.console ? [{ category: "stdout", text: "hi" }] : [],
	};
}

describe("snapshotHash (Item 25)", () => {
	test("is deterministic for the identical snapshot", () => {
		const s = snap("a.py", 1, { x: "1" });
		expect(snapshotHash(s)).toBe(snapshotHash(snap("a.py", 1, { x: "1" })));
	});

	test("differs when any field differs", () => {
		const base = snap("a.py", 1, { x: "1" });
		expect(snapshotHash(base)).not.toBe(snapshotHash(snap("a.py", 2, { x: "1" })));
		expect(snapshotHash(base)).not.toBe(snapshotHash(snap("a.py", 1, { x: "2" })));
	});

	test("is independent of object key order (canonical encoding)", () => {
		const a: StateSnapshot = {
			thread_id: "1",
			frame_id: "1",
			location: { file: "a.py", line: 1 },
			scopes: [],
		};
		const b: StateSnapshot = {
			scopes: [],
			location: { line: 1, file: "a.py" },
			frame_id: "1",
			thread_id: "1",
		};
		expect(snapshotHash(a)).toBe(snapshotHash(b));
	});
});

describe("hasConsequentialEffect (Item 25)", () => {
	test("a step with a console event is consequential", () => {
		const d = delta(snap("a.py", 1), snap("a.py", 2), { console: true });
		expect(hasConsequentialEffect(d)).toBe(true);
	});

	test("a step with an exception is consequential", () => {
		const d = delta(snap("a.py", 1), snap("a.py", 2), { exception: true });
		expect(hasConsequentialEffect(d)).toBe(true);
	});

	test("a step that only changed a variable is NOT consequential", () => {
		const d = delta(snap("a.py", 1), snap("a.py", 2));
		expect(hasConsequentialEffect(d)).toBe(false);
	});

	test("null (the first checkpoint, no preceding step) is not consequential", () => {
		expect(hasConsequentialEffect(null)).toBe(false);
	});
});

describe("checkpointSnapshot (Item 25)", () => {
	test("the checkpoint id is the snapshot's content hash", () => {
		const s = snap("a.py", 1);
		const cp = checkpointSnapshot(0, s, null);
		expect(cp.checkpoint_id).toBe(snapshotHash(s));
		expect(cp.sequence).toBe(0);
		expect(cp.delta).toBeNull();
	});
});

describe("Timeline.at / forward / backward (Item 25)", () => {
	function makeTimeline(): { timeline: Timeline; snaps: StateSnapshot[] } {
		const snaps = [snap("a.py", 1, { x: "0" }), snap("a.py", 2, { x: "1" }), snap("a.py", 3, { x: "2" })];
		const checkpoints: Checkpoint[] = [
			checkpointSnapshot(0, snaps[0] as StateSnapshot, null),
			checkpointSnapshot(1, snaps[1] as StateSnapshot, delta(snaps[0] as StateSnapshot, snaps[1] as StateSnapshot)),
			checkpointSnapshot(2, snaps[2] as StateSnapshot, delta(snaps[1] as StateSnapshot, snaps[2] as StateSnapshot)),
		];
		return { timeline: new Timeline(checkpoints), snaps };
	}

	test("at() returns the checkpoint recorded at that sequence", () => {
		const { timeline } = makeTimeline();
		const result = timeline.at(1);
		expect(result.found).toBe(true);
		if (result.found) expect(result.checkpoint.sequence).toBe(1);
	});

	test("at() on a sequence never recorded is an explicit miss, not an interpolation", () => {
		const { timeline } = makeTimeline();
		const result = timeline.at(99);
		expect(result.found).toBe(false);
		if (!result.found) expect(result.reason).toContain("99");
	});

	test("a gap in recorded sequences (e.g. only 0, 1, 5 captured) is a miss at 3, not a guess", () => {
		const snaps = [snap("a.py", 1), snap("a.py", 2), snap("a.py", 9)];
		const timeline = new Timeline([
			checkpointSnapshot(0, snaps[0] as StateSnapshot, null),
			checkpointSnapshot(1, snaps[1] as StateSnapshot, delta(snaps[0] as StateSnapshot, snaps[1] as StateSnapshot)),
			checkpointSnapshot(5, snaps[2] as StateSnapshot, delta(snaps[1] as StateSnapshot, snaps[2] as StateSnapshot)),
		]);
		const result = timeline.at(3);
		expect(result.found).toBe(false);
	});

	test("forward() moves to the next recorded sequence", () => {
		const { timeline } = makeTimeline();
		const result = timeline.forward(0);
		expect(result.found).toBe(true);
		if (result.found) expect(result.checkpoint.sequence).toBe(1);
	});

	test("backward() moves to the previous recorded sequence", () => {
		const { timeline } = makeTimeline();
		const result = timeline.backward(2);
		expect(result.found).toBe(true);
		if (result.found) expect(result.checkpoint.sequence).toBe(1);
	});

	test("forward()/backward() can be asked to move more than one step", () => {
		const { timeline } = makeTimeline();
		const fwd = timeline.forward(0, 2);
		expect(fwd.found).toBe(true);
		if (fwd.found) expect(fwd.checkpoint.sequence).toBe(2);
		const back = timeline.backward(2, 2);
		expect(back.found).toBe(true);
		if (back.found) expect(back.checkpoint.sequence).toBe(0);
	});

	test("backward() past the first checkpoint is a miss, not a wrap or an invented state", () => {
		const { timeline } = makeTimeline();
		const result = timeline.backward(0);
		expect(result.found).toBe(false);
	});

	test("navigating never re-executes: the returned checkpoint's delta is the ALREADY-RECORDED one", () => {
		const { timeline, snaps } = makeTimeline();
		const result = timeline.forward(0);
		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.checkpoint.delta?.from_location).toEqual((snaps[0] as StateSnapshot).location);
			expect(result.checkpoint.delta?.to_location).toEqual((snaps[1] as StateSnapshot).location);
		}
	});
});

describe("Timeline content addressing (Item 25)", () => {
	test("byContent finds every checkpoint sharing a hash, e.g. a loop converging on the same state", () => {
		const s0 = snap("a.py", 1, { x: "0" });
		const s1 = snap("a.py", 2, { x: "1" });
		const s2 = snap("a.py", 1, { x: "0" }); // identical to s0: loop converged
		const timeline = new Timeline([
			checkpointSnapshot(0, s0, null),
			checkpointSnapshot(1, s1, delta(s0, s1)),
			checkpointSnapshot(2, s2, delta(s1, s2)),
		]);
		const matches = timeline.byContent(snapshotHash(s0));
		expect(matches.map((c) => c.sequence).sort()).toEqual([0, 2]);
	});

	test("jumpTo resolves a hash computed independently of this timeline", () => {
		const s0 = snap("a.py", 1, { x: "0" });
		const s1 = snap("a.py", 2, { x: "1" });
		const timeline = new Timeline([checkpointSnapshot(0, s0, null), checkpointSnapshot(1, s1, delta(s0, s1))]);
		const independentlyComputedHash = snapshotHash(snap("a.py", 2, { x: "1" }));
		const result = timeline.jumpTo(independentlyComputedHash);
		expect(result.found).toBe(true);
		if (result.found) expect(result.checkpoint.sequence).toBe(1);
	});

	test("jumpTo on an unknown hash is an explicit miss", () => {
		const s0 = snap("a.py", 1);
		const timeline = new Timeline([checkpointSnapshot(0, s0, null)]);
		const result = timeline.jumpTo("0".repeat(32));
		expect(result.found).toBe(false);
	});
});

describe("Timeline.consequentialSequences (Item 25)", () => {
	test("names exactly the sequences whose step had a console event or exception", () => {
		const s0 = snap("a.py", 1);
		const s1 = snap("a.py", 2);
		const s2 = snap("a.py", 3);
		const s3 = snap("a.py", 4);
		const timeline = new Timeline([
			checkpointSnapshot(0, s0, null),
			checkpointSnapshot(1, s1, delta(s0, s1)), // plain
			checkpointSnapshot(2, s2, delta(s1, s2, { console: true })),
			checkpointSnapshot(3, s3, delta(s2, s3, { exception: true })),
		]);
		expect(timeline.consequentialSequences()).toEqual([2, 3]);
	});
});

describe("Timeline.deltasBetween (Item 25)", () => {
	test("returns the ordered deltas strictly after the start and up to the end", () => {
		const s0 = snap("a.py", 1);
		const s1 = snap("a.py", 2);
		const s2 = snap("a.py", 3);
		const d1 = delta(s0, s1);
		const d2 = delta(s1, s2);
		const timeline = new Timeline([
			checkpointSnapshot(0, s0, null),
			checkpointSnapshot(1, s1, d1),
			checkpointSnapshot(2, s2, d2),
		]);
		expect(timeline.deltasBetween(0, 2)).toEqual([d1, d2]);
	});

	test("an endpoint with no recorded checkpoint returns null rather than a truncated range", () => {
		const s0 = snap("a.py", 1);
		const timeline = new Timeline([checkpointSnapshot(0, s0, null)]);
		expect(timeline.deltasBetween(0, 99)).toBeNull();
	});
});

describe("buildTimeline (Item 25)", () => {
	test("wraps the same (snapshot, delta) pairs debug/controller.ts produces live", () => {
		const s0 = snap("a.py", 1);
		const s1 = snap("a.py", 2);
		const timeline = buildTimeline([
			{ snapshot: s0, delta: null },
			{ snapshot: s1, delta: delta(s0, s1) },
		]);
		expect(timeline.length).toBe(2);
		expect(timeline.at(0).found).toBe(true);
		expect(timeline.at(1).found).toBe(true);
	});
});
