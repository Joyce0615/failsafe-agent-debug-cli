/**
 * AgentLogsBench-compatible trace generation, ingestion, and query workloads
 * (item 64).
 *
 * Item 53 measures querying a corpus that is simply *there*. Real observability
 * pipelines never have that corpus; they have a stream that arrives out of
 * order, arrives twice, arrives late, and occasionally arrives with a field
 * nobody has seen before. Every one of those changes the answer to a query, and
 * none of them shows up in a benchmark that hands the store a finished dataset.
 *
 * This module closes the loop: **generate → serialize → ingest → query**, and
 * compares the answers against the same queries run directly on the source
 * corpus. That end-to-end fidelity check is the point. A store can score
 * perfectly on item 53's metrics and still be wrong in production because its
 * ingester counted a redelivery twice.
 *
 * The three hazards it models are the ones that actually bite:
 *
 * 1. **At-least-once delivery means duplicates are expected, not exceptional.**
 *    An ingester that treats a redelivery as a new span inflates every count,
 *    every token total, and every rollup downstream. Deduplication is by span
 *    id and `duplicates_suppressed` is reported, because a pipeline that never
 *    sees duplicates and one that silently absorbs them look identical from the
 *    query side.
 *
 * 2. **A watermark drops late data, and the drop must be counted.** Otherwise
 *    "completeness: 100%" means "100% of what arrived", which is a tautology.
 *    `IngestReport` separates `emitted`, `received`, `accepted`, and `dropped`
 *    so the denominator is never in doubt.
 *
 * 3. **Schema drift is normal.** A new attribute key appears the moment anyone
 *    upgrades a library. Unknown keys are preserved rather than rejected — a
 *    strict ingester turns a routine deploy into an outage — but they are
 *    *counted*, so the drift is visible before it becomes a mystery.
 *
 * Pure and deterministic: no network, no disk, no corpus in the repo.
 */
import {
	type TraceCorpus,
	type TraceRow,
	type Workload,
	executeWorkload,
	generateTraceCorpus,
	mulberry32,
} from "./trace-analytics.js";

/** Wire encodings a producer might use. */
export const WIRE_FORMATS = ["jsonl", "otlp_batch", "columnar"] as const;
export type WireFormat = (typeof WIRE_FORMATS)[number];

export type WireBatch = {
	format: WireFormat;
	/** Sequence number assigned by the producer, for ordering diagnostics. */
	sequence: number;
	/** The producer's clock when the batch was handed to the transport. */
	emitted_ms: number;
	payload: string;
};

/**
 * Serialize rows into batches.
 *
 * `columnar` deliberately drops nothing but reorders fields, so a round-trip
 * through it proves the ingester reads by name rather than by position — the
 * bug that makes a format change silently swap two columns.
 */
export function serializeRows(
	rows: TraceRow[],
	format: WireFormat,
	batchSize: number,
): WireBatch[] {
	const batches: WireBatch[] = [];
	for (let i = 0; i < rows.length; i += batchSize) {
		const chunk = rows.slice(i, i + batchSize);
		const sequence = batches.length;
		const emitted = chunk[0]?.start_ms ?? 0;
		let payload: string;
		switch (format) {
			case "jsonl":
				payload = chunk.map((r) => JSON.stringify(r)).join("\n");
				break;
			case "otlp_batch":
				payload = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: chunk }] }] });
				break;
			case "columnar": {
				// The column set is the *union* over the batch, not the first
				// row's keys. Rows in an agent trace are ragged — an agent span
				// has no `tool_name`, a successful tool call has no `error_type`
				// — and taking the first row's schema silently drops every field
				// it happens not to have, which shows up much later as a query
				// that quietly returns fewer rows than it should.
				const keys = [
					...new Set(chunk.flatMap((r) => Object.keys(r as unknown as Record<string, unknown>))),
				].sort();
				payload = JSON.stringify({
					columns: keys,
					rows: chunk.map((r) => keys.map((k) => (r as unknown as Record<string, unknown>)[k])),
				});
				break;
			}
		}
		batches.push({ format, sequence, emitted_ms: emitted, payload });
	}
	return batches;
}

export type DeserializeResult = { rows: TraceRow[]; unknown_keys: string[]; malformed: number };

/**
 * Parse a batch back into rows.
 *
 * Unknown keys are kept and reported rather than rejected: a strict ingester
 * turns a routine library upgrade into an outage, and the useful response to
 * schema drift is to notice it, not to refuse the data.
 */
