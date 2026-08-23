/**
 * Optional OpenTelemetry span emission.
 *
 * Telemetry is OFF by default and has zero overhead unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set. When enabled, Failsafe emits spans for
 * its core operations (run, parse, diagnose, repro, verify, resolve) with
 * attributes like failure type, confidence, parser matched, fix source, token
 * compression, and raw output sizes.
 *
 * Spans are exported over OTLP/HTTP. Call `shutdownTelemetry()` before the
 * process exits to flush pending spans.
 *
 * All attributes pass through the capture policy in `capture-policy.ts` before
 * they are written to a span (item 41), so the span processor's buffer — and
 * therefore every exporter — only ever holds values the policy has cleared.
 */
import { type Span, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import {
	type CaptureCounters,
	applyCapturePolicy,
	capturePolicySpanAttributes,
} from "./capture-policy.js";
import {
	EXCEPTION_EVENT_NAME,
	exceptionEvent,
	genAiResourceAttributes,
	tracerOptions,
} from "./genai-schema.js";

let tracer: Tracer | null = null;
let provider: { forceFlush(): Promise<void>; shutdown(): Promise<void> } | null = null;
let initialized = false;

export function isTelemetryEnabled(): boolean {
	return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/**
 * Lazily initialize the tracer provider. Idempotent. No-op when telemetry is
 * disabled. Dynamically imports the heavy SDK so the common (disabled) path
 * never loads it.
 */
async function ensureInitialized(): Promise<void> {
	if (initialized || !isTelemetryEnabled()) return;
	initialized = true;

	try {
		const [{ NodeTracerProvider }, { OTLPTraceExporter }, { BatchSpanProcessor }, resourceMod] =
			await Promise.all([
				import("@opentelemetry/sdk-trace-node"),
				import("@opentelemetry/exporter-trace-otlp-http"),
				import("@opentelemetry/sdk-trace-base"),
				import("@opentelemetry/resources"),
			]);

		const exporter = new OTLPTraceExporter();
		// The resource declares the GenAI schema revision this process emits
		// under (item 52), so a consumer can tell which conventions produced a
		// batch even when every span in it has been filtered down to nothing.
		const resource =
			typeof resourceMod.resourceFromAttributes === "function"
				? resourceMod.resourceFromAttributes(genAiResourceAttributes())
				: undefined;

		const nodeProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		nodeProvider.register();
		provider = nodeProvider;
		// `schemaUrl` is the API-level declaration of the conventions revision;
		// emitting `gen_ai.*` without it forces every consumer to guess. The
		// tracer comes from the provider rather than the global `trace` proxy
		// because only `TracerProvider.getTracer` accepts `TracerOptions`.
		tracer = nodeProvider.getTracer("failsafe", "0.1.0", tracerOptions());
	} catch {
		// If the SDK fails to load/init, silently disable telemetry.
		tracer = null;
		provider = null;
	}
}

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * Run `fn` inside a span named `name`. When telemetry is disabled this simply
 * awaits `fn()` with no overhead. Attributes with `undefined` values are
 * dropped. Records the error status and re-throws on exception.
 */
export async function withSpan<T>(
	name: string,
	fn: (setAttributes: (attrs: SpanAttributes) => void) => Promise<T>,
	initialAttrs?: SpanAttributes,
): Promise<T> {
	if (!isTelemetryEnabled()) {
		// Disabled: run with a no-op attribute setter.
		return fn(() => {});
	}

	await ensureInitialized();
	if (!tracer) {
		return fn(() => {});
	}

	return tracer.startActiveSpan(name, async (span: Span) => {
		// Per-span tally of what the capture policy withheld or rewrote, so the
		// span can report the shape of its own omissions before it ends.
		const tally = { dropped: 0, truncated: 0, redacted: 0, high_cardinality: 0 };
		const write = (attrs: SpanAttributes) => {
			const counters = applyAttributes(span, attrs);
			tally.dropped += counters.dropped_mode + counters.dropped_limit;
			tally.truncated += counters.truncated;
			tally.redacted += counters.redacted;
			tally.high_cardinality += counters.high_cardinality;
		};

		if (initialAttrs) write(initialAttrs);
		try {
			const result = await fn(write);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (err) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			// The error is escaping the span's scope, which is a different fact
			// from "an error was handled here" and is recorded as such.
			recordExceptionEvent(span, err, { escaped: true });
			throw err;
		} finally {
			applyAttributes(
				span,
				capturePolicySpanAttributes({
					dropped_mode: tally.dropped,
					dropped_limit: 0,
					truncated: tally.truncated,
					redacted: tally.redacted,
					high_cardinality: tally.high_cardinality,
				}),
			);
			span.end();
		}
	});
}

/**
 * Set span attributes, dropping `undefined` values.
 *
 * Bare keys are namespaced under `failsafe.*`. A key that already contains a
 * `.` is treated as fully qualified and emitted verbatim, which is how the
 * OpenTelemetry GenAI semantic-convention attributes (`gen_ai.*`, item 30)
 * reach the wire without being double-namespaced.
 */
export function spanAttributeKey(key: string): string {
	return key.includes(".") ? key : `failsafe.${key}`;
}

/**
 * Anything that accepts attributes. A real `Span` satisfies this; so does a
 * recording fake, which is how `tests/telemetry/capture-policy.test.ts` proves
 * that a raw value never reaches the sink.
 */
export type AttributeSink = {
	setAttribute(key: string, value: string | number | boolean): unknown;
};

/**
 * The single writer into a span's attribute set.
 *
 * Every attribute is evaluated by the capture policy (item 41) *before*
 * `setAttribute`, so nothing the policy rejects is ever buffered by the span
 * processor or observed by an exporter. Returns the policy counters so the
 * caller can summarize what was withheld.
 */
export function applyAttributes(span: AttributeSink, attrs: SpanAttributes): CaptureCounters {
	const { attributes, counters } = applyCapturePolicy(attrs);
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined) {
			span.setAttribute(spanAttributeKey(key), value);
		}
	}
	return counters;
}

