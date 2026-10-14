/**
 * Adaptive evidence budgets: escalate collection only when expected
 * information gain justifies privacy, storage, and runtime cost (item 10).
 *
 * `debug/budget.ts` (item 42) gates *debugger actions* on expected
 * information gain against a token/action/time ceiling. `experiments.ts`
 * (item 74) ranks a catalogue of *experiments* the same way, with risk as a
 * gate rather than a term in the score. Neither prices the thing evidence
 * *collection itself* spends that a debugger step or an experiment does not:
 * `evidence-adapters.ts` (item 85) and `data-classes.ts` (item 62) both exist
 * because collecting more evidence is not free in the way a debugger
 * breakpoint is free — a heap dump, a full packet capture, or a core file can
 * carry secrets and PII, cost real storage, and take real wall time to
 * gather. Nothing before this module combined "is this collection step worth
 * taking" with "what would it cost in privacy, not just cycles" — a step
 * could clear an information-gain threshold while quietly carrying a secret
 * dump nobody priced.
 *
 * The design mirrors `experiments.ts` deliberately:
 *
 * - **Cost is privacy-plus-resources, not resources alone.** `collectionCost`
 *   adds a per-privacy-class weight (an unredacted secret costs far more than
 *   a count) on top of a storage/runtime cost, so two options of equal byte
 *   size are not treated as equally cheap when one of them is a secret dump.
 * - **The collection tier is a gate, not a term in the objective.** A
 *   `destructive`-tier collection action (e.g. a live core dump) must never
 *   outrank a `summary`-tier one just because its bits-per-cost ratio is
 *   better — `rankEvidenceOptions` sorts within tiers, like
 *   `rankExperiments` sorts within risk tiers, and a tier above the policy's
 *   `max_tier` is refused outright regardless of gain.
 * - **The ceiling is a real, cumulative bound.** `EvidenceBudgetLedger`
 *   refuses a collection that would push cumulative storage or runtime over
 *   the ceiling, the same way `DebugBudgetLedger.spend` refuses an overrun —
 *   a report is produced from what was actually spent, not from what would
 *   have been spent if nothing had been refused.
 *
 * Pure: no fs, network, process, or clock. Callers price storage/runtime by
 * estimate (e.g. the size of a heap dump before writing it), and classify
 * privacy by consulting `data-classes.ts`'s `classifyValue`/`DataClass`
 * vocabulary — this module reuses that vocabulary rather than inventing its
 * own, so a privacy classification made once is priced consistently
 * everywhere it is used.
 */
import type { DataClass } from "../security/data-classes.js";

/**
 * Collection tiers, cheapest/least-invasive to most expensive/most-invasive.
 *
 * - `summary`: already-aggregated facts (counts, exit codes, durations).
 *   What `evidence-adapters.ts` establishes without any extra collection.
 * - `sample`: a bounded sample of something larger (a log tail, one stack
 *   sample, a memory high-water mark).
 * - `detailed`: a full artifact (complete logs, a packet capture, a trace).
 * - `destructive`: collection that disturbs the system under investigation
 *   or captures the most sensitive possible payload (a live core dump, a
 *   full heap snapshot, raw packet contents including application data).
 */
