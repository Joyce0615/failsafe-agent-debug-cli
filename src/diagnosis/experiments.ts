/**
 * Ranked experiment generation by expected information gain per cost
 * (item 74).
 *
 * Item 42 computes expected information gain for a probe that already exists.
 * This module is the other half: given a belief state and a catalogue of things
 * one *could* do, decide what to do next and in what order.
 *
 * The ranking rests on one identity and one refusal.
 *
 * The identity: an experiment is worth running in proportion to how much it
 * would change your mind, not to how likely it is to confirm what you already
 * think. `expectedInformationGain` is the mutual information between the
 * experiment's outcome and the hypothesis — entropy before minus expected
 * entropy after — and an experiment whose outcome distribution is the same
 * under every hypothesis scores exactly zero however cheap it is. That case is
 * detected and named rather than merely ranked last, because "cheapest first"
 * is the default heuristic everywhere and it will happily run twenty free
 * experiments that cannot discriminate.
 *
 * The refusal: **risk is a gate, not a term in the objective.** A destructive
 * experiment with a superb information-to-cost ratio must not outrank a safe
 * one that would also settle the question. Combining them into a single score
 * means there is always some ratio at which restarting the production database
 * is the recommended next step. `rankExperiments` therefore sorts *within* risk
 * tiers and never promotes a riskier experiment above a safe one that clears
 * the discrimination threshold.
 *
 * Pure: no I/O, no execution.
 */

/** Belief over hypotheses. Must be normalized. */
export type Belief = Record<string, number>;

