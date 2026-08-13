/**
 * Adaptive debugger-action budgets and coarse-to-fine escalation (item 42).
 *
 * A debugging episode is a spend of three scarce resources — actions, tokens,
 * and wall time — against a set of competing hypotheses. This module makes that
 * spend explicit:
 *
 * - **Allocate by hypothesis.** Each hypothesis gets a share of the ceiling
 *   proportional to its prior, with a floor so a plausible alternative is never
 *   starved and a cap so the leader cannot consume everything.
 * - **Escalate coarse-to-fine.** Tiers run `evidence → slice → breakpoint →
 *   step`, cheapest first. The expensive tiers — above all line-level stepping —
 *   are gated on *expected information gain*: a probe that cannot discriminate
 *   between the live hypotheses does not earn the budget it would cost.
 * - **Terminate clearly.** A ledger tracks what has been spent and reports a
 *   single named reason when the episode should stop, so "I ran out" is never
 *   confused with "I found it" or "nothing left to learn".
 *
 * Everything here is pure — no fs, network, process, or clock — so a plan is
 * reproducible and can be asserted on directly in tests.
 */

/**
 * Debugging tiers, cheapest to most expensive.
 *
 * - `evidence`: re-read what the failing run already printed. Free.
 * - `slice`: pull source/test slices around the suspect location.
 * - `breakpoint`: stop once at a location and read state there.
 * - `step`: line-level stepping. Costs an action per line and is the tier that
 *   most often burns a budget without changing anyone's mind.
 */
export const TIER_ORDER = ["evidence", "slice", "breakpoint", "step"] as const;
export type DebugTier = (typeof TIER_ORDER)[number];

/** Rank within {@link TIER_ORDER}; higher is finer-grained and costlier. */
export function tierRank(tier: DebugTier): number {
	return TIER_ORDER.indexOf(tier);
}

/** Indicative cost of one action at each tier, relative to a breakpoint hit. */
export const TIER_COST: Readonly<Record<DebugTier, { actions: number; tokens: number }>> = {
	evidence: { actions: 1, tokens: 200 },
	slice: { actions: 1, tokens: 400 },
	breakpoint: { actions: 2, tokens: 600 },
	step: { actions: 4, tokens: 900 },
};

/** A candidate explanation competing for budget. */
export type BudgetHypothesis = {
	id: string;
	label: string;
	/** Unnormalized prior belief; normalized across the set during allocation. */
	prior: number;
	/** Finest tier this hypothesis could ever need. Defaults to `step`. */
	max_tier?: DebugTier;
};

/** The total an episode may spend. */
export type BudgetCeiling = {
	max_actions: number;
	max_tokens: number;
	max_ms: number;
};

export const DEFAULT_CEILING: BudgetCeiling = {
	max_actions: 24,
	max_tokens: 12000,
	max_ms: 120_000,
};

/**
 * Minimum expected information gain, in bits, required before escalating to a
 * tier above `breakpoint`. 0.15 bits is roughly "this probe shifts a 50/50 to
 * about 60/40" — below that, stepping is not paying for itself.
 */
export const DEFAULT_EIG_THRESHOLD = 0.15;

/** Smallest action share any hypothesis may receive, as a fraction of the ceiling. */
const MIN_SHARE = 0.05;
/** Largest action share any single hypothesis may receive. */
const MAX_SHARE = 0.6;

export type BudgetAllocation = {
	hypothesis_id: string;
	label: string;
	/** Normalized posterior-free prior, after flooring and capping. */
	share: number;
	actions: number;
	tokens: number;
	ms: number;
	/** Finest tier this allocation can reach. */
	max_tier: DebugTier;
};

function normalize(values: number[]): number[] {
	const clamped = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
	const total = clamped.reduce((a, b) => a + b, 0);
	if (total <= 0) return clamped.map(() => 1 / Math.max(1, clamped.length));
	return clamped.map((v) => v / total);
}

/**
 * Project shares into `[floor, cap]` while keeping them summing to 1.
 *
 * Clamping and then renormalizing does not work — renormalizing pushes the
 * leader straight back over the cap. Instead the floor is funded by the shares
 * that have room above it, and the leader's excess is handed to the shares that
 * have headroom below the cap. Both steps are proportional, so the result is a
 * deterministic function of the input.
 */
