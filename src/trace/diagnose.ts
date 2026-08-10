/**
 * Turn a retrieved distributed trace into Failsafe's canonical diagnosis
 * packet (item 40).
 *
 * The value of this path is that an agent gets the SAME compact contract for a
 * failing trace as for a failing command — one packet shape, one set of
 * evidence rules — regardless of whether the spans came from Jaeger or Tempo.
 * Root-cause ranking reuses the item-38 causal graph rather than reinventing
 * it: spans become causal nodes and parent links become `child_of` edges.
 *
 * Read-only and bounded by construction: `TraceSource` exposes only a fetch,
 * every query must name a trace id, the lookback window is capped, and the
 * span count is capped before anything is analyzed.
 */
import { createHash } from "node:crypto";
import { buildCausalGraph, rankRootCauses } from "../diagnosis/causal-graph.js";
import type { CausalEdge, CausalNode } from "../diagnosis/causal-graph.js";
import { SCHEMA_VERSION } from "../types/common.js";
import type { EvidenceItem, FailureDiagnosis } from "../types/diagnosis.js";
import {
	BACKEND_ADAPTERS,
	type BackendKind,
	type NormalizedSpan,
	applyBounds,
	buildSpanTree,
} from "./normalize.js";

/** A read-only trace backend. There is deliberately no write/mutate method. */
export type TraceSource = {
	kind: BackendKind;
	/** Backend identity for provenance (endpoint name, fixture dir, …). */
	name: string;
	fetchTrace(traceId: string): Promise<unknown>;
};

export type TraceQuery = {
	trace_id: string;
	/** How far back the query may look, in ms. Capped by `MAX_LOOKBACK_MS`. */
	lookback_ms?: number;
	/** Span cap for this query. Capped by `MAX_SPANS`. */
	max_spans?: number;
};

/** Hard ceilings — a trace query must never become an unbounded scan. */
export const MAX_SPANS = 2000;
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SPANS = 500;

export type QueryRejection = { ok: false; reason: string };
export type QueryAccepted = { ok: true; query: Required<TraceQuery> };

/**
 * Validate a query before any backend call. Rejects unbounded/high-cardinality
 * scans: a missing or wildcard trace id, and an over-wide lookback.
 */
export function guardQuery(query: TraceQuery): QueryAccepted | QueryRejection {
	const traceId = query.trace_id?.trim() ?? "";
	if (traceId.length === 0) {
		return { ok: false, reason: "trace_id is required; unbounded trace scans are not supported" };
	}
	if (traceId === "*" || traceId.includes("*") || traceId.includes("%")) {
		return { ok: false, reason: `wildcard trace_id is not supported: ${traceId}` };
	}
	const lookback = query.lookback_ms ?? MAX_LOOKBACK_MS;
	if (lookback > MAX_LOOKBACK_MS) {
		return {
			ok: false,
			reason: `lookback_ms ${lookback} exceeds the ${MAX_LOOKBACK_MS} ms ceiling`,
		};
	}
	const maxSpans = Math.min(query.max_spans ?? DEFAULT_MAX_SPANS, MAX_SPANS);
	return { ok: true, query: { trace_id: traceId, lookback_ms: lookback, max_spans: maxSpans } };
}

/** Map spans onto the item-38 causal graph. */
export function spansToCausalGraph(spans: NormalizedSpan[]): {
	nodes: CausalNode[];
	edges: CausalEdge[];
} {
	const nodes: CausalNode[] = spans.map((span) => ({
		id: span.span_id,
		kind: kindForSpan(span),
		status: span.status === "error" ? "failed" : "ok",
		ts: span.start_ms,
		message: span.messages[0] ?? span.attributes["exception.message"] ?? span.name,
		service: span.service,
	}));
	const known = new Set(spans.map((s) => s.span_id));
	const edges: CausalEdge[] = [];
	for (const span of spans) {
		if (span.parent_span_id && known.has(span.parent_span_id)) {
			// A child's failure is explained by its parent only in the sense of
			// containment; the *upstream* node is the parent.
			edges.push({ from: span.parent_span_id, to: span.span_id, type: "child_of" });
		}
	}
	return { nodes, edges };
}

function kindForSpan(span: NormalizedSpan): CausalNode["kind"] {
	if (span.attributes["gen_ai.tool.name"]) return "tool";
	if (span.attributes["gen_ai.operation.name"] === "invoke_agent") return "agent";
	if (span.attributes["db.system"] || span.attributes["rpc.method"]) return "service";
	return span.parent_span_id ? "tool" : "service";
}

export type TraceProvenance = {
	backend: BackendKind;
	source: string;
	trace_id: string;
	span_count: number;
	truncated: boolean;
	dropped_spans: number;
	max_spans: number;
};

/**
 * Build the canonical diagnosis packet from normalized spans.
 *
 * Ids are derived deterministically from the trace + span set, so the SAME
 * logical trace yields a byte-identical packet no matter which backend shape it
 * arrived in (only `provenance.backend`/`source` differ).
 */