export const EVIDENCE_TIERS = ["summary", "sample", "detailed", "destructive"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** Rank within {@link EVIDENCE_TIERS}; higher is more invasive/expensive. */
export function evidenceTierRank(tier: EvidenceTier): number {
	return EVIDENCE_TIERS.indexOf(tier);
}

/**
 * One thing that could be collected to narrow a diagnosis.
 *
 * Deliberately shaped like `evidence-adapters.ts`'s `next_evidence` entries
 * plus a cost and tier, so a caller can turn `NormalizedEvidence.next_evidence`
 * strings into options here without inventing a new vocabulary.
 */
export type EvidenceCollectionOption = {
	id: string;
	description: string;
	tier: EvidenceTier;
	/** Data classes this collection would carry, per `data-classes.ts`. */
	privacy_classes: DataClass[];
	/** Estimated size of what would be stored, in bytes. */
	storage_bytes: number;
	/** Estimated wall time to collect, in milliseconds. */
	runtime_ms: number;
};

/**
 * Per-privacy-class cost weight, in the same unit as `bits_per_cost`'s
 * denominator.
 *
 * `secret` costs an order of magnitude more than `pii`, which costs more than
 * `tool_payload` and `prompt`: a leaked credential is categorically worse
 * than a leaked order id, and the weights say so rather than treating "has
 * privacy exposure" as a single boolean.
 */
export const DEFAULT_PRIVACY_WEIGHT: Record<DataClass, number> = {
	secret: 10_000,
	pii: 1_000,
	prompt: 200,
	tool_payload: 100,
};

/** Cost contributed by one byte of storage or one millisecond of runtime. */
export const DEFAULT_RESOURCE_WEIGHT = {
	storage_byte: 0.001,
	runtime_ms: 1,
};

/**
 * Total cost of one collection option: privacy weight for every class it
 * carries, plus storage and runtime priced by the resource weights.
 *
 * Sums rather than maxes across privacy classes deliberately — an option that
 * carries both a secret and PII is strictly worse than one that carries only
 * a secret, and a max would hide that.
 */
export function collectionCost(
	option: EvidenceCollectionOption,
	privacyWeight: Record<DataClass, number> = DEFAULT_PRIVACY_WEIGHT,
	resourceWeight: typeof DEFAULT_RESOURCE_WEIGHT = DEFAULT_RESOURCE_WEIGHT,
): number {
	const privacy = option.privacy_classes.reduce((sum, cls) => sum + (privacyWeight[cls] ?? 0), 0);
	const resources =
		option.storage_bytes * resourceWeight.storage_byte +
		option.runtime_ms * resourceWeight.runtime_ms;
	return privacy + resources;
}

/** Gain below which a collection is treated as unable to discriminate. */
export const DEFAULT_DISCRIMINATION_THRESHOLD = 0.05;

export type EvidenceBudgetPolicy = {
	/** Finest tier the budget is authorized to collect at. */
	max_tier: EvidenceTier;
	/** Cumulative storage ceiling, in bytes. */
	max_storage_bytes: number;
	/** Cumulative runtime ceiling, in milliseconds. */
	max_runtime_ms: number;
	/** Expected bits below which a collection does not earn its cost. */
	discrimination_threshold: number;
	privacy_weight: Record<DataClass, number>;
	resource_weight: typeof DEFAULT_RESOURCE_WEIGHT;
};

export const DEFAULT_EVIDENCE_BUDGET_POLICY: EvidenceBudgetPolicy = {
	max_tier: "sample",
	max_storage_bytes: 10 * 1024 * 1024,
	max_runtime_ms: 30_000,
	discrimination_threshold: DEFAULT_DISCRIMINATION_THRESHOLD,
	privacy_weight: DEFAULT_PRIVACY_WEIGHT,
	resource_weight: DEFAULT_RESOURCE_WEIGHT,
};

const LOG2 = Math.log(2);

function entropyBits(probabilities: number[]): number {
	let h = 0;
	for (const p of probabilities) {
		if (p > 0) h -= p * (Math.log(p) / LOG2);
	}
	return h;
}

function normalize(values: number[]): number[] {
	const clamped = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
	const total = clamped.reduce((a, b) => a + b, 0);
	if (total <= 0) return clamped.map(() => 1 / Math.max(1, clamped.length));
	return clamped.map((v) => v / total);
}

/**
 * Expected information gain, in bits, of a collection option over a set of
 * hypotheses.
 *
 * `likelihoods[h][o]` is P(observation `o` | hypothesis `h`). Identical to
 * `debug/budget.ts`'s `expectedInformationGain`, restated here so this module
 * has no dependency on the debugger-action vocabulary — evidence collection
 * happens before a debugging episode exists, not only during one.
 */
export function expectedInformationGain(priors: number[], likelihoods: number[][]): number {
	if (priors.length === 0 || likelihoods.length !== priors.length) return 0;
	const p = normalize(priors);
	const outcomeCount = likelihoods[0]?.length ?? 0;
	if (outcomeCount === 0) return 0;
	const rows = likelihoods.map((row) => normalize(row));

	const prior = entropyBits(p);
	let expectedPosterior = 0;
	for (let o = 0; o < outcomeCount; o++) {
		const joint = p.map((ph, h) => ph * (rows[h][o] ?? 0));
		const pOutcome = joint.reduce((a, b) => a + b, 0);
		if (pOutcome <= 0) continue;
		expectedPosterior += pOutcome * entropyBits(joint.map((j) => j / pOutcome));
	}
	return Math.max(0, prior - expectedPosterior);
}

export type EvidenceBudgetSpend = { storage_bytes: number; runtime_ms: number };

export type EvidenceEscalationDecision = {
	option_id: string;
	escalate: boolean;
	tier: EvidenceTier;
	reason: string;
	expected_information_gain: number;
	cost: number;
	/** Bits per unit cost. `Infinity` for a free option that informs. */
	bits_per_cost: number;
	threshold: number;
};

/**
 * Decide whether one collection option is authorized.
 *
 * Order mirrors `rankExperiments`'/`decideEscalation`'s refusal-first shape:
 * the tier gate and the cumulative ceilings are checked before the
 * information-gain-vs-cost comparison, because an option over the tier or
 * ceiling is refused *regardless* of how informative it would be — tier and
 * ceiling are gates, not inputs to a blended score.
 */
export function decideEvidenceEscalation(input: {
	option: EvidenceCollectionOption;
	priors: number[];
	likelihoods: number[][];
	spent?: EvidenceBudgetSpend;
	policy?: EvidenceBudgetPolicy;
}): EvidenceEscalationDecision {
	const policy = input.policy ?? DEFAULT_EVIDENCE_BUDGET_POLICY;
	const spent = input.spent ?? { storage_bytes: 0, runtime_ms: 0 };
	const { option } = input;
	const eig = expectedInformationGain(input.priors, input.likelihoods);
	const cost = collectionCost(option, policy.privacy_weight, policy.resource_weight);
	const bitsPerCost = cost > 0 ? eig / cost : eig > 0 ? Number.POSITIVE_INFINITY : 0;
	const base = {
		option_id: option.id,
		tier: option.tier,
		expected_information_gain: eig,
		cost,
		bits_per_cost: bitsPerCost,
		threshold: policy.discrimination_threshold,
	};

	if (evidenceTierRank(option.tier) > evidenceTierRank(policy.max_tier)) {
		return {
			...base,
			escalate: false,
			reason: `collection tier '${option.tier}' exceeds the authorized '${policy.max_tier}' ceiling`,
		};
	}

	if (spent.storage_bytes + option.storage_bytes > policy.max_storage_bytes) {
		return {
			...base,
			escalate: false,
			reason: `collecting '${option.id}' would exceed the storage ceiling (${policy.max_storage_bytes} bytes)`,
		};
	}

	if (spent.runtime_ms + option.runtime_ms > policy.max_runtime_ms) {
		return {
			...base,
			escalate: false,
			reason: `collecting '${option.id}' would exceed the runtime ceiling (${policy.max_runtime_ms}ms)`,
		};
	}

	// A collection has to earn, in expected bits, at least the flat
	// discrimination floor *plus* a margin proportional to whatever privacy it
	// would carry. A `privacy_classes: []` option therefore faces exactly the
	// discrimination floor, so this single gate subsumes the item-42-style
	// "does this probe discriminate at all" check and the privacy-aware check
	// at once — a barely-discriminating probe is never authorized merely
	// because it happens to be free of privacy exposure, and a probe carrying
	// a secret is never authorized merely because it clears the flat floor.
	const privacyCost =
		cost -
		option.storage_bytes * policy.resource_weight.storage_byte -
		option.runtime_ms * policy.resource_weight.runtime_ms;
	// Scaled so a `secret` (weight 10,000) requires materially more gain than a
	// trivially-discriminating probe to be worth it.
	const requiredGain = policy.discrimination_threshold + privacyCost / 5_000;
	if (eig < requiredGain) {
		return {
			...base,
			escalate: false,
			reason:
				privacyCost > 0
					? `expected information gain ${eig.toFixed(3)} bits does not justify the privacy cost (${privacyCost.toFixed(0)}) of collecting ${option.privacy_classes.join(", ")}`
					: `expected information gain ${eig.toFixed(3)} bits does not justify collecting '${option.id}': it is below the ${policy.discrimination_threshold}-bit discrimination threshold`,
		};
	}

	return {
		...base,
		escalate: true,
		reason:
			cost === 0
				? `'${option.id}' is free and expected to gain ${eig.toFixed(3)} bits`
				: `expected information gain ${eig.toFixed(3)} bits at cost ${cost.toFixed(2)} (${bitsPerCost === Number.POSITIVE_INFINITY ? "free" : bitsPerCost.toFixed(4)} bits/unit) justifies collecting '${option.id}'`,
	};
}

export type RankedEvidenceOption = EvidenceEscalationDecision;

/**
 * Rank a catalogue of collection options against one belief.
 *
 * Sorted lexicographically on (authorized-first, tier, bits-per-cost), never
 * on a blended score — the same refusal applies as in `experiments.ts`:
 * however good a destructive-tier option's ratio is, it must never outrank
 * an authorized, lower-tier option.
 */
export function rankEvidenceOptions(
	options: EvidenceCollectionOption[],
	priors: number[],
	likelihoods: number[][],
	spent?: EvidenceBudgetSpend,
	policy?: EvidenceBudgetPolicy,
): RankedEvidenceOption[] {
	const decisions = options.map((option) =>
		decideEvidenceEscalation({ option, priors, likelihoods, spent, policy }),
	);
	return decisions.sort((a, b) => {
		if (a.escalate !== b.escalate) return a.escalate ? -1 : 1;
		const aTier = evidenceTierRank(a.tier);
		const bTier = evidenceTierRank(b.tier);
		if (a.escalate && aTier !== bTier) return aTier - bTier;
		return (
			b.bits_per_cost - a.bits_per_cost || aTier - bTier || a.option_id.localeCompare(b.option_id)
		);
	});
}

export type EvidenceBudgetReport = {
	policy: EvidenceBudgetPolicy;
	spent: EvidenceBudgetSpend;
	decisions: EvidenceEscalationDecision[];
	authorized_count: number;
	refused_count: number;
};

/**
 * Tracks cumulative collection spend against a policy ceiling.
 *
 * Mirrors `debug/budget.ts`'s `DebugBudgetLedger`: a refused collection is
 * never charged, so the ceiling is a real bound on what is actually
 * collected rather than a post-hoc observation about what was attempted.
 */
export class EvidenceBudgetLedger {
	private readonly spentTotal: EvidenceBudgetSpend = { storage_bytes: 0, runtime_ms: 0 };
	private readonly decisions: EvidenceEscalationDecision[] = [];

	constructor(private readonly policy: EvidenceBudgetPolicy = DEFAULT_EVIDENCE_BUDGET_POLICY) {}

	get spent(): EvidenceBudgetSpend {
		return { ...this.spentTotal };
	}

	/**
	 * Decide on, and if authorized charge, one collection option against the
	 * running total.
	 */
	consider(
		option: EvidenceCollectionOption,
		priors: number[],
		likelihoods: number[][],
	): EvidenceEscalationDecision {
		const decision = decideEvidenceEscalation({
			option,
			priors,
			likelihoods,
			spent: this.spentTotal,
			policy: this.policy,
		});
		this.decisions.push(decision);
		if (decision.escalate) {
			this.spentTotal.storage_bytes += option.storage_bytes;
			this.spentTotal.runtime_ms += option.runtime_ms;
		}
		return decision;
	}

	report(): EvidenceBudgetReport {
		return {
			policy: this.policy,
			spent: this.spent,
			decisions: [...this.decisions],
			authorized_count: this.decisions.filter((d) => d.escalate).length,
			refused_count: this.decisions.filter((d) => !d.escalate).length,
		};
	}
}