function floorAndCap(shares: number[]): number[] {
	const n = shares.length;
	if (n === 0) return shares;
	const floor = Math.min(MIN_SHARE, 1 / n);
	const cap = Math.max(MAX_SHARE, 1 / n);
	const out = [...shares];

	// Raise anything under the floor, funded proportionally by the surplus of
	// the shares that sit above it.
	const deficit = out.reduce((a, s) => a + Math.max(0, floor - s), 0);
	if (deficit > 0) {
		const surplus = out.reduce((a, s) => a + Math.max(0, s - floor), 0);
		for (let i = 0; i < n; i++) {
			if (out[i] < floor) out[i] = floor;
			else if (surplus > 0) out[i] -= (deficit * (out[i] - floor)) / surplus;
		}
	}

	// Trim anything over the cap, giving the excess to the shares with headroom.
	const excess = out.reduce((a, s) => a + Math.max(0, s - cap), 0);
	if (excess > 0) {
		const headroom = out.reduce((a, s) => a + Math.max(0, cap - s), 0);
		for (let i = 0; i < n; i++) {
			if (out[i] > cap) out[i] = cap;
			else if (headroom > 0) out[i] += (excess * (cap - out[i])) / headroom;
		}
	}

	const total = out.reduce((a, b) => a + b, 0);
	return total > 0 ? out.map((s) => s / total) : out.map(() => 1 / n);
}

/**
 * Split an integer total across shares using the largest-remainder method, so
 * the parts always sum to exactly `total` and ties break on index rather than
 * on floating-point noise.
 */
