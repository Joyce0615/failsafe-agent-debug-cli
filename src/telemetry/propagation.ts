/**
 * W3C trace-context propagation across agents, MCP servers, tools, and
 * subprocesses (item 56).
 *
 * Failsafe sits in the middle of a chain — an agent calls an MCP server, which
 * calls Failsafe, which spawns `pytest`, which may itself be instrumented — and
 * a trace is only worth collecting if it survives every one of those hops. The
 * three carriers differ, and each has its own way of losing context:
 *
 * - **HTTP headers** (`traceparent` / `tracestate`) for MCP over HTTP.
 * - **Environment variables** (`TRACEPARENT` / `TRACESTATE`) for subprocesses,
 *   which is the only channel a `Bun.spawn`'d test runner can read.
 * - **JSON-RPC `_meta`** for MCP over stdio, which has no headers at all.
 *
 * Four decisions carry the weight:
 *
 * 1. **An invalid parent starts a new trace, loudly.** The tempting behaviour
 *    is to repair a malformed `traceparent` — pad a short id, zero a bad flag.
 *    That manufactures a parent link that does not exist, which is strictly
 *    worse than a disconnected trace: a disconnected trace is visibly missing,
 *    while a fabricated edge silently attributes one system's latency to
 *    another. `continueTrace` returns `restarted` with a named reason instead.
 *
 * 2. **The sampled flag is inherited, never re-decided.** A hop that re-rolls
 *    the sampling decision produces traces with holes in the middle, which look
 *    exactly like dropped spans and are debugged as such for a long time.
 *
 * 3. **`tracestate` is bounded and validated at every hop.** It is the one
 *    field an upstream can put arbitrary text into, and it travels into a child
 *    process's environment, so it is treated as untrusted input: per-member key
 *    and value grammar, 32 members, a total byte ceiling, and duplicate keys
 *    collapsed to the most recent.
 *
 * 4. **Hops are counted.** An agent that calls a tool that calls the agent is a
 *    real topology and a real bug; `recordHop` keeps a counter in our own
 *    tracestate member so a loop is visible as a number rather than inferred
 *    from a span count.
 *
 * Pure and dependency-free: no OTel SDK, no network, no process spawning.
 */

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";
export const TRACEPARENT_ENV = "TRACEPARENT";
export const TRACESTATE_ENV = "TRACESTATE";

/** The only flag bit the spec defines. */
export const FLAG_SAMPLED = 0x01;

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

/** Per the spec: key is lowercase, optionally `tenant@vendor`. */
const TRACESTATE_KEY_RE = /^[a-z][a-z0-9_\-*/]{0,255}(@[a-z][a-z0-9_\-*/]{0,13})?$/;
/** Printable ASCII excluding `,` and `=`, not ending in a space. */
const TRACESTATE_VALUE_RE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

export const MAX_TRACESTATE_MEMBERS = 32;
export const MAX_TRACESTATE_BYTES = 512;

export type TraceStateMember = { key: string; value: string };
export type TraceState = TraceStateMember[];

export type SpanContext = {
	trace_id: string;
	span_id: string;
	sampled: boolean;
	trace_state: TraceState;
};

export type ParseFailure = { ok: false; reason: string };
export type ParseSuccess = { ok: true; context: SpanContext };
export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Parse a `traceparent`.
 *
 * Forward-compatible per the spec: a version above `00` is accepted with its
 * trailing fields ignored, because refusing a newer version would break a
 * perfectly usable trace over a field we do not read. Version `ff` is reserved
 * and is refused.
 */
export function parseTraceparent(raw: string | undefined, state: TraceState = []): ParseResult {
	if (!raw) return { ok: false, reason: "no traceparent present" };
	const trimmed = raw.trim();
	const parts = trimmed.split("-");
	if (parts.length < 4) return { ok: false, reason: "traceparent has fewer than four fields" };

	const [version, traceId, spanId, flags] = parts;
	if (!/^[0-9a-f]{2}$/.test(version)) {
		return { ok: false, reason: `version '${version}' is not two lowercase hex digits` };
	}
	if (version === "ff") return { ok: false, reason: "version ff is reserved" };
	if (version === "00" && parts.length !== 4) {
		return { ok: false, reason: "version 00 must have exactly four fields" };
	}

	if (!TRACE_ID_RE.test(traceId)) {
		return { ok: false, reason: `trace id '${traceId}' is not 32 lowercase hex digits` };
	}
	if (traceId === INVALID_TRACE_ID) return { ok: false, reason: "trace id is all zeroes" };
	if (!SPAN_ID_RE.test(spanId)) {
		return { ok: false, reason: `span id '${spanId}' is not 16 lowercase hex digits` };
	}
	if (spanId === INVALID_SPAN_ID) return { ok: false, reason: "span id is all zeroes" };
	if (!/^[0-9a-f]{2}$/.test(flags)) {
		return { ok: false, reason: `flags '${flags}' are not two lowercase hex digits` };
	}

	return {
		ok: true,
		context: {
			trace_id: traceId,
			span_id: spanId,
			sampled: (Number.parseInt(flags, 16) & FLAG_SAMPLED) !== 0,
			trace_state: state,
		},
	};
}

