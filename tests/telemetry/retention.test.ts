import { describe, expect, test } from "bun:test";
import {
	DEFAULT_RETENTION_POLICY,
	LatencyWindow,
	REASON_PRIORITY,
	RETENTION_REASONS,
	type RetentionDecision,
	SignatureRegistry,
	TailSampler,
	type TraceSummary,
	applyBudget,
	auditRetention,
	estimatePopulation,
	hashUnit,
} from "../../src/telemetry/retention.js";

function trace(overrides: Partial<TraceSummary> & { trace_id: string }): TraceSummary {
	return {
		operation: "run_tests",
		duration_ms: 100,
		has_error: false,
		has_denial: false,
		span_count: 5,
		bytes: 1000,
		...overrides,
	};
}

describe("deterministic baseline sampling", () => {
	test("the hash is a pure function of the id and lands in [0,1)", () => {
		for (const id of ["a", "trace-1", "x".repeat(64)]) {
			const value = hashUnit(id);
			expect(value).toBe(hashUnit(id));
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	test("different ids spread across the unit interval", () => {
		const values = Array.from({ length: 500 }, (_, i) => hashUnit(`trace-${i}`));
		const below = values.filter((v) => v < 0.5).length;
		expect(below).toBeGreaterThan(150);
		expect(below).toBeLessThan(350);
	});

	test("two samplers reach the same decision for the same trace", () => {
		const a = new TailSampler();
		const b = new TailSampler();
		for (let i = 0; i < 200; i++) {
			const summary = trace({ trace_id: `t${i}` });
			expect(a.observe(summary).keep).toBe(b.observe(summary).keep);
		}
	});

	test("a baseline-sampled trace carries the rate and the reweighting factor", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, baseline_rate: 0.5 });
		const decisions = Array.from({ length: 200 }, (_, i) =>
			sampler.observe(trace({ trace_id: `t${i}` })),
		);
		const sampled = decisions.filter((d) => d.reasons.includes("baseline_sample"));
		expect(sampled.length).toBeGreaterThan(0);
		expect(sampled[0].sampling_rate).toBe(0.5);
		expect(sampled[0].weight).toBe(2);
	});

	test("a deterministically kept trace has rate 1 and weight 1", () => {
		const sampler = new TailSampler();
		const decision = sampler.observe(trace({ trace_id: "t1", has_error: true }));
		expect(decision.sampling_rate).toBe(1);
		expect(decision.weight).toBe(1);
	});
});

describe("the denominator is preserved", () => {
	test("the default baseline rate is nonzero", () => {
		expect(DEFAULT_RETENTION_POLICY.baseline_rate).toBeGreaterThan(0);
	});

	test("weights recover an unbiased population estimate", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, baseline_rate: 0.2 });
		const decisions = Array.from({ length: 1000 }, (_, i) =>
			sampler.observe(trace({ trace_id: `t${i}` })),
		);
		const estimate = estimatePopulation(decisions);
		// Within a reasonable band of the true 1000.
		expect(estimate).toBeGreaterThan(700);
		expect(estimate).toBeLessThan(1300);
	});

	test("a zero baseline rate is called out as making the data unusable", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, baseline_rate: 0 });
		const decisions = Array.from({ length: 50 }, (_, i) =>
			sampler.observe(trace({ trace_id: `t${i}`, has_error: i === 0 })),
		);
		const audit = auditRetention(sampler, decisions);
		expect(audit.caveats.some((c) => c.includes("baseline_rate is zero"))).toBe(true);
		expect(audit.caveats.some((c) => c.includes("not a sample of anything"))).toBe(true);
	});

	test("baseline_sample sits at the bottom of the ladder but is not zero", () => {
		expect(REASON_PRIORITY.baseline_sample).toBeGreaterThan(0);
		for (const reason of RETENTION_REASONS) {
			if (reason === "baseline_sample") continue;
			expect(REASON_PRIORITY[reason]).toBeGreaterThan(REASON_PRIORITY.baseline_sample);
		}
	});
});

describe("errors and denials", () => {
	test("an error is always kept", () => {
		const decision = new TailSampler().observe(trace({ trace_id: "t1", has_error: true }));
		expect(decision.keep).toBe(true);
		expect(decision.reasons).toContain("error");
	});

	test("a denial outranks an error", () => {
		expect(REASON_PRIORITY.denial).toBeGreaterThan(REASON_PRIORITY.error);
		const decision = new TailSampler().observe(
			trace({ trace_id: "t1", has_error: true, has_denial: true }),
		);
		expect(decision.priority).toBe(REASON_PRIORITY.denial);
		expect(decision.reasons).toEqual(expect.arrayContaining(["denial", "error"]));
	});

	test("a trace kept by a rule is not also counted as a baseline sample", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, baseline_rate: 1 });
		const decision = sampler.observe(trace({ trace_id: "t1", has_error: true }));
		expect(decision.reasons).not.toContain("baseline_sample");
		expect(decision.sampling_rate).toBe(1);
	});
});

