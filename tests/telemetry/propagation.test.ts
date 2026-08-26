import { describe, expect, test } from "bun:test";
import {
	FAILSAFE_STATE_KEY,
	MAX_HOPS,
	MAX_TRACESTATE_BYTES,
	MAX_TRACESTATE_MEMBERS,
	type SpanContext,
	TRACEPARENT_ENV,
	TRACEPARENT_HEADER,
	TRACESTATE_ENV,
	TRACESTATE_HEADER,
	childContext,
	continueTrace,
	extractFromEnv,
	extractFromHeaders,
	extractFromMeta,
	formatTraceparent,
	formatTracestate,
	hopCount,
	hopLimitExceeded,
	injectIntoEnv,
	injectIntoHeaders,
	injectIntoMeta,
	newRootContext,
	newSpanId,
	newTraceId,
	parseTraceparent,
	parseTracestate,
	receiveContext,
	recordHop,
} from "../../src/telemetry/propagation.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const VALID = `00-${TRACE}-${SPAN}-01`;

describe("traceparent parsing", () => {
	test("a valid header round-trips", () => {
		const parsed = parseTraceparent(VALID);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.context.trace_id).toBe(TRACE);
		expect(parsed.context.span_id).toBe(SPAN);
		expect(parsed.context.sampled).toBe(true);
		expect(formatTraceparent(parsed.context)).toBe(VALID);
	});

	test("the sampled bit is read from the flags, not assumed", () => {
		const unsampled = parseTraceparent(`00-${TRACE}-${SPAN}-00`);
		expect(unsampled.ok && unsampled.context.sampled).toBe(false);
		// Any set bit other than 0x01 must not read as sampled.
		const other = parseTraceparent(`00-${TRACE}-${SPAN}-02`);
		expect(other.ok && other.context.sampled).toBe(false);
	});

	test("a newer version is accepted with its extra fields ignored", () => {
		const parsed = parseTraceparent(`01-${TRACE}-${SPAN}-01-extradata`);
		expect(parsed.ok).toBe(true);
	});

	test("version ff is reserved and refused", () => {
		const parsed = parseTraceparent(`ff-${TRACE}-${SPAN}-01`);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reason).toContain("reserved");
	});

	test("version 00 with extra fields is refused", () => {
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-01-extra`).ok).toBe(false);
	});

	test("all-zero ids are refused rather than repaired", () => {
		const zeroTrace = parseTraceparent(`00-${"0".repeat(32)}-${SPAN}-01`);
		expect(zeroTrace.ok).toBe(false);
		expect(zeroTrace.ok === false && zeroTrace.reason).toContain("all zeroes");
		expect(parseTraceparent(`00-${TRACE}-${"0".repeat(16)}-01`).ok).toBe(false);
	});

	test("wrong lengths, uppercase hex, and non-hex are all refused", () => {
		expect(parseTraceparent(`00-${TRACE.slice(1)}-${SPAN}-01`).ok).toBe(false);
		expect(parseTraceparent(`00-${TRACE.toUpperCase()}-${SPAN}-01`).ok).toBe(false);
		expect(parseTraceparent(`00-${"z".repeat(32)}-${SPAN}-01`).ok).toBe(false);
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-zz`).ok).toBe(false);
	});

	test("a missing or truncated header is refused with a reason", () => {
		expect(parseTraceparent(undefined).ok).toBe(false);
		const short = parseTraceparent(`00-${TRACE}-${SPAN}`);
		expect(short.ok).toBe(false);
		expect(short.ok === false && short.reason).toContain("four fields");
	});

	test("surrounding whitespace is tolerated", () => {
		expect(parseTraceparent(`  ${VALID}  `).ok).toBe(true);
	});
});