/** Serialize a context as a version-`00` `traceparent`. */
export function formatTraceparent(context: SpanContext): string {
	const flags = context.sampled ? "01" : "00";
	return `00-${context.trace_id}-${context.span_id}-${flags}`;
}

/**
 * Parse and sanitize a `tracestate`.
 *
 * Never fails: a malformed member is dropped, not propagated and not fatal.
 * Dropping is right because `tracestate` is other vendors' state — one bad
 * member from an upstream must not cost us the trace — while propagating it
 * unvalidated would forward whatever an upstream put there into a child
 * process's environment.
 *
 * Duplicate keys collapse to the *first* occurrence, which the spec defines as
 * the most recent writer.
 */
export function parseTracestate(raw: string | undefined): TraceState {
	if (!raw) return [];
	const members: TraceState = [];
	const seen = new Set<string>();
	let bytes = 0;

	for (const chunk of raw.split(",")) {
		const entry = chunk.trim();
		if (entry.length === 0) continue;
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const key = entry.slice(0, eq);
		const value = entry.slice(eq + 1);
		if (!TRACESTATE_KEY_RE.test(key)) continue;
		if (!TRACESTATE_VALUE_RE.test(value)) continue;
		if (seen.has(key)) continue;
		const size = key.length + value.length + 2;
		if (bytes + size > MAX_TRACESTATE_BYTES) break;
		if (members.length >= MAX_TRACESTATE_MEMBERS) break;
		seen.add(key);
		bytes += size;
		members.push({ key, value });
	}
	return members;
}

export function formatTracestate(state: TraceState): string {
	return state.map((m) => `${m.key}=${m.value}`).join(",");
}

/** Cryptographically random hex of `bytes` length, never all zeroes. */
function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	do {
		crypto.getRandomValues(buf);
	} while (buf.every((b) => b === 0));
	return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newTraceId(): string {
	return randomHex(16);
}

export function newSpanId(): string {
	return randomHex(8);
}

/** Start a brand-new root context. */
export function newRootContext(opts: { sampled?: boolean } = {}): SpanContext {
	return {
		trace_id: newTraceId(),
		span_id: newSpanId(),
		sampled: opts.sampled ?? true,
		trace_state: [],
	};
}

export type Carrier = {
	traceparent?: string;
	tracestate?: string;
};

export type ContinueAction = "continued" | "restarted";

export type ContinueResult = {
	context: SpanContext;
	action: ContinueAction;
	/** Present exactly when `action` is `restarted`. */
	reason?: string;
};

/**
 * Continue an incoming trace, or start a new one and say why.
 *
 * The context returned is always a *child*: a fresh span id whose parent is the
 * incoming span. On restart the trace id is fresh too, so nothing links the new
 * trace to the malformed one — an invented link is worse than no link.
 */
export function continueTrace(carrier: Carrier): ContinueResult {
	const state = parseTracestate(carrier.tracestate);
	const parsed = parseTraceparent(carrier.traceparent, state);
	if (!parsed.ok) {
		return {
			context: { ...newRootContext(), trace_state: state },
			action: "restarted",
			reason: parsed.reason,
		};
	}
	return {
		context: {
			trace_id: parsed.context.trace_id,
			span_id: newSpanId(),
			// Inherited, never re-decided: re-rolling here punches holes in the
			// middle of a trace that look exactly like dropped spans.
			sampled: parsed.context.sampled,
			trace_state: parsed.context.trace_state,
		},
		action: "continued",
	};
}

/** A child of `parent` in the same trace, with the same sampling decision. */
export function childContext(parent: SpanContext): SpanContext {
	return { ...parent, span_id: newSpanId() };
}

/** Our own `tracestate` member key. */
export const FAILSAFE_STATE_KEY = "failsafe";
/** Hops beyond this are treated as a propagation loop. */
export const MAX_HOPS = 16;

function readHops(state: TraceState): number {
	const member = state.find((m) => m.key === FAILSAFE_STATE_KEY);
	if (!member) return 0;
	const match = member.value.match(/(?:^|;)h:(\d+)/);
	return match ? Number.parseInt(match[1], 10) : 0;
}

export function hopCount(context: SpanContext): number {
	return readHops(context.trace_state);
}

/**
 * Record that this process handled the context.
 *
 * The counter lives in our own `tracestate` member and moves to the front, per
 * the spec's "most recent writer first" rule. An agent that calls a tool that
 * calls the agent is a real topology and a real bug; a number makes it visible
 * instead of leaving it to be inferred from a span count.
 */
export function recordHop(context: SpanContext): SpanContext {
	const hops = readHops(context.trace_state) + 1;
	const rest = context.trace_state.filter((m) => m.key !== FAILSAFE_STATE_KEY);
	return {
		...context,
		trace_state: [{ key: FAILSAFE_STATE_KEY, value: `h:${hops}` }, ...rest].slice(
			0,
			MAX_TRACESTATE_MEMBERS,
		),
	};
}

