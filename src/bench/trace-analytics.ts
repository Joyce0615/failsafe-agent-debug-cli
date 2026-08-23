/**
 * Trace search and analytics at agent-observability scale (item 53).
 *
 * Item 40 gave Failsafe the ability to *read* a trace. That is not the same
 * capability as answering questions over millions of spans, which is what an
 * agent-observability store actually has to do, and which fails in ways a
 * single-trace reader never exposes: a keyword search that quietly stops at
 * 10 000 rows, a session replay that loses ordering when two spans share a
 * millisecond, a token rollup that silently drops a group, an attribute filter
 * on a key nobody declared in advance.
 *
 * This module is the measuring instrument for those five workloads
 * (`keyword | replay | tool_failure_triage | rollup | dynamic_attribute`) and
 * it rests on three commitments:
 *
 * 1. **Reproducible generation.** `generateTraceCorpus` is a pure function of a
 *    seed. Same seed, byte-identical corpus. This is not a convenience: the
 *    ground truth for every workload is computed *by construction* during
 *    generation, so there is no hand-labelling step to disagree with, and a
 *    result can be reproduced from a seed in a bug report instead of a 4 GB
 *    attachment.
 *
 * 2. **Bounded query plans.** `planQuery` returns an explicit plan with an
 *    estimated row scan, and refuses to call a plan bounded when it is not.
 *    Dynamic-attribute filters are the honest case: a key nobody declared in
 *    advance cannot have an index, so those plans are full scans and say so.
 *    A benchmark that lets an unbounded scan pass silently is measuring the
 *    machine it ran on.
 *
 * 3. **Separate axes, no composite.** Set-returning workloads are scored with
 *    precision/recall; replay with ordering; rollups with exactness *and* a
 *    separate count of groups omitted entirely, because a missing group and a
 *    slightly-wrong group are different bugs and averaging them hides the worse
 *    one.
 *
 * Pure: no network, no dataset on disk, no corpus in the repo or a release tar.
 */

/** The span kinds an agent trace contains. */
export const SPAN_KINDS = ["agent", "llm", "tool", "retrieval"] as const;
export type TraceSpanKind = (typeof SPAN_KINDS)[number];

export type AttributeValue = string | number | boolean;

export type TraceRow = {
	session_id: string;
	/** Agent iteration this span belongs to, 0-based. */
	iteration: number;
	span_id: string;
	parent_span_id?: string;
	name: string;
	kind: TraceSpanKind;
	start_ms: number;
	duration_ms: number;
	status: "ok" | "error";
	tool_name?: string;
	error_type?: string;
	tokens_in: number;
	tokens_out: number;
	cost_usd: number;
	/** Free-form, per-row attribute bag: the un-indexable part of the workload. */
	attributes: Record<string, AttributeValue>;
	/** Searchable free text (the message/summary a keyword query hits). */
	text: string;
};

/**
 * Deterministic 32-bit PRNG (mulberry32).
 *
 * Chosen over `Math.random` for the obvious reason and over a crypto PRNG for a
 * less obvious one: the corpus must be reproducible from a seed *across
 * processes and machines*, and a seedable arithmetic generator is the only way
 * to promise that.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export type CorpusOptions = {
	seed: number;
	sessions: number;
	/** Iterations per session; each iteration yields several spans. */
	iterations: number;
	/** Probability a tool call fails. */
	tool_failure_rate?: number;
	/** Keys that appear on only some rows, to exercise sparse attribute filters. */
	dynamic_keys?: string[];
};

export const DEFAULT_CORPUS_OPTIONS: Required<Omit<CorpusOptions, "seed">> = {
	sessions: 20,
	iterations: 5,
	tool_failure_rate: 0.2,
	dynamic_keys: ["retry_of", "cache_hit", "shard", "tenant"],
};

/** Vocabulary the generator draws from, fixed so keyword ground truth is stable. */
const TOOL_NAMES = ["read_file", "run_tests", "search_repo", "apply_patch"] as const;
const ERROR_TYPES = ["timeout", "permission_denied", "rate_limited", "invalid_argument"] as const;
const PHRASES = [
	"connection reset by peer",
	"assertion failed in handler",
	"cache miss on shard",
	"retrying after backoff",
	"schema validation error",
] as const;