describe("tracestate sanitization", () => {
	test("well-formed members survive in order", () => {
		const state = parseTracestate("vendor1=a,vendor2=b");
		expect(state).toEqual([
			{ key: "vendor1", value: "a" },
			{ key: "vendor2", value: "b" },
		]);
		expect(formatTracestate(state)).toBe("vendor1=a,vendor2=b");
	});

	test("tenant@vendor keys are valid", () => {
		expect(parseTracestate("acct1@congo=t61rcWkgMzE")).toHaveLength(1);
	});

	test("a malformed member is dropped, not fatal to the rest", () => {
		const state = parseTracestate("GOOD=1,ok=2,=3,noequals,bad key=4");
		expect(state.map((m) => m.key)).toEqual(["ok"]);
	});

	test("duplicate keys collapse to the most recent writer", () => {
		expect(parseTracestate("a=new,b=1,a=old")).toEqual([
			{ key: "a", value: "new" },
			{ key: "b", value: "1" },
		]);
	});

	test("the member ceiling is enforced", () => {
		const raw = Array.from({ length: 50 }, (_, i) => `k${i}=v`).join(",");
		expect(parseTracestate(raw).length).toBeLessThanOrEqual(MAX_TRACESTATE_MEMBERS);
	});

	test("the byte ceiling is enforced before the member ceiling bites", () => {
		const raw = Array.from({ length: 30 }, (_, i) => `k${i}=${"x".repeat(200)}`).join(",");
		const state = parseTracestate(raw);
		expect(formatTracestate(state).length).toBeLessThanOrEqual(MAX_TRACESTATE_BYTES);
	});

	test("an absent header yields an empty state, not a fabricated one", () => {
		expect(parseTracestate(undefined)).toEqual([]);
		expect(parseTracestate("")).toEqual([]);
	});

	test("a value containing a comma or equals cannot smuggle a second member", () => {
		// `,` splits members, so the tail is a keyless fragment and is dropped.
		expect(parseTracestate("a=x,y").map((m) => m.key)).toEqual(["a"]);
		// `=` is outside the value grammar, so the whole member is refused rather
		// than accepted with a value that would re-parse differently downstream.
		expect(parseTracestate("a=x=y")).toEqual([]);
	});
});

describe("continuation versus restart", () => {
	test("a valid parent is continued with a fresh child span id", () => {
		const result = continueTrace({ traceparent: VALID });
		expect(result.action).toBe("continued");
		expect(result.context.trace_id).toBe(TRACE);
		expect(result.context.span_id).not.toBe(SPAN);
		expect(result.reason).toBeUndefined();
	});

	test("an invalid parent starts a NEW trace rather than inventing an edge", () => {
		const result = continueTrace({ traceparent: "garbage" });
		expect(result.action).toBe("restarted");
		expect(result.context.trace_id).not.toBe(TRACE);
		expect(result.reason).toBeTruthy();
	});

	test("a restart never reuses the malformed trace id", () => {
		const result = continueTrace({ traceparent: `00-${TRACE}-${"0".repeat(16)}-01` });
		expect(result.action).toBe("restarted");
		expect(result.context.trace_id).not.toBe(TRACE);
	});

	test("the sampling decision is inherited, never re-rolled", () => {
		for (let i = 0; i < 20; i++) {
			const result = continueTrace({ traceparent: `00-${TRACE}-${SPAN}-00` });
			expect(result.context.sampled).toBe(false);
		}
	});

	test("upstream tracestate survives a continuation", () => {
		const result = continueTrace({ traceparent: VALID, tracestate: "vendor=abc" });
		expect(result.context.trace_state).toEqual([{ key: "vendor", value: "abc" }]);
	});

	test("upstream tracestate survives even a restart", () => {
		// The state is other vendors' and is not invalidated by our parent link
		// being unusable.
		const result = continueTrace({ traceparent: "bad", tracestate: "vendor=abc" });
		expect(result.action).toBe("restarted");
		expect(result.context.trace_state).toEqual([{ key: "vendor", value: "abc" }]);
	});

	test("a child keeps the trace, the flags, and the state but not the span id", () => {
		const parent = newRootContext();
		const child = childContext(parent);
		expect(child.trace_id).toBe(parent.trace_id);
		expect(child.sampled).toBe(parent.sampled);
		expect(child.span_id).not.toBe(parent.span_id);
	});
});

