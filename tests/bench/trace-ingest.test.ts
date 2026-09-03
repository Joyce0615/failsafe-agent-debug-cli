import { describe, expect, test } from "bun:test";
import {
	canonicalWorkloads,
	generateTraceCorpus,
} from "../../src/bench/trace-analytics.js";
import {
	DEFAULT_WATERMARK_LAG_MS,
	WIRE_FORMATS,
	deliver,
	deserializeBatch,
	generateAndIngest,
	ingest,
	knownRowKeys,
	runPipeline,
	serializeRows,
} from "../../src/bench/trace-ingest.js";

const corpus = generateTraceCorpus({ seed: 11, sessions: 5, iterations: 3 });
const KNOWN = knownRowKeys();

const CLEAN_DELIVERY = { duplicate_rate: 0, reorder_rate: 0, corruption_rate: 0 };

describe("serialization round-trips in every wire format", () => {
	test("each format restores every row", () => {
		for (const format of WIRE_FORMATS) {
			const batches = serializeRows(corpus.rows, format, 7);
			const rows = batches.flatMap((b) => deserializeBatch(b, KNOWN).rows);
			expect(rows).toHaveLength(corpus.rows.length);
			expect(new Set(rows.map((r) => r.span_id)).size).toBe(corpus.rows.length);
		}
	});

	test("the columnar format is read by name, not by position", () => {
		const batch = serializeRows(corpus.rows.slice(0, 3), "columnar", 3)[0];
		const { rows } = deserializeBatch(batch, KNOWN);
		expect(rows[0].span_id).toBe(corpus.rows[0].span_id);
		expect(rows[0].tokens_in).toBe(corpus.rows[0].tokens_in);
		expect(rows[0].kind).toBe(corpus.rows[0].kind);
	});

	test("batching partitions rows without losing or repeating any", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 4);
		expect(batches.length).toBe(Math.ceil(corpus.rows.length / 4));
		expect(batches.map((b) => b.sequence)).toEqual(batches.map((_, i) => i));
	});

	test("an empty row set yields no batches", () => {
		expect(serializeRows([], "jsonl", 10)).toEqual([]);
	});
});

describe("malformed input does not take down the stream", () => {
	test("an unparseable batch is one malformed unit, not a throw", () => {
		const result = deserializeBatch(
			{ format: "jsonl", sequence: 0, emitted_ms: 0, payload: "{not json" },
			KNOWN,
		);
		expect(result.malformed).toBe(1);
		expect(result.rows).toEqual([]);
	});

	test("a row without a span id is skipped, not admitted with a blank one", () => {
		const result = deserializeBatch(
			{ format: "jsonl", sequence: 0, emitted_ms: 0, payload: JSON.stringify({ name: "x" }) },
			KNOWN,
		);
		expect(result.malformed).toBe(1);
		expect(result.rows).toEqual([]);
	});

	test("a corrupt batch inside a good stream loses only itself", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 5);
		const delivered = deliver(batches, {
			seed: 3,
			...CLEAN_DELIVERY,
			corruption_rate: 0.3,
		});
		const { report } = ingest(delivered, corpus.rows.length, KNOWN);
		expect(report.malformed_units).toBeGreaterThan(0);
		expect(report.accepted).toBeGreaterThan(0);
		expect(report.completeness).toBeLessThan(1);
	});
});

describe("schema drift is noticed, not rejected", () => {
	test("an unknown key is preserved and reported", () => {
		const row = { ...corpus.rows[0], new_vendor_field: "surprise" };
		const result = deserializeBatch(
			{ format: "jsonl", sequence: 0, emitted_ms: 0, payload: JSON.stringify(row) },
			KNOWN,
		);
		expect(result.rows).toHaveLength(1);
		expect(result.unknown_keys).toEqual(["new_vendor_field"]);
		expect(result.malformed).toBe(0);
	});

	test("drift keys reach the ingest report", () => {
		const batch = serializeRows(
			[{ ...corpus.rows[0], future_key: 1 } as never],
			"jsonl",
			1,
		)[0];
		const { report } = ingest(
			[{ ...batch, arrived_ms: 0, redelivery: false }],
			1,
			KNOWN,
		);
		expect(report.schema_drift_keys).toEqual(["future_key"]);
		expect(report.accepted).toBe(1);
	});

	test("a stream with no drift reports none", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 10);
		const { report } = ingest(
			batches.map((b) => ({ ...b, arrived_ms: b.emitted_ms, redelivery: false })),
			corpus.rows.length,
			KNOWN,
		);
		expect(report.schema_drift_keys).toEqual([]);
	});
});