describe("latency is judged per operation", () => {
	function warm(sampler: TailSampler, operation: string, durations: number[]): void {
		durations.forEach((duration_ms, i) => {
			sampler.observe(trace({ trace_id: `${operation}-warm-${i}`, operation, duration_ms }));
		});
	}

	test("an operation with too few samples is not judged, and says so", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, min_latency_samples: 50 });
		const decision = sampler.observe(trace({ trace_id: "t1", duration_ms: 10 ** 6 }));
		expect(decision.reasons).not.toContain("latency_outlier");
		expect(decision.latency_note).toContain("before a latency threshold means anything");
		expect(sampler.threshold("run_tests")).toBeNull();
	});

	test("a slow trace in a fast operation is an outlier", () => {
		const sampler = new TailSampler({
			...DEFAULT_RETENTION_POLICY,
			min_latency_samples: 20,
			baseline_rate: 0,
		});
		warm(sampler, "cache_read", Array.from({ length: 50 }, () => 5));
		const decision = sampler.observe(
			trace({ trace_id: "slow", operation: "cache_read", duration_ms: 2000 }),
		);
		expect(decision.reasons).toContain("latency_outlier");
	});

	test("the same duration is ordinary in a slow operation", () => {
		const sampler = new TailSampler({
			...DEFAULT_RETENTION_POLICY,
			min_latency_samples: 20,
			baseline_rate: 0,
		});
		warm(
			sampler,
			"repo_scan",
			Array.from({ length: 50 }, (_, i) => 1800 + i * 20),
		);
		const decision = sampler.observe(
			trace({ trace_id: "normal", operation: "repo_scan", duration_ms: 2000 }),
		);
		expect(decision.reasons).not.toContain("latency_outlier");
		expect(decision.keep).toBe(false);
	});

	test("thresholds are independent across operations", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, min_latency_samples: 20 });
		warm(sampler, "fast", Array.from({ length: 30 }, () => 5));
		warm(sampler, "slow", Array.from({ length: 30 }, () => 5000));
		expect(sampler.threshold("fast")!).toBeLessThan(sampler.threshold("slow")!);
	});

	test("the window is bounded and tracks recent behaviour", () => {
		const window = new LatencyWindow(4);
		for (const value of [1, 2, 3, 4, 100, 200]) window.add(value);
		expect(window.size).toBe(4);
		expect(window.quantile(0.5)).toBeGreaterThan(3);
	});

	test("an empty window has no quantile rather than a zero", () => {
		expect(new LatencyWindow(4).quantile(0.99)).toBeNull();
	});

	test("nearest-rank quantiles land on real observations", () => {
		const window = new LatencyWindow(100);
		for (let i = 1; i <= 100; i++) window.add(i);
		expect(window.quantile(1)).toBe(100);
		expect(window.quantile(0.5)).toBe(50);
		expect(window.quantile(0)).toBe(1);
	});
});

describe("novelty detection is bounded and does not double-count", () => {
	test("a signature is novel exactly once", () => {
		const registry = new SignatureRegistry(10);
		expect(registry.firstSight("KeyError")).toBe(true);
		expect(registry.firstSight("KeyError")).toBe(false);
	});

	test("the registry evicts least-recently-seen beyond capacity", () => {
		const registry = new SignatureRegistry(3);
		registry.firstSight("a");
		registry.firstSight("b");
		registry.firstSight("c");
		// Touch `a` so `b` becomes the oldest.
		registry.firstSight("a");
		registry.firstSight("d");
		expect(registry.size).toBe(3);
		expect(registry.has("b")).toBe(false);
		expect(registry.has("a")).toBe(true);
	});

	test("a novel error signature is kept even in a stream of the same error", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, baseline_rate: 0 });
		const first = sampler.observe(
			trace({ trace_id: "t1", has_error: true, error_signature: "KeyError" }),
		);
		const second = sampler.observe(
			trace({ trace_id: "t2", has_error: true, error_signature: "KeyError" }),
		);
		expect(first.reasons).toContain("novel_signature");
		expect(second.reasons).not.toContain("novel_signature");
		// Both are still kept, because both are errors.
		expect(second.keep).toBe(true);
	});

	test("a novel signature on a successful trace is still kept", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, baseline_rate: 0 });
		const decision = sampler.observe(trace({ trace_id: "t1", error_signature: "NewShape" }));
		expect(decision.keep).toBe(true);
		expect(decision.reasons).toEqual(["novel_signature"]);
	});
});

