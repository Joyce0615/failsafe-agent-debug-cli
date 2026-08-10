/**
 * Read-only trace ingestion: backend adapters + span-tree normalization
 * (item 40).
 *
 * Failsafe already *emits* OTel spans but could not *retrieve* a failing trace
 * and turn it into the same compact diagnosis contract as command output. The
 * OpenTelemetry MCP Server shows agents querying Jaeger/Tempo-compatible
 * backends; this module normalizes those wire shapes into one span model so
 * everything downstream (causal ranking, the diagnosis packet) is
 * backend-agnostic.
 *
 * Pure: adapters take already-fetched payloads. Fetching lives behind the
 * `TraceSource` interface in `./diagnose.ts`, which is read-only by
 * construction — there is no write path to any backend.
 */
import { redactSecrets } from "../security/redaction.js";

export type SpanStatus = "ok" | "error" | "unset";

export type NormalizedSpan = {
	trace_id: string;
	span_id: string;
	parent_span_id?: string;
	name: string;
	service: string;
	/** Milliseconds since epoch. */
	start_ms: number;
	duration_ms: number;
	status: SpanStatus;
	/** Redacted, low-cardinality attribute subset. */
	attributes: Record<string, string>;
	/** Redacted error/exception messages attached to the span. */
	messages: string[];
};

/**
 * Attributes worth keeping: identity/status, never free-form payloads.
 * Backend-specific status markers (Jaeger's `error` bool, the resource-level
 * `service.name`) are deliberately excluded — they are folded into the
 * first-class `status`/`service` fields instead, so the normalized span is
 * genuinely backend-independent.
 */
const KEEP_ATTRS = [
	"exception.type",
	"exception.message",
	"otel.status_code",
	"otel.status_description",
	"http.status_code",
	"http.response.status_code",
	"http.method",
	"http.request.method",
	"rpc.method",
	"db.system",
	"gen_ai.tool.name",
	"gen_ai.operation.name",
];

/** Cap on attribute value length, so one huge attribute cannot bloat a packet. */
const MAX_ATTR_BYTES = 200;

function clean(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	const { redacted } = redactSecrets(text ?? "");
	return redacted.length > MAX_ATTR_BYTES ? `${redacted.slice(0, MAX_ATTR_BYTES)}…` : redacted;
}

type Json = Record<string, unknown>;

function asArray(value: unknown): Json[] {
	return Array.isArray(value) ? (value as Json[]) : [];
}

function pickAttrs(source: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of KEEP_ATTRS) {
		if (source[key] !== undefined) out[key] = clean(source[key]);
	}
	return out;
}

/** Derive status from RAW attributes (before the keep-list filter). */
function statusFrom(raw: Record<string, unknown>, explicit?: SpanStatus): SpanStatus {
	if (explicit) return explicit;
	if (raw.error === true || raw.error === "true" || raw.error === "True") return "error";
	if (String(raw["otel.status_code"] ?? "") === "ERROR") return "error";
	const code = Number.parseInt(
		String(raw["http.status_code"] ?? raw["http.response.status_code"] ?? ""),
		10,
	);
	if (Number.isFinite(code) && code >= 500) return "error";
	return "unset";
}

/**
 * Jaeger JSON (`/api/traces`): microsecond `startTime`/`duration`, typed
 * `tags`, `references` for parentage, and per-process service names.
 */
export function fromJaeger(payload: unknown): NormalizedSpan[] {
	const root = (payload ?? {}) as Json;
	const traces = asArray(root.data);
	const spans: NormalizedSpan[] = [];

	for (const trace of traces) {
		const traceId = String(trace.traceID ?? trace.trace_id ?? "");
		const processes = (trace.processes ?? {}) as Record<string, Json>;
		for (const raw of asArray(trace.spans)) {
			const tags: Record<string, unknown> = {};
			for (const tag of asArray(raw.tags)) {
				if (typeof tag.key === "string") tags[tag.key] = tag.value;
			}
			const attributes = pickAttrs(tags);

			const messages: string[] = [];
			for (const log of asArray(raw.logs)) {
				for (const field of asArray(log.fields)) {
					if (field.key === "message" || field.key === "event" || field.key === "error.object") {
						messages.push(clean(field.value));
					}
				}
			}
			if (attributes["exception.message"]) messages.push(attributes["exception.message"]);

			const parent = asArray(raw.references).find(
				(r) => r.refType === "CHILD_OF" || r.refType === "FOLLOWS_FROM",
			);
			const processId = String(raw.processID ?? "");
			const service = String(
				processes[processId]?.serviceName ?? tags["service.name"] ?? "unknown",
			);

			spans.push({
				trace_id: traceId,
				span_id: String(raw.spanID ?? ""),
				parent_span_id: parent ? String(parent.spanID) : undefined,
				name: String(raw.operationName ?? ""),
				service,
				start_ms: Math.round(Number(raw.startTime ?? 0) / 1000),
				duration_ms: Math.round(Number(raw.duration ?? 0) / 1000),
				status: statusFrom(tags),
				attributes,
				messages: dedupe(messages),
			});
		}
	}
	return sortSpans(spans);
}

