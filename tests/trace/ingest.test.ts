/**
 * OpenTelemetry trace-backend ingestion (item 40).
 *
 * The load-bearing property: a local fixture backend yields the SAME canonical
 * packet regardless of backend shape — the identical logical trace expressed in
 * Jaeger JSON and in OTLP/Tempo JSON must diagnose identically (modulo
 * provenance). Also covers bounded queries, span-tree normalization, redaction,
 * and the reuse of item 38's causal ranking.
 */
import { describe, expect, test } from "bun:test";
import {
	MAX_LOOKBACK_MS,
	MAX_SPANS,
	type TraceSource,
	diagnoseSpans,
	diagnoseTrace,
	guardQuery,
	spansToCausalGraph,
} from "../../src/trace/diagnose.js";
import { buildSpanTree, fromJaeger, fromTempo } from "../../src/trace/normalize.js";
import { FailureDiagnosisSchema } from "../../src/types/diagnosis.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

/**
 * One logical trace: `checkout` (root, ok) -> `orders` (failed) -> `payments`
 * (failed, the earliest explanatory fault).
 */
const JAEGER_PAYLOAD = {
	data: [
		{
			traceID: TRACE_ID,
			processes: {
				p1: { serviceName: "checkout" },
				p2: { serviceName: "orders" },
				p3: { serviceName: "payments" },
			},
			spans: [
				{
					spanID: "aaaa1111",
					operationName: "POST /checkout",
					processID: "p1",
					startTime: 1_700_000_000_000_000,
					duration: 500_000,
					references: [],
					tags: [],
				},
				{
					spanID: "bbbb2222",
					operationName: "createOrder",
					processID: "p2",
					startTime: 1_700_000_000_100_000,
					duration: 300_000,
					references: [{ refType: "CHILD_OF", spanID: "aaaa1111" }],
					tags: [
						{ key: "error", type: "bool", value: true },
						{ key: "otel.status_code", type: "string", value: "ERROR" },
					],
					logs: [{ fields: [{ key: "message", value: "order creation aborted" }] }],
				},
				{
					spanID: "cccc3333",
					operationName: "charge",
					processID: "p3",
					startTime: 1_700_000_000_050_000,
					duration: 40_000,
					references: [{ refType: "CHILD_OF", spanID: "aaaa1111" }],
					tags: [
						{ key: "error", type: "bool", value: true },
						{ key: "exception.message", type: "string", value: "gateway refused connection" },
					],
				},
			],
		},
	],
};

/** The same logical trace in OTLP/Tempo shape. */
const TEMPO_PAYLOAD = {
	batches: [
		{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
			scopeSpans: [
				{
					spans: [
						{
							traceId: TRACE_ID,
							spanId: "aaaa1111",
							name: "POST /checkout",
							startTimeUnixNano: 1_700_000_000_000_000_000,
							endTimeUnixNano: 1_700_000_000_500_000_000,
							status: { code: 0 },
							attributes: [],
						},
					],
				},
			],
		},
		{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "orders" } }] },
			scopeSpans: [
				{
					spans: [
						{
							traceId: TRACE_ID,
							spanId: "bbbb2222",
							parentSpanId: "aaaa1111",
							name: "createOrder",
							startTimeUnixNano: 1_700_000_000_100_000_000,
							endTimeUnixNano: 1_700_000_000_400_000_000,
							status: { code: 2, message: "order creation aborted" },
							attributes: [{ key: "otel.status_code", value: { stringValue: "ERROR" } }],
						},
					],
				},
			],
		},
		{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "payments" } }] },
			scopeSpans: [
				{
					spans: [
						{
							traceId: TRACE_ID,
							spanId: "cccc3333",
							parentSpanId: "aaaa1111",
							name: "charge",
							startTimeUnixNano: 1_700_000_000_050_000_000,
							endTimeUnixNano: 1_700_000_000_090_000_000,
							status: { code: 2 },
							attributes: [
								{ key: "exception.message", value: { stringValue: "gateway refused connection" } },
							],
						},
					],
				},
			],
		},
	],
};

/** A read-only fixture backend — no network, no write path. */
function fixtureSource(kind: "jaeger" | "tempo", payload: unknown): TraceSource {
	return {
		kind,
		name: `fixture:${kind}`,
		fetchTrace: async () => payload,
	};
}