function apportion(total: number, shares: number[]): number[] {
	const exact = shares.map((s) => s * total);
	const floors = exact.map(Math.floor);
	let remainder = total - floors.reduce((a, b) => a + b, 0);
	const order = exact
		.map((v, i) => ({ i, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);
	const out = [...floors];
	for (const { i } of order) {
		if (remainder <= 0) break;
		out[i]++;
		remainder--;
	}
	return out;
}

/**
 * Divide a ceiling across competing hypotheses in proportion to their priors.
 *
 * Returns one allocation per hypothesis, in the input order, whose actions and
 * tokens sum to exactly the ceiling.
 */
export function allocateBudget(
	hypotheses: BudgetHypothesis[],
	ceiling: BudgetCeiling = DEFAULT_CEILING,
): BudgetAllocation[] {
	if (hypotheses.length === 0) return [];
	const shares = floorAndCap(normalize(hypotheses.map((h) => h.prior)));
	const actions = apportion(ceiling.max_actions, shares);
	const tokens = apportion(ceiling.max_tokens, shares);
	const ms = apportion(ceiling.max_ms, shares);
	return hypotheses.map((h, i) => ({
		hypothesis_id: h.id,
		label: h.label,
		share: shares[i],
		actions: actions[i],
		tokens: tokens[i],
		ms: ms[i],
		max_tier: h.max_tier ?? "step",
	}));
}

/** Shannon entropy in bits. Zero-probability outcomes contribute nothing. */
export function entropyBits(probabilities: number[]): number {
	let h = 0;
	for (const p of probabilities) {
		if (p > 0) h -= p * Math.log2(p);
	}
	return h;
}

/**
 * Expected information gain, in bits, of a probe over a set of hypotheses.
 *
 * `likelihoods[h][o]` is P(observation `o` | hypothesis `h`). The gain is the
 * prior entropy minus the expected posterior entropy across the probe's
 * possible observations — i.e. how much the probe is expected to sharpen belief.
 * A perfectly discriminating binary probe over two equal hypotheses yields
 * exactly 1 bit; a probe whose observation distribution is identical under
 * every hypothesis yields 0.
 */
export function expectedInformationGain(priors: number[], likelihoods: number[][]): number {
	if (priors.length === 0 || likelihoods.length !== priors.length) return 0;
	const p = normalize(priors);
	const outcomeCount = likelihoods[0]?.length ?? 0;
	if (outcomeCount === 0) return 0;
	// Each row is a distribution over observations; normalize defensively so a
	// caller passing raw weights still gets a meaningful answer.
	const rows = likelihoods.map((row) => normalize(row));

	const prior = entropyBits(p);
	let expectedPosterior = 0;
	for (let o = 0; o < outcomeCount; o++) {
		const joint = p.map((ph, h) => ph * (rows[h][o] ?? 0));
		const pOutcome = joint.reduce((a, b) => a + b, 0);
		if (pOutcome <= 0) continue;
		expectedPosterior += pOutcome * entropyBits(joint.map((j) => j / pOutcome));
	}
	// Clamp: floating-point error can make a zero-gain probe read as -1e-16.
	return Math.max(0, prior - expectedPosterior);
}

export type EscalationDecision = {
	escalate: boolean;
	/** The tier the episode should operate at after this decision. */
	tier: DebugTier;
	reason: string;
	expected_information_gain: number;
	threshold: number;
	/** What the proposed tier would cost. */
	cost: { actions: number; tokens: number };
};

/**
 * Decide whether to move from `from` to `to`.
 *
 * Coarse tiers (up to and including `breakpoint`) only have to be affordable —
 * they are cheap and almost always worth one look. `step` additionally has to
 * clear the information-gain threshold, which is the whole point of the gate:
 * line-level stepping is where a debugging episode goes to die.
 *
 * De-escalation and no-op transitions are always allowed.
 */
export function decideEscalation(input: {
	from: DebugTier;
	to: DebugTier;
	priors: number[];
	likelihoods: number[][];
	remaining: { actions: number; tokens: number };
	threshold?: number;
}): EscalationDecision {
	const threshold = input.threshold ?? DEFAULT_EIG_THRESHOLD;
	const cost = TIER_COST[input.to];
	const eig = expectedInformationGain(input.priors, input.likelihoods);
	const base = { expected_information_gain: eig, threshold, cost };

	if (tierRank(input.to) <= tierRank(input.from)) {
		return { ...base, escalate: true, tier: input.to, reason: "not an escalation" };
	}

	if (input.remaining.actions < cost.actions || input.remaining.tokens < cost.tokens) {
		return {
			...base,
			escalate: false,
			tier: input.from,
			reason: `remaining budget cannot afford '${input.to}' (needs ${cost.actions} actions / ${cost.tokens} tokens)`,
		};
	}

	if (input.to === "step" && eig < threshold) {
		return {
			...base,
			escalate: false,
			tier: input.from,
			reason: `expected information gain ${eig.toFixed(3)} bits is below the ${threshold} bit threshold for line-level stepping`,
		};
	}

	return {
		...base,
		escalate: true,
		tier: input.to,
		reason:
			input.to === "step"
				? `expected information gain ${eig.toFixed(3)} bits clears the ${threshold} bit threshold`
				: `'${input.to}' is affordable and coarser than line-level stepping`,
	};
}

/** Why an episode stopped. Exactly one applies. */
export type TerminationReason =
	| "resolved"
	| "actions_exhausted"
	| "tokens_exhausted"
	| "time_exhausted"
	| "information_gain_below_threshold"
	| "hypotheses_exhausted";

export type BudgetSpend = { actions: number; tokens: number; ms: number };

export type SpendResult = {
	accepted: boolean;
	/** Set when the spend was refused because it would breach the ceiling. */
	refused_reason?: TerminationReason;
	remaining: BudgetSpend;
};

export type BudgetReport = {
	ceiling: BudgetCeiling;
	spent: BudgetSpend;
	remaining: BudgetSpend;
	/** Finest tier actually reached. */
	tier_reached: DebugTier;
	/** Per-hypothesis allocation vs. consumption. */
	hypotheses: Array<{
		hypothesis_id: string;
		label: string;
		allocated_actions: number;
		spent_actions: number;
		spent_tokens: number;
	}>;
	terminated: boolean;
	termination_reason?: TerminationReason;
	/** One sentence an agent can act on without parsing the numbers. */
	summary: string;
};

/**
 * Tracks an episode's spend against its ceiling and per-hypothesis allocations.
 *
 * The ledger refuses a spend that would breach the ceiling rather than allowing
 * an overrun and reporting it afterwards, so the ceiling is a real bound and not
 * a post-hoc observation.
 */
export class DebugBudgetLedger {
	private readonly spentTotal: BudgetSpend = { actions: 0, tokens: 0, ms: 0 };
	private readonly perHypothesis = new Map<string, { actions: number; tokens: number }>();
	private tierReached: DebugTier = "evidence";
	private terminationReason?: TerminationReason;

	constructor(
		private readonly ceiling: BudgetCeiling = DEFAULT_CEILING,
		private readonly allocations: BudgetAllocation[] = [],
	) {
		for (const a of allocations) {
			this.perHypothesis.set(a.hypothesis_id, { actions: 0, tokens: 0 });
		}
	}

	get remaining(): BudgetSpend {
		return {
			actions: this.ceiling.max_actions - this.spentTotal.actions,
			tokens: this.ceiling.max_tokens - this.spentTotal.tokens,
			ms: this.ceiling.max_ms - this.spentTotal.ms,
		};
	}

	get terminated(): boolean {
		return this.terminationReason !== undefined;
	}

	/**
	 * Charge one action at `tier` against `hypothesisId`.
	 *
	 * Refuses (and records the termination reason) if the ceiling cannot cover
	 * it. `ms` is supplied by the caller rather than measured here so the ledger
	 * stays pure and testable.
	 */
	spend(hypothesisId: string, tier: DebugTier, ms = 0): SpendResult {
		if (this.terminated) {
			return { accepted: false, refused_reason: this.terminationReason, remaining: this.remaining };
		}
		const cost = TIER_COST[tier];
		const remaining = this.remaining;

		if (remaining.actions < cost.actions) return this.refuse("actions_exhausted");
		if (remaining.tokens < cost.tokens) return this.refuse("tokens_exhausted");
		if (remaining.ms < ms) return this.refuse("time_exhausted");

		this.spentTotal.actions += cost.actions;
		this.spentTotal.tokens += cost.tokens;
		this.spentTotal.ms += ms;
		if (tierRank(tier) > tierRank(this.tierReached)) this.tierReached = tier;

		const per = this.perHypothesis.get(hypothesisId) ?? { actions: 0, tokens: 0 };
		per.actions += cost.actions;
		per.tokens += cost.tokens;
		this.perHypothesis.set(hypothesisId, per);

		return { accepted: true, remaining: this.remaining };
	}

	private refuse(reason: TerminationReason): SpendResult {
		this.terminationReason = reason;
		return { accepted: false, refused_reason: reason, remaining: this.remaining };
	}

	/** End the episode for a non-budget reason (resolved, nothing left to test). */
	terminate(reason: TerminationReason): void {
		this.terminationReason ??= reason;
	}

	/** Whether `hypothesisId` has already consumed its allocated actions. */
	allocationExhausted(hypothesisId: string): boolean {
		const allocation = this.allocations.find((a) => a.hypothesis_id === hypothesisId);
		if (!allocation) return false;
		return (this.perHypothesis.get(hypothesisId)?.actions ?? 0) >= allocation.actions;
	}

	report(): BudgetReport {
		const reason = this.terminationReason;
		return {
			ceiling: this.ceiling,
			spent: { ...this.spentTotal },
			remaining: this.remaining,
			tier_reached: this.tierReached,
			hypotheses: this.allocations.map((a) => ({
				hypothesis_id: a.hypothesis_id,
				label: a.label,
				allocated_actions: a.actions,
				spent_actions: this.perHypothesis.get(a.hypothesis_id)?.actions ?? 0,
				spent_tokens: this.perHypothesis.get(a.hypothesis_id)?.tokens ?? 0,
			})),
			terminated: this.terminated,
			termination_reason: reason,
			summary: reason ? terminationSummary(reason, this.tierReached) : "budget remaining",
		};
	}
}

/** Plain-language termination message. */
export function terminationSummary(reason: TerminationReason, tier: DebugTier): string {
	switch (reason) {
		case "resolved":
			return `Root cause confirmed at the '${tier}' tier; stopping with budget to spare.`;
		case "actions_exhausted":
			return `Action budget exhausted at the '${tier}' tier. Stop debugging and report the best-supported hypothesis with its evidence — do not keep stepping.`;
		case "tokens_exhausted":
			return `Token budget exhausted at the '${tier}' tier. Stop and summarize; further observations cannot be returned within budget.`;
		case "time_exhausted":
			return `Time budget exhausted at the '${tier}' tier. Stop and report what the episode established so far.`;
		case "information_gain_below_threshold":
			return `No remaining probe is expected to discriminate between the hypotheses. Escalating past '${tier}' would spend budget without changing the conclusion.`;
		case "hypotheses_exhausted":
			return "Every hypothesis has consumed its allocation. Stop and report the best-supported one, or widen the ceiling deliberately.";
	}
}

export type DebugPlanStage = {
	tier: DebugTier;
	hypothesis_id: string;
	/** What this stage is meant to establish. */
	goal: string;
	cost: { actions: number; tokens: number };
	/** Present on gated stages: why the stage is or is not authorized. */
	gate?: EscalationDecision;
};

export type DebugPlan = {
	ceiling: BudgetCeiling;
	allocations: BudgetAllocation[];
	stages: DebugPlanStage[];
	/** Finest tier the plan is authorized to reach. */
	max_authorized_tier: DebugTier;
	/** Set when the plan stops short of `step`. */
	stop_reason?: string;
};

/**
 * Build a coarse-to-fine plan for one hypothesis set.
 *
 * The plan walks the tiers in order for the leading hypothesis, stopping at the
 * first tier that is unaffordable or fails the information-gain gate. Lower
 * hypotheses get a `slice`-tier stage each so an alternative always receives at
 * least one cheap look — the practical form of "allocate by hypothesis".
 */
export function buildDebugPlan(input: {
	hypotheses: BudgetHypothesis[];
	likelihoods?: number[][];
	ceiling?: BudgetCeiling;
	threshold?: number;
}): DebugPlan {
	const ceiling = input.ceiling ?? DEFAULT_CEILING;
	const allocations = allocateBudget(input.hypotheses, ceiling);
	if (allocations.length === 0) {
		return { ceiling, allocations, stages: [], max_authorized_tier: "evidence" };
	}

	const priors = allocations.map((a) => a.share);
	// Absent a caller-supplied probe model, assume the finest tier is only
	// weakly discriminating. This deliberately biases against stepping: an
	// escalation has to be argued for with real likelihoods.
	const likelihoods =
		input.likelihoods ??
		allocations.map((_, i) => allocations.map((__, j) => (i === j ? 0.6 : 0.4)));

	const leader = allocations.reduce((best, a) => (a.share > best.share ? a : best), allocations[0]);
	const stages: DebugPlanStage[] = [];
	let current: DebugTier = "evidence";
	let authorized: DebugTier = "evidence";
	let stopReason: string | undefined;
	let remaining = { actions: leader.actions, tokens: leader.tokens };

	for (const tier of TIER_ORDER) {
		const decision =
			tier === "evidence"
				? undefined
				: decideEscalation({
						from: current,
						to: tier,
						priors,
						likelihoods,
						remaining,
						threshold: input.threshold,
					});
		if (decision && !decision.escalate) {
			stages.push({
				tier,
				hypothesis_id: leader.hypothesis_id,
				goal: tierGoal(tier, leader.label),
				cost: TIER_COST[tier],
				gate: decision,
			});
			stopReason = decision.reason;
			break;
		}
		stages.push({
			tier,
			hypothesis_id: leader.hypothesis_id,
			goal: tierGoal(tier, leader.label),
			cost: TIER_COST[tier],
			...(decision ? { gate: decision } : {}),
		});
		remaining = {
			actions: remaining.actions - TIER_COST[tier].actions,
			tokens: remaining.tokens - TIER_COST[tier].tokens,
		};
		current = tier;
		authorized = tier;
	}

	for (const alt of allocations) {
		if (alt.hypothesis_id === leader.hypothesis_id) continue;
		stages.push({
			tier: "slice",
			hypothesis_id: alt.hypothesis_id,
			goal: tierGoal("slice", alt.label),
			cost: TIER_COST.slice,
		});
	}

	return {
		ceiling,
		allocations,
		stages,
		max_authorized_tier: authorized,
		...(stopReason ? { stop_reason: stopReason } : {}),
	};
}

function tierGoal(tier: DebugTier, label: string): string {
	switch (tier) {
		case "evidence":
			return `Re-read the captured output for evidence for or against: ${label}`;
		case "slice":
			return `Read the source/test slice around the suspect location for: ${label}`;
		case "breakpoint":
			return `Stop once at the suspect location and read state to test: ${label}`;
		case "step":
			return `Step line-by-line to isolate the divergence for: ${label}`;
	}
}
