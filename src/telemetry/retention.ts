/**
 * Tail-based retention for rare errors, denials, and anomalous latency
 * (item 65).
 *
 * Head-based sampling decides whether to keep a trace before knowing what is in
 * it, which means the interesting traces are discarded at exactly the same rate
 * as the boring ones. Tail-based sampling decides after the trace completes.
 * That is the easy part. The parts that are usually got wrong:
 *
 * 1. **Keeping only the interesting traces destroys the denominator.** With
 *    100% of errors and 0% of successes retained, you cannot compute an error
 *    rate, compare a latency distribution, or distinguish "this error is new"
 *    from "we started keeping this error last Tuesday". A baseline sample of
 *    ordinary traces is therefore mandatory, not optional, and every retained
 *    trace carries the `sampling_rate` it survived and the `weight` (`1/rate`)
 *    needed to reweight it back into an unbiased aggregate.
 *
 * 2. **A global latency threshold is the wrong instrument.** Two seconds is
 *    routine for a repository scan and catastrophic for a cache read.
 *    Thresholds are per operation, estimated from a bounded reservoir, and an
 *    operation with too few observations is explicitly *not* judged rather than
 *    compared against a number invented from four samples.
 *
 * 3. **Novelty detection needs bounded memory and decay.** An unbounded
 *    "signatures we have seen" set is a slow memory leak, and one that never
 *    forgets will call a signature familiar because it appeared once, months
 *    ago. The registry is capacity-bounded with least-recently-seen eviction.
 *
 * 4. **Budget pressure must shed by class, not uniformly.** Dropping 30% of
 *    everything to fit a budget drops 30% of the errors, which is the one thing
 *    the budget exists to protect. Eviction walks the priority ladder from the
 *    bottom and reports exactly what it shed.
 *
 * Deterministic: baseline sampling hashes the trace id rather than calling a
 * random generator, so replicas agree, reruns reproduce, and a trace is either
 * sampled or not as a property of itself.
 */

/** Why a trace was kept. A trace can qualify under several. */
export const RETENTION_REASONS = [
	"error",
	"denial",
	"latency_outlier",
	"novel_signature",
	"baseline_sample",
] as const;
export type RetentionReason = (typeof RETENTION_REASONS)[number];

/**
 * Priority per reason, highest first. Used only for budget eviction.
 *
 * `baseline_sample` sits at the bottom and is still nonzero, because shedding
 * every baseline trace to fit a budget would leave a retained set of nothing
 * but errors — the exact bias described above, arrived at by accident.
 */
export const REASON_PRIORITY: Record<RetentionReason, number> = {
	denial: 100,
	error: 90,
	novel_signature: 70,
	latency_outlier: 50,
	baseline_sample: 10,
};

export type TraceSummary = {
	trace_id: string;
	/** The operation this trace represents; latency is judged within it. */
	operation: string;
	duration_ms: number;
	has_error: boolean;
	/** Groups errors for novelty: an exception type, a status, a template id. */
	error_signature?: string;
	/** A policy or authorization denial, which is rarer and more interesting than an error. */
	has_denial: boolean;
	span_count: number;
	/** Stored size, used for budgeting. */
	bytes: number;
};

export type RetentionDecision = {
	trace_id: string;
	keep: boolean;
	reasons: RetentionReason[];
	priority: number;
	/**
	 * The probability with which a trace of this kind was retained. `1` for
	 * anything kept by a deterministic rule.
	 */
	sampling_rate: number;
	/** `1 / sampling_rate`: multiply counts by this to recover a population estimate. */
	weight: number;
	/** Present when a latency judgement could not be made. */
	latency_note?: string;
};

/**
 * Deterministic uniform value in [0,1) derived from a trace id.
 *
 * FNV-1a: cheap, well-distributed, and — the point — a pure function of the id,
 * so two collectors seeing the same trace make the same decision and a rerun
 * reproduces the sample exactly.
 */
export function hashUnit(id: string): number {
	let hash = 2166136261;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) / 4294967296;
}

/**
 * Bounded per-operation latency reservoir.
 *
 * Keeps the most recent `capacity` observations. Recency rather than uniform
 * reservoir sampling is deliberate: a threshold should track what the system is
 * doing now, and a uniform sample of all history keeps declaring last quarter's
 * performance normal.
 */
export class LatencyWindow {
	private readonly samples: number[] = [];

	constructor(readonly capacity = 512) {}

	add(value: number): void {
		this.samples.push(value);
		if (this.samples.length > this.capacity) this.samples.shift();
	}

	get size(): number {
		return this.samples.length;
	}

	/** Nearest-rank quantile. `null` when there is nothing to estimate from. */
	quantile(q: number): number | null {
		if (this.samples.length === 0) return null;
		const sorted = [...this.samples].sort((a, b) => a - b);
		const rank = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
		return sorted[Math.max(0, rank)];
	}
}