describe("budget pressure sheds by class", () => {
	const sizes = new Map<string, number>();
	function decision(
		trace_id: string,
		reasons: RetentionDecision["reasons"],
		bytes = 100,
	): RetentionDecision {
		sizes.set(trace_id, bytes);
		return {
			trace_id,
			keep: true,
			reasons,
			priority: reasons.reduce((m, r) => Math.max(m, REASON_PRIORITY[r]), 0),
			sampling_rate: 1,
			weight: 1,
		};
	}

	test("baselines are shed before errors", () => {
		const decisions = [
			decision("base1", ["baseline_sample"]),
			decision("err1", ["error"]),
			decision("base2", ["baseline_sample"]),
			decision("deny1", ["denial"]),
		];
		const result = applyBudget(decisions, sizes, 200);
		expect(result.retained.map((d) => d.trace_id).sort()).toEqual(["deny1", "err1"]);
		expect(result.shed_by_reason.baseline_sample).toBe(2);
		expect(result.shed_by_reason.error).toBeUndefined();
	});

	test("a generous budget sheds nothing", () => {
		const decisions = [decision("a", ["error"]), decision("b", ["baseline_sample"])];
		const result = applyBudget(decisions, sizes, 10_000);
		expect(result.evicted).toEqual([]);
		expect(result.over_budget_after_shedding).toBe(false);
	});

	test("shedding into the top class is reported rather than hidden", () => {
		const decisions = [decision("deny1", ["denial"]), decision("deny2", ["denial"])];
		const result = applyBudget(decisions, sizes, 100);
		expect(result.evicted).toHaveLength(1);
		expect(result.over_budget_after_shedding).toBe(true);
		expect(result.shed_by_reason.denial).toBe(1);
	});

	test("a trace shed is attributed to the class that earned its place", () => {
		const decisions = [decision("big", ["denial", "error", "baseline_sample"])];
		const result = applyBudget(decisions, sizes, 0);
		expect(result.shed_by_reason.denial).toBe(1);
		expect(result.shed_by_reason.error).toBeUndefined();
	});

	test("bytes retained and evicted account for everything", () => {
		const decisions = [
			decision("a", ["error"], 60),
			decision("b", ["baseline_sample"], 60),
			decision("c", ["baseline_sample"], 60),
		];
		const result = applyBudget(decisions, sizes, 120);
		expect(result.bytes_retained + result.bytes_evicted).toBe(180);
	});

	test("traces that were not kept never enter the budget", () => {
		const result = applyBudget(
			[{ ...decision("dropped", []), keep: false }],
			sizes,
			10_000,
		);
		expect(result.retained).toEqual([]);
		expect(result.evicted).toEqual([]);
	});
});

describe("the audit", () => {
	test("stats count observations, keeps, and reasons", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, baseline_rate: 0 });
		const decisions = [
			sampler.observe(trace({ trace_id: "a", has_error: true })),
			sampler.observe(trace({ trace_id: "b", has_denial: true })),
			sampler.observe(trace({ trace_id: "c" })),
		];
		const audit = auditRetention(sampler, decisions);
		expect(audit.stats.observed).toBe(3);
		expect(audit.stats.kept).toBe(2);
		expect(audit.stats.by_reason.error).toBe(1);
		expect(audit.stats.by_reason.denial).toBe(1);
		expect(audit.retention_rate).toBeCloseTo(2 / 3, 10);
	});

	test("unjudged operations are named in the caveats", () => {
		const sampler = new TailSampler({ ...DEFAULT_RETENTION_POLICY, min_latency_samples: 1000 });
		const decisions = [sampler.observe(trace({ trace_id: "a", operation: "rare_op" }))];
		const audit = auditRetention(sampler, decisions);
		expect(audit.caveats.some((c) => c.includes("rare_op"))).toBe(true);
		expect(audit.stats.operations_unjudged).toContain("rare_op");
	});

	test("an empty run reports zeros rather than dividing by zero", () => {
		const sampler = new TailSampler();
		const audit = auditRetention(sampler, []);
		expect(audit.retention_rate).toBe(0);
		expect(audit.estimated_population).toBe(0);
		expect(audit.stats.observed).toBe(0);
	});
});