/** Anything that accepts span events. A real `Span` satisfies this. */
export type EventSink = {
	addEvent(name: string, attributes?: Record<string, string | number | boolean>): unknown;
};

/**
 * The single writer of span events (item 52).
 *
 * Events are the second way payload reaches a span processor's buffer, and an
 * `exception` event carries the two highest-risk strings in the process — the
 * message and the stack trace. They go through exactly the same capture policy
 * as attributes, before `addEvent`, so the default `metadata` mode records that
 * an exception of a given class occurred and nothing about its contents.
 *
 * Event attribute keys are emitted verbatim: `exception.*` is a semantic
 * convention, not a Failsafe field, so namespacing it would be wrong.
 */
export function recordExceptionEvent(
	span: EventSink,
	error: unknown,
	opts: { escaped?: boolean } = {},
): CaptureCounters {
	const event = exceptionEvent(error, opts);
	const { attributes, counters } = applyCapturePolicy(event.attributes);
	const cleared: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined) cleared[key] = value;
	}
	span.addEvent(EXCEPTION_EVENT_NAME, cleared);
	return counters;
}

/** Flush and shut down the tracer provider. Safe to call when disabled. */
export async function shutdownTelemetry(timeoutMs = 3000): Promise<void> {
	if (!provider) return;
	const p = provider;
	provider = null;
	tracer = null;
	initialized = false;
	// Race the flush/shutdown against a timeout so a dead/slow collector
	// never blocks process exit or tests.
	const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
	const flush = (async () => {
		try {
			await p.forceFlush();
			await p.shutdown();
		} catch {
			// Best effort.
		}
	})();
	await Promise.race([flush, timeout]);
}
