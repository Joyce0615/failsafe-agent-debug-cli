import { describe, expect, test } from "bun:test";
import {
	AVAILABLE_INDEXES,
	MAX_SCANNED_ROWS,
	type RollupTotals,
	WORKLOAD_KINDS,
	type Workload,
	type WorkloadResult,
	aggregateAnalytics,
	canonicalWorkloads,
	computeRollup,
	corpusStats,
	executeWorkload,
	generateTraceCorpus,
	mulberry32,
	planQuery,
	scoreReplay,
	scoreRollup,
	scoreSet,
} from "../../src/bench/trace-analytics.js";

const corpus = generateTraceCorpus({ seed: 7, sessions: 6, iterations: 4 });
const stats = corpusStats(corpus);
const known = new Set(corpus.rows.map((r) => r.span_id));

describe("reproducible generation", () => {
	test("the same seed yields a byte-identical corpus", () => {
		const a = generateTraceCorpus({ seed: 42, sessions: 3, iterations: 2 });
		const b = generateTraceCorpus({ seed: 42, sessions: 3, iterations: 2 });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	test("a different seed yields a different corpus", () => {
		const a = generateTraceCorpus({ seed: 1, sessions: 3, iterations: 2 });
		const b = generateTraceCorpus({ seed: 2, sessions: 3, iterations: 2 });
		expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
	});

	test("the PRNG is deterministic and stays in [0,1)", () => {
		const first = Array.from({ length: 50 }, mulberry32(9));
		const rand = mulberry32(9);
		for (const value of first) {
			expect(rand()).toBe(value);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	test("span ids are unique and the global clock is strictly increasing", () => {
		expect(known.size).toBe(corpus.rows.length);
		for (let i = 1; i < corpus.rows.length; i++) {
			expect(corpus.rows[i].start_ms).toBeGreaterThan(corpus.rows[i - 1].start_ms);
		}
	});

	test("every row belongs to a declared session and iteration", () => {
		for (const row of corpus.rows) {
			expect(corpus.ground_truth.replay[row.session_id]).toContain(row.span_id);
			expect(row.iteration).toBeLessThan(4);
		}
	});
});

describe("ground truth is computed by construction, not re-derived", () => {
	test("keyword truth matches an independent scan of the rows", () => {
		for (const [term, ids] of Object.entries(corpus.ground_truth.keyword)) {
			expect([...ids].sort()).toEqual([...executeWorkload(corpus, { kind: "keyword", term })].sort());
		}
	});

	test("tool-failure truth matches an independent scan", () => {
		for (const [tool, ids] of Object.entries(corpus.ground_truth.tool_failures)) {
			const scanned = executeWorkload(corpus, { kind: "tool_failure_triage", tool_name: tool });
			expect([...ids].sort()).toEqual([...scanned].sort());
		}
	});

	test("session rollups match an independent aggregation", () => {
		expect(computeRollup(corpus.rows, "session")).toEqual(corpus.ground_truth.rollups.by_session);
		expect(computeRollup(corpus.rows, "tool")).toEqual(corpus.ground_truth.rollups.by_tool);
		expect(computeRollup(corpus.rows, "iteration")).toEqual(
			corpus.ground_truth.rollups.by_iteration,
		);
	});

	test("tool rollups exclude spans with no tool, rather than bucketing them as empty", () => {
		const nonTool = corpus.rows.filter((r) => r.tool_name === undefined).length;
		expect(nonTool).toBeGreaterThan(0);
		expect(Object.keys(corpus.ground_truth.rollups.by_tool)).not.toContain("undefined");
	});

	test("dynamic attributes are sparse, which is what makes them the hard case", () => {
		const withAttrs = corpus.rows.filter((r) => Object.keys(r.attributes).length > 0).length;
		expect(withAttrs).toBeGreaterThan(0);
		expect(withAttrs).toBeLessThan(corpus.rows.length);
	});
});

describe("bounded query plans", () => {
	test("an index-backed lookup is bounded and names its index", () => {
		const plan = planQuery({ kind: "replay", session_id: "sess_0000" }, stats);
		expect(plan.index_used).toBe("session_id");
		expect(plan.bounded).toBe(true);
		expect(plan.unbounded_reason).toBeUndefined();
		expect(plan.estimated_scanned_rows).toBeLessThan(stats.rows);
	});

	test("a dynamic-attribute filter is unbounded by construction, not by size", () => {
		const plan = planQuery({ kind: "dynamic_attribute", key: "shard", value: "v1" }, stats);
		expect(plan.index_used).toBeNull();
		expect(plan.bounded).toBe(false);
		expect(plan.unbounded_reason).toContain("cannot be indexed");
	});

	test("a tiny corpus does not make a dynamic-attribute plan bounded", () => {
		const tiny = corpusStats(generateTraceCorpus({ seed: 1, sessions: 1, iterations: 1 }));
		expect(planQuery({ kind: "dynamic_attribute", key: "shard", value: "v0" }, tiny).bounded).toBe(
			false,
		);
	});

	test("a rollup over a corpus above the ceiling is called unbounded", () => {
		const huge = { rows: MAX_SCANNED_ROWS + 1, sessions: 10, tool_rows: 100 };
		const plan = planQuery({ kind: "rollup", group_by: "session" }, huge);
		expect(plan.bounded).toBe(false);
		expect(plan.unbounded_reason).toContain("cannot be index-bounded");
	});

	test("an index lookup that exceeds the ceiling is reported, not excused", () => {
		const huge = { rows: 10 * MAX_SCANNED_ROWS + 10, sessions: 1, tool_rows: 1 };
		const plan = planQuery({ kind: "keyword", term: "x" }, huge);
		expect(plan.bounded).toBe(false);
		expect(plan.unbounded_reason).toContain("exceeds the");
	});

	test("the ceiling is configurable per call", () => {
		expect(planQuery({ kind: "keyword", term: "x" }, stats, 0).bounded).toBe(false);
		expect(planQuery({ kind: "keyword", term: "x" }, stats, 1e9).bounded).toBe(true);
	});

	test("every plan lists its steps and the attribute index does not exist", () => {
		for (const workload of canonicalWorkloads(corpus)) {
			expect(planQuery(workload, stats).steps.length).toBeGreaterThan(0);
		}
		expect(AVAILABLE_INDEXES as readonly string[]).not.toContain("attributes");
	});
});

describe("set scoring", () => {
	test("a perfect answer scores 1 on both axes", () => {
		const score = scoreSet(["a", "b"], ["a", "b"], new Set(["a", "b"]));
		expect(score.precision).toBe(1);
		expect(score.recall).toBe(1);
		expect(score.f1).toBe(1);
	});

	test("duplicates cannot inflate recall", () => {
		const score = scoreSet(["a", "a", "a"], ["a", "b"], new Set(["a", "b"]));
		expect(score.returned).toBe(1);
		expect(score.recall).toBe(0.5);
		expect(score.precision).toBe(1);
	});

	test("ids that are not in the corpus are counted as fabrication", () => {
		const score = scoreSet(["a", "ghost"], ["a"], new Set(["a", "b"]));
		expect(score.fabricated).toBe(1);
		expect(score.precision).toBe(0.5);
	});

	test("an empty expectation is satisfied by an empty answer", () => {
		const score = scoreSet([], [], new Set());
		expect(score.recall).toBe(1);
		expect(score.precision).toBe(0);
		expect(score.f1).toBe(0);
	});

	test("the reference executor scores perfectly against the ground truth", () => {
		for (const term of Object.keys(corpus.ground_truth.keyword)) {
			const score = scoreSet(
				executeWorkload(corpus, { kind: "keyword", term }),
				corpus.ground_truth.keyword[term],
				known,
			);
			expect(score.f1).toBe(1);
			expect(score.fabricated).toBe(0);
		}
	});
});

describe("replay scoring", () => {
	const truth = ["a", "b", "c", "d"];

	test("an exact replay is exact on all three axes", () => {
		const score = scoreReplay(["a", "b", "c", "d"], truth);
		expect(score.exact).toBe(true);
		expect(score.correct_prefix).toBe(1);
		expect(score.order_accuracy).toBe(1);
		expect(score.missing + score.extra).toBe(0);
	});

	test("the right set in the wrong order loses order accuracy but nothing else", () => {
		const score = scoreReplay(["a", "c", "b", "d"], truth);
		expect(score.exact).toBe(false);
		expect(score.missing).toBe(0);
		expect(score.extra).toBe(0);
		expect(score.order_accuracy).toBeCloseTo(2 / 3, 10);
	});

	test("a truncated replay keeps its prefix credit and reports what it lost", () => {
		const score = scoreReplay(["a", "b"], truth);
		expect(score.correct_prefix).toBe(0.5);
		expect(score.missing).toBe(2);
		expect(score.order_accuracy).toBe(1);
	});

	test("a completely reversed replay scores zero order accuracy", () => {
		expect(scoreReplay(["d", "c", "b", "a"], truth).order_accuracy).toBe(0);
	});

	test("extra spans are counted separately from missing ones", () => {
		const score = scoreReplay(["a", "b", "c", "d", "z"], truth);
		expect(score.extra).toBe(1);
		expect(score.missing).toBe(0);
		expect(score.exact).toBe(false);
	});

	test("an empty truth is trivially satisfied rather than NaN", () => {
		const score = scoreReplay([], []);
		expect(score.correct_prefix).toBe(1);
		expect(score.order_accuracy).toBe(1);
		expect(score.exact).toBe(true);
	});

	test("the reference executor replays every session exactly", () => {
		for (const [sessionId, ids] of Object.entries(corpus.ground_truth.replay)) {
			const score = scoreReplay(
				executeWorkload(corpus, { kind: "replay", session_id: sessionId }),
				ids,
			);
			expect(score.exact).toBe(true);
		}
	});
});

describe("rollup scoring", () => {
	const truth: Record<string, RollupTotals> = {
		a: { spans: 2, tokens_in: 10, tokens_out: 4, cost_usd: 0.5, duration_ms: 100 },
		b: { spans: 1, tokens_in: 5, tokens_out: 1, cost_usd: 0.25, duration_ms: 50 },
	};

	test("an exact rollup scores every group exact with zero error", () => {
		const score = scoreRollup(structuredClone(truth), truth);
		expect(score.groups_exact).toBe(2);
		expect(score.groups_missing).toBe(0);
		expect(score.max_relative_error).toBe(0);
	});

	test("a silently omitted group is counted apart from numeric error", () => {
		const score = scoreRollup({ a: truth.a }, truth);
		expect(score.groups_missing).toBe(1);
		expect(score.groups_exact).toBe(1);
		expect(score.max_relative_error).toBe(0);
	});

	test("an invented group is counted apart from a missing one", () => {
		const score = scoreRollup({ ...structuredClone(truth), z: truth.a }, truth);
		expect(score.groups_fabricated).toBe(1);
		expect(score.groups_missing).toBe(0);
	});

	test("a wrong total costs exactness and shows up as relative error", () => {
		const wrong = structuredClone(truth);
		wrong.a.tokens_in = 11;
		const score = scoreRollup(wrong, truth);
		expect(score.groups_exact).toBe(1);
		expect(score.max_relative_error).toBeCloseTo(0.1, 10);
	});

	test("a nonzero total where zero was expected is infinite relative error", () => {
		const zeroTruth: Record<string, RollupTotals> = {
			a: { spans: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, duration_ms: 0 },
		};
		const score = scoreRollup(
			{ a: { spans: 0, tokens_in: 3, tokens_out: 0, cost_usd: 0, duration_ms: 0 } },
			zeroTruth,
		);
		expect(score.max_relative_error).toBe(Number.POSITIVE_INFINITY);
	});

	test("the reference rollup is exact for every grouping", () => {
		for (const groupBy of ["session", "tool", "iteration"] as const) {
			const score = scoreRollup(
				computeRollup(corpus.rows, groupBy),
				groupBy === "session"
					? corpus.ground_truth.rollups.by_session
					: groupBy === "tool"
						? corpus.ground_truth.rollups.by_tool
						: corpus.ground_truth.rollups.by_iteration,
			);
			expect(score.groups_exact).toBe(score.groups_expected);
			expect(score.groups_missing).toBe(0);
		}
	});
});

describe("canonical workloads and aggregation", () => {
	test("the canonical set covers all five workload kinds", () => {
		const kinds = new Set(canonicalWorkloads(corpus).map((w) => w.kind));
		for (const kind of WORKLOAD_KINDS) expect(kinds.has(kind)).toBe(true);
	});

	test("every canonical set-returning query has a non-empty true answer", () => {
		for (const workload of canonicalWorkloads(corpus)) {
			if (workload.kind === "rollup" || workload.kind === "replay") continue;
			expect(executeWorkload(corpus, workload).length).toBeGreaterThan(0);
		}
	});

	test("boolean dynamic attributes survive the round trip through the truth key", () => {
		const boolQueries = canonicalWorkloads(corpus).filter(
			(w): w is Extract<Workload, { kind: "dynamic_attribute" }> =>
				w.kind === "dynamic_attribute" && typeof w.value === "boolean",
		);
		for (const query of boolQueries) {
			expect(executeWorkload(corpus, query).length).toBeGreaterThan(0);
		}
	});

	test("aggregation separates plan bounding from correctness and latency", () => {
		const results: WorkloadResult[] = canonicalWorkloads(corpus).map((workload) => {
			const plan = planQuery(workload, stats);
			const base = { workload, plan, latency_ms: 10 };
			if (workload.kind === "rollup") {
				return {
					...base,
					rollup: scoreRollup(
						computeRollup(corpus.rows, workload.group_by),
						workload.group_by === "session"
							? corpus.ground_truth.rollups.by_session
							: workload.group_by === "tool"
								? corpus.ground_truth.rollups.by_tool
								: corpus.ground_truth.rollups.by_iteration,
					),
				};
			}
			if (workload.kind === "replay") {
				return {
					...base,
					replay: scoreReplay(
						executeWorkload(corpus, workload),
						corpus.ground_truth.replay[workload.session_id],
					),
				};
			}
			const expected =
				workload.kind === "keyword"
					? corpus.ground_truth.keyword[workload.term]
					: workload.kind === "tool_failure_triage"
						? corpus.ground_truth.tool_failures[workload.tool_name]
						: corpus.ground_truth.dynamic_attributes[
								`${workload.key}=${String(workload.value)}`
							];
			return { ...base, set: scoreSet(executeWorkload(corpus, workload), expected ?? [], known) };
		});

		const report = aggregateAnalytics(results);
		expect(report.queries).toBe(results.length);
		expect(report.correctness.mean_set_f1).toBe(1);
		expect(report.correctness.rollup_groups_missing).toBe(0);
		expect(report.correctness.exact_replays).toBe(report.correctness.replay_queries);
		// Dynamic-attribute queries can never be bounded, so the suite must
		// report unbounded plans even when every answer is perfect.
		expect(report.plans.unbounded).toBeGreaterThan(0);
		expect(report.plans.unbounded_reasons.some((r) => r.includes("cannot be indexed"))).toBe(true);
		const dynamic = report.by_kind.find((k) => k.kind === "dynamic_attribute");
		expect(dynamic?.bounded_rate).toBe(0);
	});

	test("a kind with no F1 to report yields null, not a misleading zero", () => {
		const workload: Workload = { kind: "rollup", group_by: "session" };
		const report = aggregateAnalytics([
			{ workload, plan: planQuery(workload, stats), latency_ms: 1 },
		]);
		expect(report.by_kind[0].mean_f1).toBeNull();
		expect(report.correctness.mean_set_f1).toBeNull();
	});

	test("an empty result set aggregates to zeros rather than NaN", () => {
		const report = aggregateAnalytics([]);
		expect(report.queries).toBe(0);
		expect(report.by_kind).toEqual([]);
		expect(report.plans.max_estimated_scanned_rows).toBe(0);
		expect(report.correctness.mean_set_f1).toBeNull();
	});
});