describe("id generation", () => {
	test("ids have the right shape and are never all zeroes", () => {
		for (let i = 0; i < 50; i++) {
			const trace = newTraceId();
			const span = newSpanId();
			expect(trace).toMatch(/^[0-9a-f]{32}$/);
			expect(span).toMatch(/^[0-9a-f]{16}$/);
			expect(trace).not.toBe("0".repeat(32));
			expect(span).not.toBe("0".repeat(16));
		}
	});

	test("a generated root context parses as its own traceparent", () => {
		const context = newRootContext();
		expect(parseTraceparent(formatTraceparent(context)).ok).toBe(true);
	});

	test("ids do not repeat across calls", () => {
		const ids = new Set(Array.from({ length: 200 }, newSpanId));
		expect(ids.size).toBe(200);
	});
});

describe("HTTP header carrier", () => {
	const context: SpanContext = {
		trace_id: TRACE,
		span_id: SPAN,
		sampled: true,
		trace_state: [{ key: "vendor", value: "abc" }],
	};

	test("injection writes both headers", () => {
		const headers = injectIntoHeaders(context);
		expect(headers[TRACEPARENT_HEADER]).toBe(VALID);
		expect(headers[TRACESTATE_HEADER]).toBe("vendor=abc");
	});

	test("an empty tracestate emits no header rather than an empty one", () => {
		const headers = injectIntoHeaders({ ...context, trace_state: [] });
		expect(headers[TRACESTATE_HEADER]).toBeUndefined();
	});

	test("a stale tracestate header is removed, not left behind", () => {
		const headers = injectIntoHeaders(
			{ ...context, trace_state: [] },
			{ [TRACESTATE_HEADER]: "old=1" },
		);
		expect(headers[TRACESTATE_HEADER]).toBeUndefined();
	});

	test("the caller's header map is never mutated", () => {
		const original: Record<string, string> = { authorization: "Bearer x" };
		const injected = injectIntoHeaders(context, original);
		expect(original[TRACEPARENT_HEADER]).toBeUndefined();
		expect(injected.authorization).toBe("Bearer x");
	});

	test("extraction is case-insensitive, as the wire is", () => {
		const carrier = extractFromHeaders({ TraceParent: VALID, TRACESTATE: "vendor=abc" });
		expect(carrier.traceparent).toBe(VALID);
		expect(carrier.tracestate).toBe("vendor=abc");
	});

	test("a header round-trips through inject and extract", () => {
		const result = continueTrace(extractFromHeaders(injectIntoHeaders(context)));
		expect(result.action).toBe("continued");
		expect(result.context.trace_id).toBe(TRACE);
	});
});

describe("subprocess environment carrier", () => {
	const context = newRootContext();

	test("uppercase TRACEPARENT is written for the child", () => {
		const env = injectIntoEnv(context, { PATH: "/usr/bin" });
		expect(env[TRACEPARENT_ENV]).toBe(formatTraceparent(context));
		expect(env.PATH).toBe("/usr/bin");
	});

	test("the caller's environment object is never mutated", () => {
		const original: Record<string, string | undefined> = { PATH: "/usr/bin" };
		injectIntoEnv(context, original);
		expect(original[TRACEPARENT_ENV]).toBeUndefined();
	});

	test("undefined entries are dropped rather than stringified", () => {
		const env = injectIntoEnv(context, { EMPTY: undefined, KEEP: "1" });
		expect("EMPTY" in env).toBe(false);
		expect(env.KEEP).toBe("1");
	});

	test("a stale TRACESTATE from the parent environment is cleared", () => {
		const env = injectIntoEnv(context, { [TRACESTATE_ENV]: "old=1" });
		expect(env[TRACESTATE_ENV]).toBeUndefined();
	});

	test("a child can continue the parent's trace from its environment", () => {
		const env = injectIntoEnv(recordHop(context));
		const result = continueTrace(extractFromEnv(env));
		expect(result.action).toBe("continued");
		expect(result.context.trace_id).toBe(context.trace_id);
	});
});