export type CorpusGroundTruth = {
	/** term → span ids whose text contains it. */
	keyword: Record<string, string[]>;
	/** session id → span ids in true chronological order. */
	replay: Record<string, string[]>;
	/** tool name → span ids of that tool's failing calls. */
	tool_failures: Record<string, string[]>;
	/** `key=value` → span ids carrying that attribute. */
	dynamic_attributes: Record<string, string[]>;
	/** Exact rollups, computed during generation rather than re-derived. */
	rollups: {
		by_session: Record<string, RollupTotals>;
		by_tool: Record<string, RollupTotals>;
		by_iteration: Record<string, RollupTotals>;
	};
};

export type RollupTotals = {
	spans: number;
	tokens_in: number;
	tokens_out: number;
	cost_usd: number;
	duration_ms: number;
};

function emptyTotals(): RollupTotals {
	return { spans: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, duration_ms: 0 };
}

function addTo(target: Record<string, RollupTotals>, key: string, row: TraceRow): void {
	const totals = (target[key] ??= emptyTotals());
	totals.spans++;
	totals.tokens_in += row.tokens_in;
	totals.tokens_out += row.tokens_out;
	// Rounded at accumulation so a float sum is reproducible regardless of the
	// order a consumer happens to iterate in.
	totals.cost_usd = Math.round((totals.cost_usd + row.cost_usd) * 1e6) / 1e6;
	totals.duration_ms += row.duration_ms;
}

export type TraceCorpus = {
	seed: number;
	rows: TraceRow[];
	ground_truth: CorpusGroundTruth;
};

/**
 * Generate a reproducible agent-trace corpus and its ground truth.
 *
 * Every span gets a start time on a strictly increasing global clock, so
 * `replay` has a single correct answer. That is a deliberate simplification of
 * reality — real traces do collide on a millisecond — but a benchmark whose
 * ground-truth ordering is itself ambiguous cannot distinguish a wrong answer
 * from an unanswerable question. Clock ambiguity is the subject of item 47 and
 * is measured there, not smuggled in here.
 */
export function generateTraceCorpus(options: CorpusOptions): TraceCorpus {
	const opts = { ...DEFAULT_CORPUS_OPTIONS, ...options };
	const rand = mulberry32(opts.seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)];

	const rows: TraceRow[] = [];
	const truth: CorpusGroundTruth = {
		keyword: {},
		replay: {},
		tool_failures: {},
		dynamic_attributes: {},
		rollups: { by_session: {}, by_tool: {}, by_iteration: {} },
	};

	let clock = 1_700_000_000_000;
	let counter = 0;

	for (let s = 0; s < opts.sessions; s++) {
		const sessionId = `sess_${String(s).padStart(4, "0")}`;
		truth.replay[sessionId] = [];

		for (let it = 0; it < opts.iterations; it++) {
			const agentSpanId = `sp_${String(counter++).padStart(6, "0")}`;
			const parents: Array<[TraceSpanKind, string | undefined]> = [
				["agent", undefined],
				["llm", agentSpanId],
				["tool", agentSpanId],
				["retrieval", agentSpanId],
			];

			for (const [kind, parent] of parents) {
				const spanId = kind === "agent" ? agentSpanId : `sp_${String(counter++).padStart(6, "0")}`;
				clock += 1 + Math.floor(rand() * 50);

				const toolName = kind === "tool" ? pick(TOOL_NAMES) : undefined;
				const failed = kind === "tool" && rand() < opts.tool_failure_rate;
				const errorType = failed ? pick(ERROR_TYPES) : undefined;
				const phrase = pick(PHRASES);

				const attributes: Record<string, AttributeValue> = {};
				for (const key of opts.dynamic_keys) {
					// Sparse by design: an attribute present on every row would be
					// indexable, and indexable attributes are not the hard case.
					if (rand() < 0.3) attributes[key] = key === "cache_hit" ? rand() < 0.5 : `v${s % 4}`;
				}

				const row: TraceRow = {
					session_id: sessionId,
					iteration: it,
					span_id: spanId,
					...(parent ? { parent_span_id: parent } : {}),
					name: kind === "tool" ? `execute_tool ${toolName}` : `${kind} step`,
					kind,
					start_ms: clock,
					duration_ms: 1 + Math.floor(rand() * 500),
					status: failed ? "error" : "ok",
					...(toolName ? { tool_name: toolName } : {}),
					...(errorType ? { error_type: errorType } : {}),
					tokens_in: kind === "llm" ? 100 + Math.floor(rand() * 900) : 0,
					tokens_out: kind === "llm" ? 10 + Math.floor(rand() * 300) : 0,
					cost_usd: kind === "llm" ? Math.round(rand() * 1000) / 100000 : 0,
					attributes,
					text: `${kind} ${toolName ?? ""} ${phrase}${errorType ? ` ${errorType}` : ""}`.trim(),
				};
				rows.push(row);

				truth.replay[sessionId].push(spanId);
				for (const term of PHRASES) {
					if (row.text.includes(term)) (truth.keyword[term] ??= []).push(spanId);
				}
				if (failed && toolName) (truth.tool_failures[toolName] ??= []).push(spanId);
				for (const [key, value] of Object.entries(attributes)) {
					(truth.dynamic_attributes[`${key}=${value}`] ??= []).push(spanId);
				}
				addTo(truth.rollups.by_session, sessionId, row);
				addTo(truth.rollups.by_iteration, String(it), row);
				if (toolName) addTo(truth.rollups.by_tool, toolName, row);
			}
		}
	}

	return { seed: opts.seed, rows, ground_truth: truth };
}

