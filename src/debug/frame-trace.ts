/**
 * Agent-centric function-level debugging interface + Frame Lifetime Trace
 * (item 37).
 *
 * ADI reports that line-by-line debugger interaction is expensive for agents and
 * instead exposes function-level navigation over a stateful Frame Lifetime
 * Trace. This module records call/return, arguments, selected locals (writes),
 * and exceptions as a compact, ordered event stream, reconstructs the frame tree
 * deterministically (nested and recursive calls included), and exposes
 * jump-to-call / jump-to-failure / jump-to-last-write navigation. Every value is
 * redacted and byte-budgeted before it enters the trace, so secrets never leak
 * and a single huge local can't blow the trace size.
 *
 * Pure (no fs/network/process): traces record → serialize → reconstruct →
 * navigate reproducibly.
 */
import { redactSecrets } from "../security/redaction.js";

export type TraceEventKind = "call" | "return" | "write" | "exception";

export type TraceEvent = {
	seq: number;
	kind: TraceEventKind;
	/** The frame this event belongs to (assigned at call time, stable). */
	frame_id: number;
	/** Present on `call`. */
	function?: string;
	location?: { file: string; line: number };
	/** Redacted argument map, present on `call`. */
	args?: Record<string, string>;
	/** Redacted return value, present on `return`. */
	value?: string;
	/** Present on `write`. */
	variable?: string;
	/** Present on `exception`. */
	exception?: { type?: string; message: string };
};

export type Frame = {
	frame_id: number;
	function: string;
	parent_id: number | null;
	depth: number;
	args: Record<string, string>;
	writes: Array<{ seq: number; variable: string; value: string }>;
	return_value?: string;
	raised?: { type?: string; message: string };
	children: number[];
	location?: { file: string; line: number };
};

const DEFAULT_MAX_VALUE_BYTES = 512;

/**
 * Records a Frame Lifetime Trace. Values are redacted + truncated to a byte
 * budget at record time so the persisted trace is secret-free and bounded.
 */
export class FrameLifetimeTrace {
	private readonly events: TraceEvent[] = [];
	private readonly stack: number[] = [];
	private seq = 0;
	private nextFrameId = 0;
	private readonly maxValueBytes: number;

	constructor(opts: { maxValueBytes?: number } = {}) {
		this.maxValueBytes = opts.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
	}

	private safe(value: string): string {
		const redacted = redactSecrets(value).redacted;
		if (Buffer.byteLength(redacted) <= this.maxValueBytes) return redacted;
		const truncated = Buffer.from(redacted).subarray(0, this.maxValueBytes).toString("utf-8");
		return `${truncated}…[+${Buffer.byteLength(redacted) - this.maxValueBytes}B]`;
	}

	private safeArgs(args: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(args)) out[k] = this.safe(v);
		return out;
	}

	/** Enter a function: assigns a fresh frame id and returns it. */
	recordCall(
		fn: string,
		args: Record<string, string> = {},
		location?: { file: string; line: number },
	): number {
		const frameId = this.nextFrameId++;
		this.events.push({
			seq: ++this.seq,
			kind: "call",
			frame_id: frameId,
			function: fn,
			args: this.safeArgs(args),
			...(location ? { location } : {}),
		});
		this.stack.push(frameId);
		return frameId;
	}

	/** Record a local write in the current (top) frame. */
	recordWrite(variable: string, value: string): void {
		const frameId = this.stack[this.stack.length - 1];
		if (frameId === undefined) return;
		this.events.push({
			seq: ++this.seq,
			kind: "write",
			frame_id: frameId,
			variable,
			value: this.safe(value),
		});
	}

	/** Record an exception raised in the current frame. */
	recordException(message: string, type?: string): void {
		const frameId = this.stack[this.stack.length - 1];
		if (frameId === undefined) return;
		this.events.push({
			seq: ++this.seq,
			kind: "exception",
			frame_id: frameId,
			exception: { type, message: this.safe(message) },
		});
	}

	/** Leave the current function, optionally recording its return value. */
	recordReturn(value?: string): void {
		const frameId = this.stack.pop();
		if (frameId === undefined) return;
		this.events.push({
			seq: ++this.seq,
			kind: "return",
			frame_id: frameId,
			...(value !== undefined ? { value: this.safe(value) } : {}),
		});
	}

	getEvents(): TraceEvent[] {
		return [...this.events];
	}

	/** Reconstruct the frame tree from the recorded events. */
	frames(): Frame[] {
		return reconstructFrames(this.events);
	}
}

/**
 * Deterministically reconstruct the frame tree from an ordered event stream.
 * Handles nested and recursive calls (each call is a distinct frame with a
 * stable id); returns frames in id order.
 */
export function reconstructFrames(events: TraceEvent[]): Frame[] {
	const frames = new Map<number, Frame>();
	const stack: number[] = [];

	for (const event of events) {
		switch (event.kind) {
			case "call": {
				const parentId = stack.length > 0 ? stack[stack.length - 1] : null;
				const frame: Frame = {
					frame_id: event.frame_id,
					function: event.function ?? "<anonymous>",
					parent_id: parentId,
					depth: stack.length,
					args: event.args ?? {},
					writes: [],
					children: [],
					...(event.location ? { location: event.location } : {}),
				};
				frames.set(event.frame_id, frame);
				if (parentId !== null) frames.get(parentId)?.children.push(event.frame_id);
				stack.push(event.frame_id);
				break;
			}
			case "write": {
				const frame = frames.get(event.frame_id);
				if (frame && event.variable !== undefined) {
					frame.writes.push({ seq: event.seq, variable: event.variable, value: event.value ?? "" });
				}
				break;
			}
			case "exception": {
				const frame = frames.get(event.frame_id);
				if (frame && event.exception) frame.raised = event.exception;
				break;
			}
			case "return": {
				const frame = frames.get(event.frame_id);
				if (frame && event.value !== undefined) frame.return_value = event.value;
				if (stack[stack.length - 1] === event.frame_id) stack.pop();
				break;
			}
		}
	}

	return [...frames.values()].sort((a, b) => a.frame_id - b.frame_id);
}

/** Jump to the first (or last) frame for a function name. */
export function jumpToCall(
	frames: Frame[],
	fn: string,
	opts: { which?: "first" | "last" } = {},
): Frame | null {
	const matches = frames.filter((f) => f.function === fn);
	if (matches.length === 0) return null;
	return opts.which === "last" ? matches[matches.length - 1] : matches[0];
}

/** Jump to the frame in which an exception was raised (deepest raiser). */
export function jumpToFailure(frames: Frame[]): Frame | null {
	const raisers = frames.filter((f) => f.raised);
	if (raisers.length === 0) return null;
	// The deepest raising frame is the origin of the failure.
	return raisers.reduce((deepest, f) => (f.depth > deepest.depth ? f : deepest), raisers[0]);
}

export type WriteRef = { frame_id: number; seq: number; variable: string; value: string };

/** Jump to the last write of a variable across the whole trace. */
export function jumpToLastWrite(events: TraceEvent[], variable: string): WriteRef | null {
	let last: WriteRef | null = null;
	for (const event of events) {
		if (event.kind === "write" && event.variable === variable) {
			last = {
				frame_id: event.frame_id,
				seq: event.seq,
				variable,
				value: event.value ?? "",
			};
		}
	}
	return last;
}
