/**
 * Frame Lifetime Trace tests (item 37).
 *
 * Nested/recursive calls reconstruct into a deterministic frame tree; the
 * function-level navigation (jump-to-call / -failure / -last-write) resolves the
 * expected frames; and secrets are redacted (and oversize values byte-budgeted)
 * before entering the trace.
 */
import { describe, expect, test } from "bun:test";
import {
	FrameLifetimeTrace,
	jumpToCall,
	jumpToFailure,
	jumpToLastWrite,
	reconstructFrames,
} from "../../src/debug/frame-trace.js";

/** Record a recursive countdown(n) that raises at the base case. */
function recordRecursive(): FrameLifetimeTrace {
	const t = new FrameLifetimeTrace();
	function countdown(n: number): void {
		t.recordCall("countdown", { n: String(n) }, { file: "rec.py", line: 3 });
		t.recordWrite("n", String(n));
		if (n === 0) {
			t.recordException("hit zero", "ValueError");
			t.recordReturn();
			return;
		}
		countdown(n - 1);
		t.recordReturn(String(n));
	}
	countdown(3);
	return t;
}

describe("FrameLifetimeTrace reconstruction", () => {
	test("nested/recursive calls reconstruct into a deterministic frame tree", () => {
		const trace = recordRecursive();
		const events = trace.getEvents();

		const framesA = reconstructFrames(events);
		const framesB = reconstructFrames(events);
		expect(framesA).toEqual(framesB); // deterministic

		// countdown(3) → 4 frames (n=3,2,1,0), each the child of the previous.
		expect(framesA).toHaveLength(4);
		expect(framesA.map((f) => f.depth)).toEqual([0, 1, 2, 3]);
		expect(framesA.map((f) => f.function)).toEqual([
			"countdown",
			"countdown",
			"countdown",
			"countdown",
		]);
		// Parent/child chain is linear for a single recursion path.
		expect(framesA[0].children).toEqual([1]);
		expect(framesA[1].parent_id).toBe(0);
		expect(framesA[3].parent_id).toBe(2);
		// Args captured per frame.
		expect(framesA.map((f) => f.args.n)).toEqual(["3", "2", "1", "0"]);
	});

	test("sibling calls nest under the correct parent", () => {
		const t = new FrameLifetimeTrace();
		t.recordCall("main");
		t.recordCall("a");
		t.recordReturn();
		t.recordCall("b");
		t.recordReturn();
		t.recordReturn();
		const frames = t.frames();
		const main = frames.find((f) => f.function === "main")!;
		expect(main.children).toHaveLength(2);
		expect(frames.filter((f) => f.parent_id === main.frame_id).map((f) => f.function)).toEqual([
			"a",
			"b",
		]);
	});
});

describe("function-level navigation", () => {
	test("jumpToCall finds first and last frame of a function", () => {
		const frames = recordRecursive().frames();
		expect(jumpToCall(frames, "countdown")?.frame_id).toBe(0);
		expect(jumpToCall(frames, "countdown", { which: "last" })?.frame_id).toBe(3);
		expect(jumpToCall(frames, "missing")).toBeNull();
	});

	test("jumpToFailure returns the deepest raising frame", () => {
		const frames = recordRecursive().frames();
		const failure = jumpToFailure(frames);
		expect(failure?.frame_id).toBe(3); // the n===0 base case raised
		expect(failure?.raised?.type).toBe("ValueError");
	});

	test("jumpToLastWrite returns the most recent write of a variable", () => {
		const trace = recordRecursive();
		const lastN = jumpToLastWrite(trace.getEvents(), "n");
		// Last write of `n` is in the deepest frame (n=0).
		expect(lastN?.frame_id).toBe(3);
		expect(lastN?.value).toBe("0");
	});
});

describe("redaction + byte budget", () => {
	test("secrets never enter the trace", () => {
		const t = new FrameLifetimeTrace();
		t.recordCall("connect", { token: `Bearer ${"sk-" + "a".repeat(24)}` });
		t.recordWrite("dsn", `postgres://user:${"s3cr3tpw"}@db:5432/app`);
		t.recordException(`failed with key ${"AKIA" + "IOSFODNN7EXAMPLE"}`);
		const [frame] = t.frames();
		const serialized = JSON.stringify(t.getEvents());
		expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(serialized).not.toContain("s3cr3tpw");
		expect(serialized).toContain("[REDACTED]");
		expect(frame.raised?.message).toContain("[REDACTED]");
	});

	test("oversize values are truncated to the byte budget", () => {
		const t = new FrameLifetimeTrace({ maxValueBytes: 16 });
		t.recordCall("f", { big: "x".repeat(1000) });
		const [frame] = t.frames();
		expect(frame.args.big.startsWith("x".repeat(16))).toBe(true);
		expect(frame.args.big).toContain("[+");
		expect(frame.args.big.length).toBeLessThan(60);
	});
});