export function hopLimitExceeded(context: SpanContext): boolean {
	return hopCount(context) > MAX_HOPS;
}

/**
 * Inject into HTTP headers.
 *
 * Returns a new object; the caller's headers are never mutated, because a
 * header map is frequently reused across requests and an in-place write would
 * leak one request's context into the next.
 */
export function injectIntoHeaders(
	context: SpanContext,
	headers: Record<string, string> = {},
): Record<string, string> {
	const out: Record<string, string> = { ...headers };
	out[TRACEPARENT_HEADER] = formatTraceparent(context);
	const state = formatTracestate(context.trace_state);
	if (state.length > 0) out[TRACESTATE_HEADER] = state;
	else delete out[TRACESTATE_HEADER];
	return out;
}

/** Header names are case-insensitive on the wire, so lookup must be too. */
export function extractFromHeaders(headers: Record<string, string | undefined>): Carrier {
	const lower: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== undefined) lower[key.toLowerCase()] = value;
	}
	return { traceparent: lower[TRACEPARENT_HEADER], tracestate: lower[TRACESTATE_HEADER] };
}

/**
 * Inject into a subprocess environment.
 *
 * Uppercase `TRACEPARENT`/`TRACESTATE` is the convention every instrumented
 * runtime reads. Returns a new environment; mutating `process.env` here would
 * make the parent's own later spawns inherit a stale span id, which is a
 * genuinely hard bug to see.
 */
export function injectIntoEnv(
	context: SpanContext,
	env: Record<string, string | undefined> = {},
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value;
	}
	out[TRACEPARENT_ENV] = formatTraceparent(context);
	const state = formatTracestate(context.trace_state);
	if (state.length > 0) out[TRACESTATE_ENV] = state;
	else delete out[TRACESTATE_ENV];
	return out;
}

export function extractFromEnv(env: Record<string, string | undefined>): Carrier {
	return { traceparent: env[TRACEPARENT_ENV], tracestate: env[TRACESTATE_ENV] };
}

/**
 * JSON-RPC `_meta` shape used by MCP over stdio, which has no headers.
 *
 * Deliberately open: a JSON-RPC message carries `method`, `id`, `params`, and
 * whatever else the protocol version defines, and this module has no business
 * knowing about any of them. It reads and writes `_meta` and passes the rest
 * through untouched.
 */
export type MetaCarrier = { _meta?: Record<string, unknown>; [key: string]: unknown };

export function injectIntoMeta<T extends MetaCarrier>(
	context: SpanContext,
	message: T,
): T & { _meta: Record<string, unknown> } {
	const state = formatTracestate(context.trace_state);
	return {
		...message,
		_meta: {
			...(message._meta ?? {}),
			[TRACEPARENT_HEADER]: formatTraceparent(context),
			...(state.length > 0 ? { [TRACESTATE_HEADER]: state } : {}),
		},
	};
}

export function extractFromMeta(message: MetaCarrier): Carrier {
	const meta = message._meta ?? {};
	const traceparent = meta[TRACEPARENT_HEADER];
	const tracestate = meta[TRACESTATE_HEADER];
	return {
		...(typeof traceparent === "string" ? { traceparent } : {}),
		...(typeof tracestate === "string" ? { tracestate } : {}),
	};
}

export type PropagationDiagnostics = {
	action: ContinueAction;
	reason?: string;
	hops: number;
	hop_limit_exceeded: boolean;
	trace_id: string;
	sampled: boolean;
	/** `tracestate` members the sanitizer discarded. */
	dropped_state_members: number;
};

/**
 * One call covering the whole inbound path: extract, continue, count the hop,
 * and report what happened.
 *
 * The diagnostics are the point. Propagation fails silently by nature — a
 * broken link produces a perfectly valid-looking trace that is simply shorter
 * than it should be — so every restart, every dropped `tracestate` member, and
 * every hop is a number the caller can put on a span or in a log.
 */
export function receiveContext(carrier: Carrier): {
	context: SpanContext;
	diagnostics: PropagationDiagnostics;
} {
	const rawMembers = carrier.tracestate
		? carrier.tracestate.split(",").filter((c) => c.trim().length > 0).length
		: 0;
	const result = continueTrace(carrier);
	const context = recordHop(result.context);
	// Our own member does not count as "kept" upstream state.
	const kept = context.trace_state.filter((m) => m.key !== FAILSAFE_STATE_KEY).length;

	return {
		context,
		diagnostics: {
			action: result.action,
			...(result.reason ? { reason: result.reason } : {}),
			hops: hopCount(context),
			hop_limit_exceeded: hopLimitExceeded(context),
			trace_id: context.trace_id,
			sampled: context.sampled,
			dropped_state_members: Math.max(0, rawMembers - kept),
		},
	};
}