describe("backend adapters normalize to one span model", () => {
	test("Jaeger microsecond/tag/reference shape", () => {
		const spans = fromJaeger(JAEGER_PAYLOAD);
		expect(spans.length).toBe(3);
		const charge = spans.find((s) => s.name === "charge")!;
		expect(charge.service).toBe("payments");
		expect(charge.parent_span_id).toBe("aaaa1111");
		expect(charge.status).toBe("error");
		expect(charge.duration_ms).toBe(40);
		expect(charge.messages).toContain("gateway refused connection");
	});

	test("OTLP/Tempo nanosecond/status-code shape", () => {
		const spans = fromTempo(TEMPO_PAYLOAD);
		expect(spans.length).toBe(3);
		const order = spans.find((s) => s.name === "createOrder")!;
		expect(order.service).toBe("orders");
		expect(order.status).toBe("error");
		expect(order.duration_ms).toBe(300);
		expect(order.messages).toContain("order creation aborted");
	});

	test("both backends produce identical normalized spans", () => {
		expect(fromTempo(TEMPO_PAYLOAD)).toEqual(fromJaeger(JAEGER_PAYLOAD));
	});

	test("secrets in span attributes are redacted at ingest", () => {
		const spans = fromJaeger({
			data: [
				{
					traceID: "t1",
					processes: { p1: { serviceName: "svc" } },
					spans: [
						{
							spanID: "s1",
							operationName: "op",
							processID: "p1",
							startTime: 1000,
							duration: 1,
							tags: [
								{
									key: "exception.message",
									value: "auth failed for AKIAIOSFODNN7EXAMPLE",
								},
							],
						},
					],
				},
			],
		});
		expect(spans[0].attributes["exception.message"]).toContain("[REDACTED]");
		expect(JSON.stringify(spans)).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	test("an oversized attribute value is capped", () => {
		const spans = fromJaeger({
			data: [
				{
					traceID: "t1",
					processes: { p1: { serviceName: "svc" } },
					spans: [
						{
							spanID: "s1",
							operationName: "op",
							processID: "p1",
							startTime: 1,
							duration: 1,
							tags: [{ key: "otel.status_description", value: "x".repeat(5000) }],
						},
					],
				},
			],
		});
		expect(spans[0].attributes["otel.status_description"].length).toBeLessThan(300);
	});
});

describe("span-tree normalization", () => {
	test("builds a parent/child tree ordered by start time", () => {
		const roots = buildSpanTree(fromJaeger(JAEGER_PAYLOAD));
		expect(roots.length).toBe(1);
		expect(roots[0].span.name).toBe("POST /checkout");
		expect(roots[0].children.map((c) => c.span.name)).toEqual(["charge", "createOrder"]);
		expect(roots[0].children[0].depth).toBe(1);
	});

	test("a span with a missing parent becomes a root rather than being dropped", () => {
		const spans = fromJaeger(JAEGER_PAYLOAD).filter((s) => s.span_id !== "aaaa1111");
		const roots = buildSpanTree(spans);
		expect(roots.length).toBe(2);
	});
});

describe("bounded queries", () => {
	test("rejects an unbounded or wildcard query before any backend call", async () => {
		expect(guardQuery({ trace_id: "" }).ok).toBe(false);
		expect(guardQuery({ trace_id: "  " }).ok).toBe(false);
		const wildcard = guardQuery({ trace_id: "*" });
		expect(wildcard.ok).toBe(false);
		if (!wildcard.ok) expect(wildcard.reason).toContain("wildcard");

		let fetched = false;
		const source: TraceSource = {
			kind: "jaeger",
			name: "fixture",
			fetchTrace: async () => {
				fetched = true;
				return JAEGER_PAYLOAD;
			},
		};
		const result = await diagnoseTrace(source, { trace_id: "" });
		expect(result.ok).toBe(false);
		expect(fetched).toBe(false);
	});

	test("rejects an over-wide lookback and clamps the span cap", () => {
		const tooWide = guardQuery({ trace_id: TRACE_ID, lookback_ms: MAX_LOOKBACK_MS + 1 });
		expect(tooWide.ok).toBe(false);
		const clamped = guardQuery({ trace_id: TRACE_ID, max_spans: 1_000_000 });
		expect(clamped.ok).toBe(true);
		if (clamped.ok) expect(clamped.query.max_spans).toBe(MAX_SPANS);
	});

	test("truncation is applied and disclosed", async () => {
		const source = fixtureSource("jaeger", JAEGER_PAYLOAD);
		const result = await diagnoseTrace(source, { trace_id: TRACE_ID, max_spans: 2 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.trace_provenance.truncated).toBe(true);
		expect(result.data.trace_provenance.dropped_spans).toBe(1);
		expect(result.data.trace_provenance.span_count).toBe(2);
		expect(result.data.uncertainty.some((u) => u.includes("truncated"))).toBe(true);
	});

	test("a fetch failure and an empty trace return structured errors", async () => {
		const failing: TraceSource = {
			kind: "jaeger",
			name: "fixture",
			fetchTrace: async () => {
				throw new Error("backend unreachable");
			},
		};
		const err = await diagnoseTrace(failing, { trace_id: TRACE_ID });
		expect(err.ok).toBe(false);
		if (!err.ok) expect(err.error.message).toContain("backend unreachable");

		const empty = await diagnoseTrace(fixtureSource("jaeger", { data: [] }), {
			trace_id: TRACE_ID,
		});
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error.message).toContain("No spans found");
	});
});

describe("causal ranking reuse (item 38)", () => {
	test("spans map onto causal nodes and child_of edges", () => {
		const { nodes, edges } = spansToCausalGraph(fromJaeger(JAEGER_PAYLOAD));
		expect(nodes.length).toBe(3);
		expect(nodes.filter((n) => n.status === "failed").length).toBe(2);
		expect(edges.every((e) => e.type === "child_of")).toBe(true);
		// An edge to an unknown parent is never emitted.
		expect(edges.every((e) => nodes.some((n) => n.id === e.to))).toBe(true);
	});

	test("the earliest failing service is ranked as the root cause", async () => {
		const result = await diagnoseTrace(fixtureSource("jaeger", JAEGER_PAYLOAD), {
			trace_id: TRACE_ID,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// `charge` (payments) starts before `createOrder` (orders).
		expect(result.data.summary).toContain("payments:charge");
		expect(result.data.evidence[0].location).toBe("payments:charge");
		expect(result.data.root_cause!.confidence).toBeLessThan(0.85);
	});
});

describe("canonical packet equivalence", () => {
	test("Jaeger and Tempo fixtures yield the same packet apart from provenance", async () => {
		const fromJaegerBackend = await diagnoseTrace(fixtureSource("jaeger", JAEGER_PAYLOAD), {
			trace_id: TRACE_ID,
		});
		const fromTempoBackend = await diagnoseTrace(fixtureSource("tempo", TEMPO_PAYLOAD), {
			trace_id: TRACE_ID,
		});
		expect(fromJaegerBackend.ok && fromTempoBackend.ok).toBe(true);
		if (!fromJaegerBackend.ok || !fromTempoBackend.ok) return;

		const { trace_provenance: jaegerProv, ...jaegerPacket } = fromJaegerBackend.data;
		const { trace_provenance: tempoProv, ...tempoPacket } = fromTempoBackend.data;

		// Byte-identical diagnosis, including the deterministic ids.
		expect(tempoPacket).toEqual(jaegerPacket);
		expect(jaegerPacket.diagnosis_id).toBe(tempoPacket.diagnosis_id);

		// Provenance differs only in the backend identity.
		expect(jaegerProv.backend).toBe("jaeger");
		expect(tempoProv.backend).toBe("tempo");
		expect({ ...jaegerProv, backend: null, source: null }).toEqual({
			...tempoProv,
			backend: null,
			source: null,
		});
	});

	test("the packet satisfies the shared diagnosis contract", async () => {
		const result = await diagnoseTrace(fixtureSource("tempo", TEMPO_PAYLOAD), {
			trace_id: TRACE_ID,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const parsed = FailureDiagnosisSchema.parse(result.data);
		expect(parsed.failure_id).toBe(`trace_${TRACE_ID}`);
		expect(parsed.trace_provenance!.trace_id).toBe(TRACE_ID);
		expect(parsed.evidence.length).toBeGreaterThan(0);
		expect(parsed.suggested_next_actions.length).toBeGreaterThan(0);
	});

	test("a trace with no failing span is reported honestly", () => {
		const packet = diagnoseSpans(
			[
				{
					trace_id: "t",
					span_id: "s1",
					name: "ok",
					service: "svc",
					start_ms: 1,
					duration_ms: 1,
					status: "ok",
					attributes: {},
					messages: [],
				},
			],
			{
				backend: "jaeger",
				source: "fixture",
				trace_id: "t",
				truncated: false,
				dropped_spans: 0,
				max_spans: 500,
			},
		);
		expect(packet.root_cause).toBeUndefined();
		expect(packet.severity).toBe("warning");
		expect(packet.uncertainty.some((u) => u.includes("No span"))).toBe(true);
	});
});