/**
 * Bounded registry of seen signatures with least-recently-seen eviction.
 *
 * `firstSight` reports whether a signature is new *and* records it, in one
 * call, because splitting the check from the record is how a signature ends up
 * counted as novel twice.
 */
export class SignatureRegistry {
	private readonly seen = new Map<string, number>();
	private clock = 0;

	constructor(readonly capacity = 4096) {}

	get size(): number {
		return this.seen.size;
	}

	firstSight(signature: string): boolean {
		const known = this.seen.has(signature);
		this.seen.set(signature, ++this.clock);
		if (this.seen.size > this.capacity) this.evictOldest();
		return !known;
	}

	has(signature: string): boolean {
		return this.seen.has(signature);
	}

	private evictOldest(): void {
		let oldestKey: string | undefined;
		let oldestClock = Number.POSITIVE_INFINITY;
		for (const [key, at] of this.seen) {
			if (at < oldestClock) {
				oldestClock = at;
				oldestKey = key;
			}
		}
		if (oldestKey !== undefined) this.seen.delete(oldestKey);
	}
}

export type RetentionPolicy = {
	/** Fraction of otherwise-uninteresting traces retained for the denominator. */
	baseline_rate: number;
	/** Quantile above which a duration counts as anomalous, within its operation. */
	latency_quantile: number;
	/** Observations required before an operation's quantile is trusted. */
	min_latency_samples: number;
	/** Capacity of each per-operation latency window. */
	latency_window: number;
	/** Capacity of the novelty registry. */
	signature_capacity: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
	// Nonzero and stated: a baseline of zero is what turns a retention policy
	// into a bias generator.
	baseline_rate: 0.01,
	latency_quantile: 0.99,
	min_latency_samples: 50,
	latency_window: 512,
	signature_capacity: 4096,
};

export type SamplerStats = {
	observed: number;
	kept: number;
	by_reason: Record<RetentionReason, number>;
	operations_tracked: number;
	signatures_tracked: number;
	/** Operations with too few samples to judge latency. */
	operations_unjudged: string[];
};

/**
 * Tail-based sampler.
 *
 * Stateful by necessity — thresholds and novelty are properties of the stream —
 * but every decision is a pure function of the state at that moment plus the
 * trace, so a decision log can be replayed.
 */
export class TailSampler {
	private readonly windows = new Map<string, LatencyWindow>();
	private readonly signatures: SignatureRegistry;
	private observed = 0;
	private kept = 0;
	private readonly byReason: Record<RetentionReason, number> = {
		error: 0,
		denial: 0,
		latency_outlier: 0,
		novel_signature: 0,
		baseline_sample: 0,
	};

	constructor(readonly policy: RetentionPolicy = DEFAULT_RETENTION_POLICY) {
		this.signatures = new SignatureRegistry(policy.signature_capacity);
	}

	/**
	 * Decide on one completed trace.
	 *
	 * Order matters only for the latency window: the observation is recorded
	 * *before* the threshold is read, so a trace is compared against a
	 * distribution that includes itself. The alternative — judge then record —
	 * makes the very first slow trace in a quiet period always an outlier.
	 */
	observe(summary: TraceSummary): RetentionDecision {
		this.observed++;

		const window =
			this.windows.get(summary.operation) ??
			this.windows
				.set(summary.operation, new LatencyWindow(this.policy.latency_window))
				.get(summary.operation)!;
		window.add(summary.duration_ms);

		const reasons: RetentionReason[] = [];
		let latencyNote: string | undefined;

		if (summary.has_denial) reasons.push("denial");
		if (summary.has_error) reasons.push("error");

		if (summary.error_signature && this.signatures.firstSight(summary.error_signature)) {
			reasons.push("novel_signature");
		}

		if (window.size < this.policy.min_latency_samples) {
			latencyNote = `operation '${summary.operation}' has ${window.size} of the ${this.policy.min_latency_samples} samples required before a latency threshold means anything`;
		} else {
			const threshold = window.quantile(this.policy.latency_quantile);
			if (threshold !== null && summary.duration_ms >= threshold) {
				reasons.push("latency_outlier");
			}
		}

		// The baseline draw happens only when nothing else qualified, so the
		// rate means "of the uninteresting traces" and stays interpretable.
		let samplingRate = 1;
		if (reasons.length === 0) {
			if (hashUnit(summary.trace_id) < this.policy.baseline_rate) {
				reasons.push("baseline_sample");
				samplingRate = this.policy.baseline_rate;
			}
		}

		const keep = reasons.length > 0;
		if (keep) {
			this.kept++;
			for (const reason of reasons) this.byReason[reason]++;
		}

		return {
			trace_id: summary.trace_id,
			keep,
			reasons,
			priority: reasons.reduce((max, r) => Math.max(max, REASON_PRIORITY[r]), 0),
			sampling_rate: samplingRate,
			weight: samplingRate > 0 ? 1 / samplingRate : 0,
			...(latencyNote ? { latency_note: latencyNote } : {}),
		};
	}