describe("at-least-once delivery", () => {
	test("redeliveries carry the same payload and sequence, as they do in reality", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 5);
		const delivered = deliver(batches, { seed: 1, ...CLEAN_DELIVERY, duplicate_rate: 1 });
		expect(delivered.length).toBe(batches.length * 2);
		const first = delivered.find((d) => !d.redelivery)!;
		const copy = delivered.find((d) => d.redelivery && d.sequence === first.sequence)!;
		expect(copy.payload).toBe(first.payload);
	});

	test("duplicates are suppressed and counted, never admitted twice", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 5);
		const delivered = deliver(batches, { seed: 1, ...CLEAN_DELIVERY, duplicate_rate: 1 });
		const { rows, report } = ingest(delivered, corpus.rows.length, KNOWN);
		expect(rows).toHaveLength(corpus.rows.length);
		expect(report.accepted).toBe(corpus.rows.length);
		expect(report.duplicates_suppressed).toBe(corpus.rows.length);
		expect(report.received).toBe(corpus.rows.length * 2);
	});

	test("a pipeline with no duplicates is distinguishable from one that absorbs them", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 5);
		const clean = ingest(
			deliver(batches, { seed: 1, ...CLEAN_DELIVERY }),
			corpus.rows.length,
			KNOWN,
		).report;
		const noisy = ingest(
			deliver(batches, { seed: 1, ...CLEAN_DELIVERY, duplicate_rate: 1 }),
			corpus.rows.length,
			KNOWN,
		).report;
		expect(clean.duplicates_suppressed).toBe(0);
		expect(noisy.duplicates_suppressed).toBeGreaterThan(0);
		// And the query-visible state is identical, which is the whole point.
		expect(clean.accepted).toBe(noisy.accepted);
	});

	test("delivery is deterministic from the seed", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 5);
		const noisy = { duplicate_rate: 0.5, reorder_rate: 0.5, delay_ms: 30_000 };
		const a = deliver(batches, { seed: 99, ...noisy });
		const b = deliver(batches, { seed: 99, ...noisy });
		expect(a.map((d) => `${d.sequence}:${d.arrived_ms}:${d.redelivery}`)).toEqual(
			b.map((d) => `${d.sequence}:${d.arrived_ms}:${d.redelivery}`),
		);
		const other = deliver(batches, { seed: 100, ...noisy });
		expect(other.map((d) => `${d.sequence}:${d.redelivery}`)).not.toEqual(
			a.map((d) => `${d.sequence}:${d.redelivery}`),
		);
	});
});