export const RISK_TIERS = ["observational", "reversible", "disruptive", "destructive"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export type Experiment = {
	id: string;
	description: string;
	risk: RiskTier;
	/** Whatever unit the caller budgets in: seconds, tokens, dollars. */
	cost: number;
	/** Outcome labels this experiment can produce. */
	outcomes: string[];
	/**
	 * `likelihoods[hypothesis][outcome]` = P(outcome | hypothesis). Each
	 * hypothesis's row must sum to 1.
	 */
	likelihoods: Record<string, Record<string, number>>;
};

const LOG2 = Math.log(2);

/** Shannon entropy in bits. */
export function entropy(belief: Belief): number {
	let total = 0;
	for (const p of Object.values(belief)) {
		if (p > 0) total -= p * (Math.log(p) / LOG2);
	}
	return total;
}

export function normalize(belief: Belief): Belief {
	const sum = Object.values(belief).reduce((a, b) => a + b, 0);
	if (sum <= 0) {
		const keys = Object.keys(belief);
		const uniform = keys.length > 0 ? 1 / keys.length : 0;
		return Object.fromEntries(keys.map((k) => [k, uniform]));
	}
	return Object.fromEntries(Object.entries(belief).map(([k, v]) => [k, v / sum]));
}

/** Posterior after observing `outcome`. Returns the prior when the outcome is impossible. */
export function updateBelief(
	belief: Belief,
	experiment: Experiment,
	outcome: string,
): { posterior: Belief; impossible: boolean } {
	const unnormalized: Belief = {};
	let total = 0;
	for (const [hypothesis, prior] of Object.entries(belief)) {
		const likelihood = experiment.likelihoods[hypothesis]?.[outcome] ?? 0;
		const mass = prior * likelihood;
		unnormalized[hypothesis] = mass;
		total += mass;
	}
	// An outcome no hypothesis predicts is a fact about the hypothesis set, not
	// about the world. Returning a uniform posterior would silently discard
	// everything already known; returning the prior keeps it and lets the caller
	// notice that the model is incomplete.
	if (total <= 0) return { posterior: { ...belief }, impossible: true };
	return { posterior: normalize(unnormalized), impossible: false };
}

/** Marginal probability of each outcome under the current belief. */
export function outcomeDistribution(
	belief: Belief,
	experiment: Experiment,
): Record<string, number> {
	const marginal: Record<string, number> = {};
	for (const outcome of experiment.outcomes) {
		let p = 0;
		for (const [hypothesis, prior] of Object.entries(belief)) {
			p += prior * (experiment.likelihoods[hypothesis]?.[outcome] ?? 0);
		}
		marginal[outcome] = p;
	}
	return marginal;
}

/**
 * Expected information gain, in bits.
 *
 * Entropy before minus the outcome-weighted entropy after. Zero exactly when
 * the outcome carries no information about the hypothesis — which is the case
 * every "run the cheap checks first" heuristic gets wrong.
 */
export function expectedInformationGain(belief: Belief, experiment: Experiment): number {
	const before = entropy(belief);
	const marginal = outcomeDistribution(belief, experiment);
	let after = 0;
	for (const [outcome, p] of Object.entries(marginal)) {
		if (p <= 0) continue;
		after += p * entropy(updateBelief(belief, experiment, outcome).posterior);
	}
	// Floating-point noise can make this a hair negative; information gain
	// cannot be, and reporting -1e-16 invites a reader to see a distinction.
	return Math.max(0, before - after);
}

export type ValidationIssue = { experiment_id: string; problem: string };

/**
 * Reject experiments whose likelihood model is not a model.
 *
 * A row that does not sum to 1 is not a probability distribution, and every
 * number computed from it — the gain, the ranking, the plan — is arithmetic on
 * something that does not mean what it is labelled.
 */
export function validateExperiment(
	experiment: Experiment,
	hypotheses: string[],
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (experiment.outcomes.length < 2) {
		issues.push({
			experiment_id: experiment.id,
			problem:
				"fewer than two possible outcomes: an experiment with one outcome cannot inform anything",
		});
	}
	if (experiment.cost < 0) {
		issues.push({ experiment_id: experiment.id, problem: "negative cost" });
	}
	for (const hypothesis of hypotheses) {
		const row = experiment.likelihoods[hypothesis];
		if (!row) {
			issues.push({
				experiment_id: experiment.id,
				problem: `no likelihoods for hypothesis '${hypothesis}'; the experiment cannot be scored against it`,
			});
			continue;
		}
		const sum = experiment.outcomes.reduce((a, o) => a + (row[o] ?? 0), 0);
		if (Math.abs(sum - 1) > 1e-6) {
			issues.push({
				experiment_id: experiment.id,
				problem: `likelihoods for '${hypothesis}' sum to ${sum.toFixed(4)}, not 1`,
			});
		}
		if (experiment.outcomes.some((o) => (row[o] ?? 0) < 0)) {
			issues.push({
				experiment_id: experiment.id,
				problem: `negative likelihood for '${hypothesis}'`,
			});
		}
	}
	return issues;
}

/** Gain below which an experiment is treated as unable to discriminate. */
export const DISCRIMINATION_THRESHOLD = 0.05;

export type RankedExperiment = {
	experiment: Experiment;
	expected_bits: number;
	/** Bits per unit cost. `Infinity` for a free experiment that informs. */
	bits_per_cost: number;
	risk: RiskTier;
	/** True when the outcome distribution is the same under every hypothesis. */
	uninformative: boolean;
	/** Why this experiment is where it is. */
	rationale: string;
};

/**
 * Rank a catalogue against a belief.
 *
 * Sorting is lexicographic on (risk tier, bits per cost), never on a blended
 * score. Within a tier the ratio decides; across tiers the safer tier wins
 * outright, so no information-to-cost ratio can promote a destructive
 * experiment above a safe one that also discriminates.
 */
export function rankExperiments(
	belief: Belief,
	experiments: Experiment[],
	opts: { threshold?: number; gain?: (e: Experiment) => number } = {},
): RankedExperiment[] {
	const threshold = opts.threshold ?? DISCRIMINATION_THRESHOLD;
	const normalized = normalize(belief);
	const gainOf = opts.gain ?? ((e: Experiment) => expectedInformationGain(normalized, e));

	const ranked = experiments.map((experiment) => {
		const bits = gainOf(experiment);
		const uninformative = bits < 1e-9;
		const ratio =
			experiment.cost > 0 ? bits / experiment.cost : bits > 0 ? Number.POSITIVE_INFINITY : 0;
		return {
			experiment,
			expected_bits: bits,
			bits_per_cost: ratio,
			risk: experiment.risk,
			uninformative,
			rationale: uninformative
				? "the outcome distribution is identical under every hypothesis: this experiment cannot change any belief, at any price"
				: bits < threshold
					? `expected gain of ${bits.toFixed(3)} bits is below the ${threshold}-bit discrimination threshold`
					: `expected gain of ${bits.toFixed(3)} bits at cost ${experiment.cost} (${ratio === Number.POSITIVE_INFINITY ? "free" : ratio.toFixed(3)} bits/unit), risk tier '${experiment.risk}'`,
		};
	});

	// A safe experiment that clears the threshold outranks every riskier one.
	return ranked.sort((a, b) => {
		const aTier = RISK_TIERS.indexOf(a.risk);
		const bTier = RISK_TIERS.indexOf(b.risk);
		const aSufficient = a.expected_bits >= threshold;
		const bSufficient = b.expected_bits >= threshold;

		// Sufficient experiments always precede insufficient ones.
		if (aSufficient !== bSufficient) return aSufficient ? -1 : 1;
		// Among sufficient ones, the safer tier wins outright.
		if (aSufficient && aTier !== bTier) return aTier - bTier;
		// Otherwise the ratio decides, then the tier, then the id.
		return (
			b.bits_per_cost - a.bits_per_cost ||
			aTier - bTier ||
			a.experiment.id.localeCompare(b.experiment.id)
		);
	});
}

export type PlanStep = {
	experiment: Experiment;
	/** Belief entering this step. */
	prior_entropy: number;
	expected_bits: number;
	cumulative_cost: number;
	/** Expected entropy remaining after this step. */
	expected_posterior_entropy: number;
};

export type ExperimentPlan = {
	steps: PlanStep[];
	total_cost: number;
	expected_total_bits: number;
	/** Entropy expected to remain when the plan is exhausted. */
	expected_residual_entropy: number;
	stop_reason:
		| "budget_exhausted"
		| "no_informative_experiment"
		| "risk_ceiling_reached"
		| "catalogue_exhausted"
		| "resolved";
	caveats: string[];
};

/** Entropy below which the question is treated as settled. */
export const RESOLVED_ENTROPY_BITS = 0.2;
/** Cap on the joint outcome space a plan will enumerate. */
export const MAX_JOINT_OUTCOMES = 4096;

/**
 * Expected information gain of running a *set* of experiments together.
 *
 * Necessary because the average posterior equals the prior — by the law of
 * total expectation — so advancing a belief by its expected posterior between
 * planning steps leaves it exactly where it started and makes every subsequent
 * experiment look as informative as the first. The joint formulation avoids
 * that entirely: the marginal value of adding an experiment is
 * `EIG(S ∪ {e}) − EIG(S)`, which is correctly zero for an experiment that
 * re-measures what the set already determines.
 *
 * Assumes outcomes are conditionally independent given the hypothesis, which is
 * the standard assumption and is stated here because it is not always true: two
 * probes reading the same log line are not independent, and this will overstate
 * their combined value.
 */
export function jointInformationGain(belief: Belief, experiments: Experiment[]): number {
	const prior = normalize(belief);
	if (experiments.length === 0) return 0;

	const space = experiments.reduce((n, e) => n * e.outcomes.length, 1);
	if (space > MAX_JOINT_OUTCOMES) return Number.NaN;

	// Enumerate the joint outcome space.
	let combos: string[][] = [[]];
	for (const experiment of experiments) {
		combos = combos.flatMap((prefix) => experiment.outcomes.map((o) => [...prefix, o]));
	}

	const before = entropy(prior);
	let after = 0;
	for (const combo of combos) {
		const unnormalized: Belief = {};
		let total = 0;
		for (const [hypothesis, p] of Object.entries(prior)) {
			let likelihood = p;
			experiments.forEach((experiment, i) => {
				likelihood *= experiment.likelihoods[hypothesis]?.[combo[i]] ?? 0;
			});
			unnormalized[hypothesis] = likelihood;
			total += likelihood;
		}
		if (total <= 0) continue;
		after += total * entropy(normalize(unnormalized));
	}
	return Math.max(0, before - after);
}

/**
 * Greedily plan a sequence of experiments under a cost budget.
 *
 * Greedy, and said so: choosing the best marginal-gain-per-cost experiment at
 * each step is not in general the optimal sequence, because one experiment can
 * make another far more informative. Finding the optimum requires searching
 * over subsets, which is exponential and — given that the likelihoods are
 * estimates anyway — not obviously worth it. The caveat travels with the plan
 * so nobody reads it as optimal.
 */
export function planSequence(
	belief: Belief,
	experiments: Experiment[],
	budget: number,
	opts: { max_risk?: RiskTier; threshold?: number } = {},
): ExperimentPlan {
	const maxRisk = RISK_TIERS.indexOf(opts.max_risk ?? "reversible");
	const threshold = opts.threshold ?? DISCRIMINATION_THRESHOLD;

	const prior = normalize(belief);
	const priorEntropy = entropy(prior);
	let spent = 0;
	let gainSoFar = 0;
	const chosen: Experiment[] = [];
	const steps: PlanStep[] = [];
	const used = new Set<string>();
	const caveats: string[] = [
		"this plan is greedy: the highest marginal-information-per-cost experiment at each step is not in general the optimal sequence, because one experiment can make another more informative",
	];
	let stop: ExperimentPlan["stop_reason"] = "catalogue_exhausted";

	while (true) {
		if (priorEntropy - gainSoFar <= RESOLVED_ENTROPY_BITS) {
			stop = "resolved";
			break;
		}
		const available = experiments.filter(
			(e) => !used.has(e.id) && RISK_TIERS.indexOf(e.risk) <= maxRisk,
		);
		if (available.length === 0) {
			const blockedByRisk = experiments.some(
				(e) => !used.has(e.id) && RISK_TIERS.indexOf(e.risk) > maxRisk,
			);
			stop = blockedByRisk ? "risk_ceiling_reached" : "catalogue_exhausted";
			break;
		}

		// Marginal gain: what this experiment adds beyond what is already planned.
		const marginalGain = (candidate: Experiment): number => {
			const joint = jointInformationGain(prior, [...chosen, candidate]);
			return Number.isNaN(joint) ? 0 : Math.max(0, joint - gainSoFar);
		};

		const ranked = rankExperiments(prior, available, { threshold, gain: marginalGain });
		const best = ranked.find((r) => r.expected_bits >= threshold);
		if (!best) {
			stop = "no_informative_experiment";
			break;
		}
		if (spent + best.experiment.cost > budget) {
			stop = "budget_exhausted";
			break;
		}

		const entering = priorEntropy - gainSoFar;
		spent += best.experiment.cost;
		gainSoFar += best.expected_bits;
		chosen.push(best.experiment);
		steps.push({
			experiment: best.experiment,
			prior_entropy: entering,
			expected_bits: best.expected_bits,
			cumulative_cost: spent,
			expected_posterior_entropy: Math.max(0, priorEntropy - gainSoFar),
		});
		used.add(best.experiment.id);
	}

	if (stop === "risk_ceiling_reached") {
		caveats.push(
			`experiments above the '${opts.max_risk ?? "reversible"}' risk tier were excluded; the question may be answerable only by one of them`,
		);
	}
	if (stop === "no_informative_experiment" && steps.length === 0) {
		caveats.push(
			"no experiment in the catalogue can discriminate between these hypotheses: the catalogue, not the budget, is the constraint",
		);
	}

	return {
		steps,
		total_cost: spent,
		expected_total_bits: steps.reduce((sum, s) => sum + s.expected_bits, 0),
		expected_residual_entropy: Math.max(0, priorEntropy - gainSoFar),
		stop_reason: stop,
		caveats,
	};
}