export type Workload =
	| { kind: "keyword"; term: string }
	| { kind: "replay"; session_id: string }
	| { kind: "tool_failure_triage"; tool_name: string }
	| { kind: "rollup"; group_by: "session" | "tool" | "iteration" }
	| { kind: "dynamic_attribute"; key: string; value: AttributeValue };

export const WORKLOAD_KINDS = [
	"keyword",
	"replay",
	"tool_failure_triage",
	"rollup",
	"dynamic_attribute",
] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

/**
 * Indexes a store is assumed to maintain.
 *
 * Deliberately short. `attributes` is absent and always will be: the whole
 * point of a dynamic attribute is that nobody declared it in time to index it.
 */
export const AVAILABLE_INDEXES = ["session_id", "tool_name", "status", "text"] as const;
export type IndexName = (typeof AVAILABLE_INDEXES)[number];

export type CorpusStats = {
	rows: number;
	sessions: number;
	/** Rows carrying a tool_name, used to size a tool-index lookup. */
	tool_rows: number;
};

export function corpusStats(corpus: TraceCorpus): CorpusStats {
	return {
		rows: corpus.rows.length,
		sessions: Object.keys(corpus.ground_truth.replay).length,
		tool_rows: corpus.rows.filter((r) => r.tool_name !== undefined).length,
	};
}

/** Ceiling above which a plan is not considered bounded. */
export const MAX_SCANNED_ROWS = 50_000;

export type QueryPlan = {
	workload: WorkloadKind;
	steps: string[];
	index_used: IndexName | null;
	estimated_scanned_rows: number;
	bounded: boolean;
	/** Present exactly when `bounded` is false. */
	unbounded_reason?: string;
};

/**
 * Build the query plan for one workload.
 *
 * The plan is an estimate, not a promise, and `bounded` is computed from the
 * estimate rather than asserted. Two cases are unbounded by construction and
 * say so: a dynamic-attribute filter (no index can exist) and a rollup (every
 * row participates). Reporting those as bounded would be the single easiest way
 * to make this benchmark useless.
 */
