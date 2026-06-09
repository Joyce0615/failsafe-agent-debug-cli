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
 */
import { type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

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
		const resource =
			typeof resourceMod.resourceFromAttributes === "function"
				? resourceMod.resourceFromAttributes({ "service.name": "failsafe" })
				: undefined;

		const nodeProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		nodeProvider.register();
		provider = nodeProvider;
		tracer = trace.getTracer("failsafe", "0.1.0");
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
		if (initialAttrs) applyAttributes(span, initialAttrs);
		try {
			const result = await fn((attrs) => applyAttributes(span, attrs));
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (err) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			span.end();
		}
	});
}

function applyAttributes(span: Span, attrs: SpanAttributes): void {
	for (const [key, value] of Object.entries(attrs)) {
		if (value !== undefined) {
			span.setAttribute(`failsafe.${key}`, value);
		}
	}
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