describe("MCP _meta carrier", () => {
	const context = newRootContext();

	test("context is injected under _meta without disturbing the message", () => {
		const message = injectIntoMeta(context, { method: "tools/call", _meta: { progress: 1 } });
		expect(message.method).toBe("tools/call");
		expect(message._meta?.progress).toBe(1);
		expect(message._meta?.[TRACEPARENT_HEADER]).toBe(formatTraceparent(context));
	});

	test("a message with no _meta gains one", () => {
		const message = injectIntoMeta(context, { method: "x" });
		expect(message._meta?.[TRACEPARENT_HEADER]).toBeTruthy();
	});

	test("non-string meta values are ignored rather than coerced", () => {
		const carrier = extractFromMeta({ _meta: { [TRACEPARENT_HEADER]: 42 } });
		expect(carrier.traceparent).toBeUndefined();
	});

	test("a message with no _meta extracts an empty carrier", () => {
		expect(extractFromMeta({})).toEqual({});
	});

	test("a _meta message round-trips", () => {
		const withState = { ...context, trace_state: [{ key: "v", value: "1" }] };
		const result = continueTrace(extractFromMeta(injectIntoMeta(withState, { id: 1 })));
		expect(result.action).toBe("continued");
		expect(result.context.trace_state).toEqual([{ key: "v", value: "1" }]);
	});
});

describe("hop counting", () => {
	test("a fresh context has zero hops until one is recorded", () => {
		const context = newRootContext();
		expect(hopCount(context)).toBe(0);
		expect(hopCount(recordHop(context))).toBe(1);
	});

	test("hops accumulate across propagation", () => {
		let context = newRootContext();
		for (let i = 0; i < 5; i++) {
			const carrier = extractFromHeaders(injectIntoHeaders(recordHop(context)));
			context = continueTrace(carrier).context;
		}
		expect(hopCount(context)).toBe(5);
	});

	test("our member moves to the front, per most-recent-writer-first", () => {
		const context = recordHop({
			...newRootContext(),
			trace_state: [{ key: "vendor", value: "x" }],
		});
		expect(context.trace_state[0].key).toBe(FAILSAFE_STATE_KEY);
		expect(context.trace_state[1].key).toBe("vendor");
	});

	test("recording a hop does not duplicate our member", () => {
		let context = newRootContext();
		for (let i = 0; i < 4; i++) context = recordHop(context);
		expect(context.trace_state.filter((m) => m.key === FAILSAFE_STATE_KEY)).toHaveLength(1);
		expect(hopCount(context)).toBe(4);
	});

	test("a propagation loop is visible as a number, not inferred", () => {
		let context = newRootContext();
		for (let i = 0; i <= MAX_HOPS; i++) context = recordHop(context);
		expect(hopLimitExceeded(context)).toBe(true);
		expect(hopCount(context)).toBe(MAX_HOPS + 1);
	});

	test("a context at exactly the limit has not exceeded it", () => {
		let context = newRootContext();
		for (let i = 0; i < MAX_HOPS; i++) context = recordHop(context);
		expect(hopLimitExceeded(context)).toBe(false);
	});
});

describe("receiveContext diagnostics", () => {
	test("a good inbound context reports a continuation and one hop", () => {
		const { context, diagnostics } = receiveContext({ traceparent: VALID });
		expect(diagnostics.action).toBe("continued");
		expect(diagnostics.trace_id).toBe(TRACE);
		expect(diagnostics.hops).toBe(1);
		expect(diagnostics.reason).toBeUndefined();
		expect(context.span_id).not.toBe(SPAN);
	});

	test("a restart carries the reason, so a broken link is never silent", () => {
		const { diagnostics } = receiveContext({ traceparent: "00-bad" });
		expect(diagnostics.action).toBe("restarted");
		expect(diagnostics.reason).toBeTruthy();
	});

	test("dropped tracestate members are counted", () => {
		const { diagnostics } = receiveContext({
			traceparent: VALID,
			tracestate: "ok=1,BAD KEY=2,alsobad",
		});
		expect(diagnostics.dropped_state_members).toBe(2);
	});

	test("our own member is not counted as retained upstream state", () => {
		const { diagnostics } = receiveContext({ traceparent: VALID, tracestate: "ok=1" });
		expect(diagnostics.dropped_state_members).toBe(0);
	});

	test("an unsampled inbound trace stays unsampled in the diagnostics", () => {
		const { diagnostics } = receiveContext({ traceparent: `00-${TRACE}-${SPAN}-00` });
		expect(diagnostics.sampled).toBe(false);
	});

	test("no inbound context at all is a restart, not an error", () => {
		const { diagnostics } = receiveContext({});
		expect(diagnostics.action).toBe("restarted");
		expect(diagnostics.reason).toContain("no traceparent");
		expect(diagnostics.hops).toBe(1);
	});
});