export function deserializeBatch(batch: WireBatch, knownKeys: Set<string>): DeserializeResult {
	const rows: TraceRow[] = [];
	const unknown = new Set<string>();
	let malformed = 0;

	const take = (value: unknown): void => {
		if (!value || typeof value !== "object") {
			malformed++;
			return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.span_id !== "string" || record.span_id.length === 0) {
			malformed++;
			return;
		}
		for (const key of Object.keys(record)) {
			if (!knownKeys.has(key)) unknown.add(key);
		}
		rows.push(record as unknown as TraceRow);
	};

	try {
		switch (batch.format) {
			case "jsonl":
				for (const line of batch.payload.split("\n")) {
					if (line.trim().length === 0) continue;
					take(JSON.parse(line));
				}
				break;
			case "otlp_batch": {
				const parsed = JSON.parse(batch.payload) as {
					resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }>;
				};
				for (const resource of parsed.resourceSpans ?? []) {
					for (const scope of resource.scopeSpans ?? []) {
						for (const span of scope.spans ?? []) take(span);
					}
				}
				break;
			}
			case "columnar": {
				const parsed = JSON.parse(batch.payload) as { columns?: string[]; rows?: unknown[][] };
				for (const values of parsed.rows ?? []) {
					const record: Record<string, unknown> = {};
					(parsed.columns ?? []).forEach((key, i) => {
						// A null cell means the row did not have that field, not that
						// it had it set to null; materializing it would turn every
						// agent span into one carrying `tool_name: null`.
						if (values[i] !== null && values[i] !== undefined) record[key] = values[i];
					});
					take(record);
				}
				break;
			}
		}
	} catch {
		// A batch that will not parse at all is one malformed unit, not a crash:
		// an ingester that dies on one bad payload loses the whole stream.
		malformed++;
	}

	return { rows, unknown_keys: [...unknown].sort(), malformed };
}

export type DeliveryOptions = {
	seed: number;
	/** Probability a batch is delivered a second time (at-least-once). */
	duplicate_rate?: number;
	/** Probability a batch is delayed past its neighbours. */
	reorder_rate?: number;
	/** Milliseconds a delayed batch is held. */
	delay_ms?: number;
	/** Probability a batch is corrupted in transit. */
	corruption_rate?: number;
};

export const DEFAULT_DELIVERY: Required<Omit<DeliveryOptions, "seed">> = {
	duplicate_rate: 0.05,
	reorder_rate: 0.1,
	delay_ms: 30_000,
	corruption_rate: 0,
};

export type DeliveredBatch = WireBatch & {
	/** Transport arrival time, which may differ from `emitted_ms`. */
	arrived_ms: number;
	/** True when this is a redelivery of a batch already sent. */
	redelivery: boolean;
};

/**
 * Simulate a transport.
 *
 * Deterministic from the seed, so a failing ingester can be reproduced from two
 * integers rather than a capture file. Duplicates carry the *same* payload and
 * sequence, because that is what at-least-once redelivery actually looks like —
 * a duplicate with a fresh id would be a different and much easier problem.
 */
export function deliver(batches: WireBatch[], options: DeliveryOptions): DeliveredBatch[] {
	const opts = { ...DEFAULT_DELIVERY, ...options };
	const rand = mulberry32(opts.seed);
	const delivered: DeliveredBatch[] = [];

	for (const batch of batches) {
		const delayed = rand() < opts.reorder_rate;
		const arrived = batch.emitted_ms + (delayed ? opts.delay_ms : 0);
		const corrupted = rand() < opts.corruption_rate;
		const payload = corrupted ? `${batch.payload.slice(0, 5)}<<corrupt>>` : batch.payload;

		delivered.push({ ...batch, payload, arrived_ms: arrived, redelivery: false });
		if (rand() < opts.duplicate_rate) {
			delivered.push({ ...batch, payload, arrived_ms: arrived + 1, redelivery: true });
		}
	}

	// The transport hands them over in arrival order, not emission order.
	return delivered.sort((a, b) => a.arrived_ms - b.arrived_ms || a.sequence - b.sequence);
}

export type IngestOptions = {
	/** Data arriving more than this after the newest seen span is dropped. */
	watermark_lag_ms?: number;
	/** Cap on rows held in the ingest buffer before backpressure applies. */
	buffer_rows?: number;
};

export const DEFAULT_WATERMARK_LAG_MS = 10_000;

export type IngestReport = {
	/** Rows the producer created. Known only because we generated them. */
	emitted: number;
	/** Rows the ingester was offered, duplicates included. */
	received: number;
	/** Distinct rows admitted to the store. */
	accepted: number;
	duplicates_suppressed: number;
	/** Dropped for arriving after the watermark had advanced past them. */
	dropped_late: number;
	/** Dropped because the buffer was full. */
	dropped_backpressure: number;
	malformed_units: number;
	/** Attribute keys the ingester had never seen. Kept, not rejected. */
	schema_drift_keys: string[];
	/** Batches that arrived out of producer order. */
	out_of_order_batches: number;
	/** accepted / emitted — the only completeness figure with an honest denominator. */
	completeness: number;
};

/**
 * Ingest delivered batches into a row store.
 *
 * The watermark advances with the newest span *accepted*, and anything more
 * than `watermark_lag_ms` behind it is dropped and counted. Completeness is
 * computed against `emitted`, never against `received`: measuring against what
 * arrived would make a pipeline that loses half its data report 100%.
 */