/**
 * OTLP/Tempo JSON (`/api/traces/{id}`): resource/scope batches, nanosecond
 * timestamps, `{key, value:{stringValue|intValue|boolValue}}` attributes, and
 * an explicit `status.code` (2 = ERROR).
 */
export function fromTempo(payload: unknown): NormalizedSpan[] {
	const root = (payload ?? {}) as Json;
	const batches = asArray(root.batches ?? root.resourceSpans);
	const spans: NormalizedSpan[] = [];

	const flatten = (attrs: unknown): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (const attr of asArray(attrs)) {
			if (typeof attr.key !== "string") continue;
			const value = (attr.value ?? {}) as Json;
			out[attr.key] =
				value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue ?? null;
		}
		return out;
	};

	for (const batch of batches) {
		const resourceAttrs = flatten(((batch.resource ?? {}) as Json).attributes);
		const service = String(resourceAttrs["service.name"] ?? "unknown");
		for (const scope of asArray(batch.scopeSpans ?? batch.instrumentationLibrarySpans)) {
			for (const raw of asArray(scope.spans)) {
				const attrs = flatten(raw.attributes);
				const attributes = pickAttrs(attrs);
				const statusCode = Number(((raw.status ?? {}) as Json).code ?? 0);
				const explicit: SpanStatus | undefined =
					statusCode === 2 ? "error" : statusCode === 1 ? "ok" : undefined;

				const messages: string[] = [];
				const description = ((raw.status ?? {}) as Json).message;
				if (description) messages.push(clean(description));
				for (const event of asArray(raw.events)) {
					const eventAttrs = flatten(event.attributes);
					if (eventAttrs["exception.message"])
						messages.push(clean(eventAttrs["exception.message"]));
					else if (event.name === "exception") messages.push(clean(event.name));
				}
				if (attrs["exception.message"]) messages.push(clean(attrs["exception.message"]));

				const startNs = Number(raw.startTimeUnixNano ?? 0);
				const endNs = Number(raw.endTimeUnixNano ?? startNs);

				spans.push({
					trace_id: String(raw.traceId ?? raw.trace_id ?? ""),
					span_id: String(raw.spanId ?? raw.span_id ?? ""),
					parent_span_id: raw.parentSpanId ? String(raw.parentSpanId) : undefined,
					name: String(raw.name ?? ""),
					service,
					start_ms: Math.round(startNs / 1e6),
					duration_ms: Math.round((endNs - startNs) / 1e6),
					status: statusFrom(attrs, explicit),
					attributes,
					messages: dedupe(messages),
				});
			}
		}
	}
	return sortSpans(spans);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter((v) => v.length > 0))];
}

/** Deterministic order: start time, then span id — never backend order. */
function sortSpans(spans: NormalizedSpan[]): NormalizedSpan[] {
	return spans
		.filter((s) => s.span_id.length > 0)
		.sort((a, b) => a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id));
}

export type BackendKind = "jaeger" | "tempo";

export const BACKEND_ADAPTERS: Record<BackendKind, (payload: unknown) => NormalizedSpan[]> = {
	jaeger: fromJaeger,
	tempo: fromTempo,
};

export type SpanNode = { span: NormalizedSpan; children: SpanNode[]; depth: number };

/**
 * Build the span forest from parent links. Spans whose parent is absent from
 * the payload (a partial trace) become roots, so nothing is silently dropped.
 */
export function buildSpanTree(spans: NormalizedSpan[]): SpanNode[] {
	const nodes = new Map<string, SpanNode>();
	for (const span of spans) nodes.set(span.span_id, { span, children: [], depth: 0 });

	const roots: SpanNode[] = [];
	for (const node of nodes.values()) {
		const parentId = node.span.parent_span_id;
		const parent = parentId ? nodes.get(parentId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	const assignDepth = (node: SpanNode, depth: number): void => {
		node.depth = depth;
		node.children.sort((a, b) => a.span.start_ms - b.span.start_ms);
		for (const child of node.children) assignDepth(child, depth + 1);
	};
	roots.sort((a, b) => a.span.start_ms - b.span.start_ms);
	for (const root of roots) assignDepth(root, 0);
	return roots;
}

export type SpanBounds = { maxSpans: number };

/**
 * Apply the span cap. Truncation keeps the EARLIEST spans (a cascade is
 * explained by its beginning) and reports what was dropped.
 */
export function applyBounds(
	spans: NormalizedSpan[],
	bounds: SpanBounds,
): { spans: NormalizedSpan[]; truncated: boolean; dropped: number } {
	if (spans.length <= bounds.maxSpans) return { spans, truncated: false, dropped: 0 };
	return {
		spans: spans.slice(0, bounds.maxSpans),
		truncated: true,
		dropped: spans.length - bounds.maxSpans,
	};
}