	stats(): SamplerStats {
		const unjudged: string[] = [];
		for (const [operation, window] of this.windows) {
			if (window.size < this.policy.min_latency_samples) unjudged.push(operation);
		}
		return {
			observed: this.observed,
			kept: this.kept,
			by_reason: { ...this.byReason },
			operations_tracked: this.windows.size,
			signatures_tracked: this.signatures.size,
			operations_unjudged: unjudged.sort(),
		};
	}

	/** Current threshold for an operation, or `null` when it is not yet judged. */
	threshold(operation: string): number | null {
		const window = this.windows.get(operation);
		if (!window || window.size < this.policy.min_latency_samples) return null;
		return window.quantile(this.policy.latency_quantile);
	}
}

export type BudgetResult = {
	retained: RetentionDecision[];
	evicted: RetentionDecision[];
	bytes_retained: number;
	bytes_evicted: number;
	/** How many traces of each reason class were shed, so the loss is nameable. */
	shed_by_reason: Partial<Record<RetentionReason, number>>;
	/** True when even the highest-priority class had to be trimmed. */
	over_budget_after_shedding: boolean;
};

/**
 * Fit the kept set into a byte budget.
 *
 * Eviction walks the priority ladder from the bottom rather than dropping a
 * uniform fraction, because a uniform drop sheds the same proportion of errors
 * as of routine traces — losing precisely what the budget was meant to protect.
 * When even the top class does not fit, that is reported rather than silently
 * truncated, because at that point the budget is the finding.
 */
export function applyBudget(
	decisions: RetentionDecision[],
	sizes: Map<string, number>,
	budgetBytes: number,
): BudgetResult {
	const kept = decisions.filter((d) => d.keep);
	const ordered = [...kept].sort(
		(a, b) => b.priority - a.priority || a.trace_id.localeCompare(b.trace_id),
	);

	const retained: RetentionDecision[] = [];
	const evicted: RetentionDecision[] = [];
	let used = 0;

	for (const decision of ordered) {
		const size = sizes.get(decision.trace_id) ?? 0;
		if (used + size <= budgetBytes) {
			retained.push(decision);
			used += size;
		} else {
			evicted.push(decision);
		}
	}

	const shed: Partial<Record<RetentionReason, number>> = {};
	for (const decision of evicted) {
		// Attribute the loss to the class that earned the trace its place.
		const top = decision.reasons.reduce(
			(best, r) => (REASON_PRIORITY[r] > REASON_PRIORITY[best] ? r : best),
			decision.reasons[0],
		);
		if (top) shed[top] = (shed[top] ?? 0) + 1;
	}

	const topPriority = ordered[0]?.priority ?? 0;
	return {
		retained,
		evicted,
		bytes_retained: used,
		bytes_evicted: evicted.reduce((sum, d) => sum + (sizes.get(d.trace_id) ?? 0), 0),
		shed_by_reason: shed,
		over_budget_after_shedding: evicted.some((d) => d.priority === topPriority),
	};
}

/**
 * Estimate a population count from a retained sample.
 *
 * The reason `weight` exists. A count of retained traces is meaningless on its
 * own once sampling is in play; summing weights recovers an estimate of how
 * many there actually were.
 */
export function estimatePopulation(
	decisions: RetentionDecision[],
	predicate: (d: RetentionDecision) => boolean = () => true,
): number {
	return decisions.filter((d) => d.keep && predicate(d)).reduce((sum, d) => sum + d.weight, 0);
}

export type RetentionAudit = {
	stats: SamplerStats;
	/** Fraction of observed traces retained. */
	retention_rate: number;
	/**
	 * Estimated total traces, recovered from weights. Compare against
	 * `stats.observed` to confirm the reweighting is sound.
	 */
	estimated_population: number;
	caveats: string[];
};

/** Summarize a sampling run, with the failure modes called out. */
export function auditRetention(
	sampler: TailSampler,
	decisions: RetentionDecision[],
): RetentionAudit {
	const stats = sampler.stats();
	const caveats: string[] = [];

	if (sampler.policy.baseline_rate <= 0) {
		caveats.push(
			"baseline_rate is zero: no ordinary traces are retained, so error rates and latency distributions cannot be computed from this data at all",
		);
	}
	if (stats.operations_unjudged.length > 0) {
		caveats.push(
			`latency was not judged for ${stats.operations_unjudged.length} operation(s) with too few samples: ${stats.operations_unjudged.slice(0, 5).join(", ")}`,
		);
	}
	if (stats.by_reason.baseline_sample === 0 && stats.kept > 0) {
		caveats.push(
			"no baseline traces were retained: the kept set is entirely interesting traces and is not a sample of anything",
		);
	}

	return {
		stats,
		retention_rate: stats.observed > 0 ? stats.kept / stats.observed : 0,
		estimated_population: estimatePopulation(decisions),
		caveats,
	};
}