export function diagnoseSpans(
	spans: NormalizedSpan[],
	provenance: Omit<TraceProvenance, "span_count">,
): FailureDiagnosis & { trace_provenance: TraceProvenance } {
	const { nodes, edges } = spansToCausalGraph(spans);
	const graph = buildCausalGraph(nodes, edges);
	const ranking = rankRootCauses(graph);
	const spanById = new Map(spans.map((s) => [s.span_id, s]));
	const failed = spans.filter((s) => s.status === "error");

	const evidence: EvidenceItem[] = [];
	const primary = ranking.root_causes[0];
	const primarySpan = primary ? spanById.get(primary.node_id) : undefined;

	if (primary && primarySpan) {
		evidence.push({
			kind: "error_message",
			location: `${primarySpan.service}:${primarySpan.name}`,
			value: primarySpan.messages[0] ?? primary.message ?? primarySpan.name,
		});
		// The causal chain from the root cause to its deepest symptom.
		const path = primary.evidence_path
			.map((id) => {
				const span = spanById.get(id);
				return span ? `${span.service}:${span.name}` : id;
			})
			.join(" -> ");
		evidence.push({ kind: "stack_frame", location: primarySpan.service, value: path });
	}

	for (const span of failed.slice(0, 3)) {
		if (span.span_id === primary?.node_id) continue;
		evidence.push({
			kind: "error_message",
			location: `${span.service}:${span.name}`,
			value: span.messages[0] ?? span.attributes["otel.status_description"] ?? "span failed",
		});
	}

	const uncertainty = [...ranking.uncertainty];
	if (provenance.truncated) {
		uncertainty.push(
			`Trace was truncated to ${provenance.max_spans} spans (${provenance.dropped_spans} dropped); the true root cause may lie outside the retrieved window.`,
		);
	}
	if (failed.length === 0) {
		uncertainty.push("No span in this trace reported an error status.");
	}

	const summary =
		primary && primarySpan
			? `${primarySpan.service}:${primarySpan.name} failed — ${primarySpan.messages[0] ?? primary.message ?? "no message"}`
			: failed.length > 0
				? `${failed.length} span(s) failed with no identifiable root cause`
				: "No failing span in the retrieved trace";

	const fingerprint = createHash("sha256")
		.update(
			`${provenance.trace_id}|${spans.map((s) => `${s.span_id}:${s.status}:${s.start_ms}`).join(",")}`,
		)
		.digest("hex")
		.slice(0, 12);

	return {
		schema_version: SCHEMA_VERSION,
		// Deterministic (not random) so identical input yields identical output.
		diagnosis_id: `diag_trace_${fingerprint}`,
		failure_id: `trace_${provenance.trace_id}`,
		failure_type: "runtime_exception",
		severity: failed.length > 0 ? "error" : "warning",
		summary,
		root_cause:
			primary && primarySpan
				? {
						category: "connection_error",
						explanation: `Earliest explanatory failure in the trace is ${primarySpan.service}:${primarySpan.name}, with ${primary.downstream_failures} downstream failure(s).`,
						confidence: confidenceFor(primary.downstream_failures, ranking.uncertainty.length),
					}
				: undefined,
		evidence,
		uncertainty,
		minimal_context: [],
		suggested_next_actions:
			primary && primarySpan
				? [
						{
							command: `failsafe run "<command exercising ${primarySpan.service}>"`,
							reason: "Reproduce the upstream failure locally before patching downstream symptoms",
						},
					]
				: [],
		trace_provenance: { ...provenance, span_count: spans.length },
	};
}

/** More downstream damage = more confident this really is the root; open
 * uncertainty pulls it back down. Always kept out of the "high" band, since a
 * trace shows correlation, not proof. */
function confidenceFor(downstreamFailures: number, uncertaintyCount: number): number {
	const base = 0.45 + Math.min(downstreamFailures, 4) * 0.075;
	return Math.max(0.2, Math.round((base - uncertaintyCount * 0.1) * 100) / 100);
}

export type TraceDiagnosisResult =
	| { ok: true; data: FailureDiagnosis & { trace_provenance: TraceProvenance } }
	| { ok: false; error: { error: true; message: string } };

/**
 * Fetch a trace from a read-only source and diagnose it. The query is guarded
 * before any backend call, and the span cap is applied before analysis.
 */
export async function diagnoseTrace(
	source: TraceSource,
	query: TraceQuery,
): Promise<TraceDiagnosisResult> {
	const guarded = guardQuery(query);
	if (!guarded.ok) {
		return { ok: false, error: { error: true, message: guarded.reason } };
	}

	let payload: unknown;
	try {
		payload = await source.fetchTrace(guarded.query.trace_id);
	} catch (err) {
		return {
			ok: false,
			error: {
				error: true,
				message: `Trace fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}

	const all = BACKEND_ADAPTERS[source.kind](payload);
	if (all.length === 0) {
		return {
			ok: false,
			error: { error: true, message: `No spans found for trace ${guarded.query.trace_id}` },
		};
	}

	const bounded = applyBounds(all, { maxSpans: guarded.query.max_spans });
	return {
		ok: true,
		data: diagnoseSpans(bounded.spans, {
			backend: source.kind,
			source: source.name,
			trace_id: guarded.query.trace_id,
			truncated: bounded.truncated,
			dropped_spans: bounded.dropped,
			max_spans: guarded.query.max_spans,
		}),
	};
}

export { buildSpanTree };