export function planQuery(
	workload: Workload,
	stats: CorpusStats,
	maxRows: number = MAX_SCANNED_ROWS,
): QueryPlan {
	const bound = (plan: Omit<QueryPlan, "bounded" | "unbounded_reason">): QueryPlan => {
		if (plan.estimated_scanned_rows <= maxRows) return { ...plan, bounded: true };
		return {
			...plan,
			bounded: false,
			unbounded_reason: `estimated scan of ${plan.estimated_scanned_rows} rows exceeds the ${maxRows}-row ceiling`,
		};
	};

	switch (workload.kind) {
		case "keyword":
			return bound({
				workload: "keyword",
				steps: [`text index lookup '${workload.term}'`, "fetch matching rows"],
				index_used: "text",
				// A text index narrows to the posting list; assume a selective term
				// but never better than a tenth of the corpus.
				estimated_scanned_rows: Math.ceil(stats.rows / 10),
			});
		case "replay":
			return bound({
				workload: "replay",
				steps: [`session_id index lookup '${workload.session_id}'`, "sort by start_ms, span_id"],
				index_used: "session_id",
				estimated_scanned_rows:
					stats.sessions > 0 ? Math.ceil(stats.rows / stats.sessions) : stats.rows,
			});
		case "tool_failure_triage":
			return bound({
				workload: "tool_failure_triage",
				steps: [
					`tool_name index lookup '${workload.tool_name}'`,
					"filter status = error",
					"group by error_type",
				],
				index_used: "tool_name",
				estimated_scanned_rows: stats.tool_rows,
			});
		case "rollup": {
			const plan = {
				workload: "rollup" as const,
				steps: ["full scan", `group by ${workload.group_by}`, "sum tokens, cost, duration"],
				index_used: null,
				estimated_scanned_rows: stats.rows,
			};
			// A rollup touches every row by definition. Calling that "bounded"
			// because the corpus happens to be small today would make the flag
			// mean nothing.
			return stats.rows <= maxRows
				? { ...plan, bounded: true }
				: {
						...plan,
						bounded: false,
						unbounded_reason: "an aggregate over all rows cannot be index-bounded",
					};
		}
		case "dynamic_attribute":
			return {
				workload: "dynamic_attribute",
				steps: ["full scan", `filter attributes['${workload.key}'] = ${String(workload.value)}`],
				index_used: null,
				estimated_scanned_rows: stats.rows,
				bounded: false,
				unbounded_reason:
					"dynamic attributes are not declared in advance and therefore cannot be indexed",
			};
	}
}

/** Reference implementation: what a correct store would return. */
export function executeWorkload(corpus: TraceCorpus, workload: Workload): string[] {
	switch (workload.kind) {
		case "keyword":
			return corpus.rows.filter((r) => r.text.includes(workload.term)).map((r) => r.span_id);
		case "replay":
			return corpus.rows
				.filter((r) => r.session_id === workload.session_id)
				.sort((a, b) => a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id))
				.map((r) => r.span_id);
		case "tool_failure_triage":
			return corpus.rows
				.filter((r) => r.tool_name === workload.tool_name && r.status === "error")
				.map((r) => r.span_id);
		case "dynamic_attribute":
			return corpus.rows
				.filter((r) => r.attributes[workload.key] === workload.value)
				.map((r) => r.span_id);
		case "rollup":
			return [];
	}
}

export type SetScore = {
	precision: number;
	recall: number;
	f1: number;
	returned: number;
	expected: number;
	matched: number;
	/** Ids returned that are not in the corpus at all. */
	fabricated: number;
};

/**
 * Score a set-returning workload.
 *
 * Duplicates in the answer are collapsed before scoring: repeating a hit is not
 * extra evidence, and letting it raise recall would reward a store that pages
 * badly.
 */
export function scoreSet(returned: string[], expected: string[], known: Set<string>): SetScore {
	const got = new Set(returned);
	const want = new Set(expected);
	let matched = 0;
	let fabricated = 0;
	for (const id of got) {
		if (want.has(id)) matched++;
		if (!known.has(id)) fabricated++;
	}
	const precision = got.size > 0 ? matched / got.size : 0;
	const recall = want.size > 0 ? matched / want.size : 1;
	return {
		precision,
		recall,
		f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
		returned: got.size,
		expected: want.size,
		matched,
		fabricated,
	};
}