describe("watermarks and completeness", () => {
	test("completeness is measured against what was emitted, not what arrived", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 5);
		// Deliver only half the batches.
		const partial = deliver(batches.slice(0, Math.floor(batches.length / 2)), {
			seed: 2,
			...CLEAN_DELIVERY,
		});
		const { report } = ingest(partial, corpus.rows.length, KNOWN);
		expect(report.received).toBeLessThan(corpus.rows.length);
		expect(report.completeness).toBeLessThan(1);
		expect(report.completeness).toBeCloseTo(report.accepted / report.emitted, 10);
	});

	test("a span far behind the watermark is dropped and counted", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 2);
		const delivered = deliver(batches, {
			seed: 5,
			...CLEAN_DELIVERY,
			reorder_rate: 0.5,
			delay_ms: 10 ** 7,
		});
		const { report } = ingest(delivered, corpus.rows.length, KNOWN, {
			watermark_lag_ms: 1,
		});
		expect(report.dropped_late).toBeGreaterThan(0);
		expect(report.accepted + report.dropped_late).toBe(report.received);
	});

	test("a generous watermark accepts the same late data", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 2);
		const delivered = deliver(batches, {
			seed: 5,
			...CLEAN_DELIVERY,
			reorder_rate: 0.5,
			delay_ms: 10 ** 7,
		});
		const { report } = ingest(delivered, corpus.rows.length, KNOWN, {
			watermark_lag_ms: 10 ** 9,
		});
		expect(report.dropped_late).toBe(0);
		expect(report.completeness).toBe(1);
	});

	test("the default watermark lag is a real number of milliseconds", () => {
		expect(DEFAULT_WATERMARK_LAG_MS).toBeGreaterThan(0);
	});

	test("backpressure drops are counted apart from late drops", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 5);
		const delivered = deliver(batches, { seed: 1, ...CLEAN_DELIVERY });
		const { report } = ingest(delivered, corpus.rows.length, KNOWN, { buffer_rows: 10 });
		expect(report.accepted).toBe(10);
		expect(report.dropped_backpressure).toBe(corpus.rows.length - 10);
		expect(report.dropped_late).toBe(0);
	});

	test("out-of-order batches are counted", () => {
		const batches = serializeRows(corpus.rows, "jsonl", 3);
		const delivered = deliver(batches, {
			seed: 7,
			...CLEAN_DELIVERY,
			reorder_rate: 0.5,
			delay_ms: 50_000,
		});
		const { report } = ingest(delivered, corpus.rows.length, KNOWN, {
			watermark_lag_ms: 10 ** 9,
		});
		expect(report.out_of_order_batches).toBeGreaterThan(0);
	});

	test("an empty stream reports complete rather than dividing by zero", () => {
		const { report } = ingest([], 0, KNOWN);
		expect(report.completeness).toBe(1);
		expect(report.accepted).toBe(0);
	});
});

describe("end-to-end fidelity against the source corpus", () => {
	const workloads = canonicalWorkloads(corpus);

	test("a clean pipeline answers every query exactly as the source does", () => {
		const result = runPipeline(corpus, workloads, {
			delivery: CLEAN_DELIVERY,
			ingest: { watermark_lag_ms: 10 ** 9 },
		});
		expect(result.divergences).toEqual([]);
		expect(result.faithful_workloads).toBe(result.total_workloads);
		expect(result.ingest.completeness).toBe(1);
	});

	test("duplicate delivery does not change a single answer", () => {
		const result = runPipeline(corpus, workloads, {
			delivery: { ...CLEAN_DELIVERY, duplicate_rate: 1 },
			ingest: { watermark_lag_ms: 10 ** 9 },
		});
		expect(result.divergences).toEqual([]);
		expect(result.ingest.duplicates_suppressed).toBeGreaterThan(0);
	});

	test("every wire format produces identical query answers", () => {
		for (const format of WIRE_FORMATS) {
			const result = runPipeline(corpus, workloads, {
				format,
				delivery: CLEAN_DELIVERY,
				ingest: { watermark_lag_ms: 10 ** 9 },
			});
			expect(result.divergences).toEqual([]);
		}
	});

	test("dropped data shows up as missing ids, not as a silent pass", () => {
		const result = runPipeline(corpus, workloads, {
			delivery: CLEAN_DELIVERY,
			ingest: { buffer_rows: 5 },
		});
		expect(result.divergences.length).toBeGreaterThan(0);
		expect(result.divergences.every((d) => d.missing.length > 0)).toBe(true);
		// Losing data can never produce ids the source does not have.
		expect(result.divergences.every((d) => d.extra.length === 0)).toBe(true);
	});

	test("rollup workloads are excluded from the id-set comparison", () => {
		const result = runPipeline(corpus, workloads, {
			delivery: CLEAN_DELIVERY,
			ingest: { watermark_lag_ms: 10 ** 9 },
		});
		expect(result.total_workloads).toBe(workloads.filter((w) => w.kind !== "rollup").length);
	});

	test("the convenience wrapper generates and runs in one call", () => {
		const { corpus: generated, result } = generateAndIngest(3, 2, 2, {
			delivery: CLEAN_DELIVERY,
			ingest: { watermark_lag_ms: 10 ** 9 },
		});
		expect(generated.rows.length).toBeGreaterThan(0);
		expect(result.ingest.completeness).toBe(1);
		expect(result.total_workloads).toBe(0);
	});
});