export function ingest(
	delivered: DeliveredBatch[],
	emitted: number,
	knownKeys: Set<string>,
	options: IngestOptions = {},
): { rows: TraceRow[]; report: IngestReport } {
	const watermarkLag = options.watermark_lag_ms ?? DEFAULT_WATERMARK_LAG_MS;
	const bufferRows = options.buffer_rows ?? Number.POSITIVE_INFINITY;

	const seen = new Set<string>();
	const rows: TraceRow[] = [];
	const drift = new Set<string>();
	let received = 0;
	let duplicates = 0;
	let late = 0;
	let backpressure = 0;
	let malformed = 0;
	let outOfOrder = 0;
	let watermark = Number.NEGATIVE_INFINITY;
	let highestSequence = -1;

	for (const batch of delivered) {
		if (batch.sequence < highestSequence) outOfOrder++;
		highestSequence = Math.max(highestSequence, batch.sequence);

		const parsed = deserializeBatch(batch, knownKeys);
		malformed += parsed.malformed;
		for (const key of parsed.unknown_keys) drift.add(key);

		for (const row of parsed.rows) {
			received++;
			if (seen.has(row.span_id)) {
				duplicates++;
				continue;
			}
			if (watermark !== Number.NEGATIVE_INFINITY && row.start_ms < watermark - watermarkLag) {
				late++;
				continue;
			}
			if (rows.length >= bufferRows) {
				backpressure++;
				continue;
			}
			seen.add(row.span_id);
			rows.push(row);
			watermark = Math.max(watermark, row.start_ms);
		}
	}

	return {
		rows: rows.sort((a, b) => a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id)),
		report: {
			emitted,
			received,
			accepted: rows.length,
			duplicates_suppressed: duplicates,
			dropped_late: late,
			dropped_backpressure: backpressure,
			malformed_units: malformed,
			schema_drift_keys: [...drift].sort(),
			out_of_order_batches: outOfOrder,
			completeness: emitted > 0 ? rows.length / emitted : 1,
		},
	};
}

/** Attribute keys a current ingester knows about. */
export function knownRowKeys(): Set<string> {
	return new Set([
		"session_id",
		"iteration",
		"span_id",
		"parent_span_id",
		"name",
		"kind",
		"start_ms",
		"duration_ms",
		"status",
		"tool_name",
		"error_type",
		"tokens_in",
		"tokens_out",
		"cost_usd",
		"attributes",
		"text",
	]);
}

export type FidelityDivergence = {
	workload: Workload;
	/** Ids the source corpus returns that the ingested store does not. */
	missing: string[];
	/** Ids the ingested store returns that the source does not. */
	extra: string[];
};

export type PipelineResult = {
	ingest: IngestReport;
	divergences: FidelityDivergence[];
	/** Workloads whose answer survived the pipeline unchanged. */
	faithful_workloads: number;
	total_workloads: number;
};

/**
 * Run the whole loop and compare answers.
 *
 * The comparison is against the *source corpus*, not against a second run of
 * the pipeline. Comparing a pipeline to itself proves determinism and nothing
 * about correctness, which is a mistake worth naming because it is easy to make
 * and produces a very reassuring green number.
 */
export function runPipeline(
	corpus: TraceCorpus,
	workloads: Workload[],
	opts: {
		format?: WireFormat;
		batch_size?: number;
		delivery?: Omit<DeliveryOptions, "seed"> & { seed?: number };
		ingest?: IngestOptions;
	} = {},
): PipelineResult {
	const format = opts.format ?? "jsonl";
	const batches = serializeRows(corpus.rows, format, opts.batch_size ?? 50);
	const delivered = deliver(batches, { seed: corpus.seed, ...(opts.delivery ?? {}) });
	const { rows, report } = ingest(delivered, corpus.rows.length, knownRowKeys(), opts.ingest);

	const ingested: TraceCorpus = { ...corpus, rows };
	const divergences: FidelityDivergence[] = [];
	for (const workload of workloads) {
		if (workload.kind === "rollup") continue;
		const expected = new Set(executeWorkload(corpus, workload));
		const actual = new Set(executeWorkload(ingested, workload));
		const missing = [...expected].filter((id) => !actual.has(id)).sort();
		const extra = [...actual].filter((id) => !expected.has(id)).sort();
		if (missing.length > 0 || extra.length > 0) {
			divergences.push({ workload, missing, extra });
		}
	}

	const scored = workloads.filter((w) => w.kind !== "rollup").length;
	return {
		ingest: report,
		divergences,
		faithful_workloads: scored - divergences.length,
		total_workloads: scored,
	};
}

/** Convenience: generate a corpus and immediately run the pipeline over it. */
export function generateAndIngest(
	seed: number,
	sessions: number,
	iterations: number,
	opts: Parameters<typeof runPipeline>[2] = {},
): { corpus: TraceCorpus; result: PipelineResult } {
	const corpus = generateTraceCorpus({ seed, sessions, iterations });
	return { corpus, result: runPipeline(corpus, [], opts) };
}