export type ReplayScore = {
	exact: boolean;
	/** Fraction of the true sequence reproduced before the first divergence. */
	correct_prefix: number;
	/** Fraction of true adjacent pairs kept in the right relative order. */
	order_accuracy: number;
	missing: number;
	extra: number;
};

/**
 * Score a replay.
 *
 * Three numbers, because they fail differently: a store can return the right
 * *set* in the wrong order (`order_accuracy` low, `missing`/`extra` zero), or
 * lose the tail of a session (`correct_prefix` high, `missing` high). Reporting
 * only exact-match would call both of those "wrong" and say nothing else.
 */
export function scoreReplay(returned: string[], expected: string[]): ReplayScore {
	let prefix = 0;
	while (prefix < expected.length && returned[prefix] === expected[prefix]) prefix++;

	const position = new Map(returned.map((id, i) => [id, i]));
	let concordant = 0;
	let comparable = 0;
	for (let i = 0; i + 1 < expected.length; i++) {
		const a = position.get(expected[i]);
		const b = position.get(expected[i + 1]);
		if (a === undefined || b === undefined) continue;
		comparable++;
		if (a < b) concordant++;
	}

	const got = new Set(returned);
	const want = new Set(expected);
	return {
		exact: returned.length === expected.length && prefix === expected.length,
		correct_prefix: expected.length > 0 ? prefix / expected.length : 1,
		order_accuracy: comparable > 0 ? concordant / comparable : 1,
		missing: [...want].filter((id) => !got.has(id)).length,
		extra: [...got].filter((id) => !want.has(id)).length,
	};
}

export type RollupScore = {
	groups_expected: number;
	groups_returned: number;
	/** Groups whose every total matches exactly. */
	groups_exact: number;
	/**
	 * Groups absent from the answer. Counted separately from numeric error: a
	 * silently omitted group is a different and worse bug than a total that is
	 * off by a rounding step, and averaging them together hides it.
	 */
	groups_missing: number;
	/** Groups present in the answer that do not exist. */
	groups_fabricated: number;
	max_relative_error: number;
};

const ROLLUP_FIELDS: Array<keyof RollupTotals> = [
	"spans",
	"tokens_in",
	"tokens_out",
	"cost_usd",
	"duration_ms",
];

/** Tolerance for float equality on the cost field. */
export const ROLLUP_EPSILON = 1e-9;

export function scoreRollup(
	returned: Record<string, RollupTotals>,
	expected: Record<string, RollupTotals>,
): RollupScore {
	let exact = 0;
	let missing = 0;
	let maxRelative = 0;

	for (const [group, want] of Object.entries(expected)) {
		const got = returned[group];
		if (!got) {
			missing++;
			continue;
		}
		let allEqual = true;
		for (const field of ROLLUP_FIELDS) {
			const diff = Math.abs(got[field] - want[field]);
			if (diff > ROLLUP_EPSILON) allEqual = false;
			const denominator = Math.abs(want[field]);
			if (denominator > 0) maxRelative = Math.max(maxRelative, diff / denominator);
			else if (diff > ROLLUP_EPSILON) maxRelative = Number.POSITIVE_INFINITY;
		}
		if (allEqual) exact++;
	}

	const fabricated = Object.keys(returned).filter((g) => expected[g] === undefined).length;
	return {
		groups_expected: Object.keys(expected).length,
		groups_returned: Object.keys(returned).length,
		groups_exact: exact,
		groups_missing: missing,
		groups_fabricated: fabricated,
		max_relative_error: maxRelative,
	};
}

/** Compute a rollup from rows. Used as the reference answer. */
export function computeRollup(
	rows: TraceRow[],
	groupBy: "session" | "tool" | "iteration",
): Record<string, RollupTotals> {
	const out: Record<string, RollupTotals> = {};
	for (const row of rows) {
		const key =
			groupBy === "session"
				? row.session_id
				: groupBy === "iteration"
					? String(row.iteration)
					: row.tool_name;
		if (key === undefined) continue;
		addTo(out, key, row);
	}
	return out;
}

export type WorkloadResult = {
	workload: Workload;
	plan: QueryPlan;
	/** Wall time the store reported for this query. */
	latency_ms: number;
	set?: SetScore;
	replay?: ReplayScore;
	rollup?: RollupScore;
};

export type AnalyticsReport = {
	queries: number;
	by_kind: Array<{
		kind: WorkloadKind;
		queries: number;
		mean_f1: number | null;
		mean_latency_ms: number;
		bounded_rate: number;
	}>;
	plans: {
		bounded: number;
		unbounded: number;
		/** Distinct reasons a plan was unbounded, so the causes are nameable. */
		unbounded_reasons: string[];
		max_estimated_scanned_rows: number;
	};
	/** Aggregate correctness, kept apart from latency by design. */
	correctness: {
		mean_set_f1: number | null;
		exact_replays: number;
		replay_queries: number;
		rollup_groups_missing: number;
		rollup_groups_fabricated: number;
	};
};

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** `null` rather than 0 when a kind has no F1 to report: absent is not zero. */
function meanOrNull(values: number[]): number | null {
	return values.length === 0 ? null : mean(values);
}

export function aggregateAnalytics(results: WorkloadResult[]): AnalyticsReport {
	const unbounded = results.filter((r) => !r.plan.bounded);
	return {
		queries: results.length,
		by_kind: WORKLOAD_KINDS.map((kind) => {
			const subset = results.filter((r) => r.workload.kind === kind);
			return {
				kind,
				queries: subset.length,
				mean_f1: meanOrNull(
					subset.map((r) => r.set?.f1).filter((v): v is number => v !== undefined),
				),
				mean_latency_ms: mean(subset.map((r) => r.latency_ms)),
				bounded_rate: mean(subset.map((r) => (r.plan.bounded ? 1 : 0))),
			};
		}).filter((k) => k.queries > 0),
		plans: {
			bounded: results.length - unbounded.length,
			unbounded: unbounded.length,
			unbounded_reasons: [
				...new Set(unbounded.map((r) => r.plan.unbounded_reason ?? "unspecified")),
			].sort(),
			max_estimated_scanned_rows: results.reduce(
				(a, r) => Math.max(a, r.plan.estimated_scanned_rows),
				0,
			),
		},
		correctness: {
			mean_set_f1: meanOrNull(
				results.map((r) => r.set?.f1).filter((v): v is number => v !== undefined),
			),
			exact_replays: results.filter((r) => r.replay?.exact).length,
			replay_queries: results.filter((r) => r.replay !== undefined).length,
			rollup_groups_missing: results.reduce((a, r) => a + (r.rollup?.groups_missing ?? 0), 0),
			rollup_groups_fabricated: results.reduce((a, r) => a + (r.rollup?.groups_fabricated ?? 0), 0),
		},
	};
}

/**
 * Build the canonical workload set for a corpus.
 *
 * Derived from the corpus's own ground truth, so every query has a non-trivial
 * answer. A query whose true answer is empty measures nothing but whether the
 * store returns nothing, and a suite padded with those looks better than it is.
 */
export function canonicalWorkloads(corpus: TraceCorpus): Workload[] {
	const truth = corpus.ground_truth;
	const workloads: Workload[] = [];

	for (const term of Object.keys(truth.keyword).sort().slice(0, 3)) {
		workloads.push({ kind: "keyword", term });
	}
	for (const sessionId of Object.keys(truth.replay).sort().slice(0, 3)) {
		workloads.push({ kind: "replay", session_id: sessionId });
	}
	for (const tool of Object.keys(truth.tool_failures).sort()) {
		workloads.push({ kind: "tool_failure_triage", tool_name: tool });
	}
	for (const groupBy of ["session", "tool", "iteration"] as const) {
		workloads.push({ kind: "rollup", group_by: groupBy });
	}
	for (const key of Object.keys(truth.dynamic_attributes).sort().slice(0, 3)) {
		const eq = key.indexOf("=");
		const raw = key.slice(eq + 1);
		const value: AttributeValue = raw === "true" ? true : raw === "false" ? false : raw;
		workloads.push({ kind: "dynamic_attribute", key: key.slice(0, eq), value });
	}
	return workloads;
}
