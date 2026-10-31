/**
 * Hypothesis-driven differential diagnosis (item 26).
 *
 * The three pieces this item asks for already exist, separately: item 43's
 * `hypothesis.ts` tracks a tree of competing causes with Bayesian posteriors;
 * item 74's `experiments.ts` ranks and greedily plans experiments by expected
 * information gain under a cost budget and a risk ceiling; item 75's
 * `stopping.ts` decides when an investigation has answered its question,
 * exhausted a resource, or is blocked by policy — and crucially distinguishes
 * all three. None of them talk to each other: a hypothesis tree has no
 * concept of "which experiment to run next", and the stopping policy has no
 * concept of "hypotheses remain indistinguishable" as a reason by itself to
 * stop, only "diminishing returns" (a budget-shaped reason) and
 * "no_informative_action" (a catalogue-shaped reason). `grep -rn
 * "differential" src/` before this module returns nothing; `grep -rn
 * "indistinguishable" src/diagnosis/stopping.ts` also returns nothing.
 *
 * This module composes the three, unmodified:
 *
 * - {@link competingBelief} turns a `HypothesisTree`'s open/confirmed
 *   posteriors into the `Belief` type `experiments.ts` already consumes, so
 *   the experiment planner always ranks against the tree's actual current
 *   state rather than a belief invented separately.
 * - {@link planDiscriminatingExperiments} calls `planSequence` unmodified on
 *   that belief, returning both the belief it planned against (for the
 *   caller to inspect) and the plan itself.
 * - {@link applyCalibratedObservation} calls `recordObservation` unmodified,
 *   then — only when a calibration map is supplied — replaces the posterior
 *   of every hypothesis still `open` or `confirmed` after the update with
 *   `applyCalibration`'s observed-accuracy-for-this-confidence-bin value
 *   (item 45's calibrator, unmodified), so belief that drives a stop decision
 *   has been checked against outcomes rather than asserted. Hypotheses that
 *   were refuted or abandoned by the observation are left exactly as
 *   `recordObservation` left them — calibrating a dead branch back up from
 *   zero would un-refute it.
 * - {@link differentialStopDecision} calls `shouldStop` unmodified, and adds
 *   exactly the one new reason this item's wording requires that neither
 *   underlying module names: "stop, or abstain, when hypotheses remain
 *   indistinguishable." Indistinguishability is computed from the tree
 *   itself (the margin between its two best surviving open/confirmed
 *   posteriors, reusing `ranking.ts`'s own `MIN_MARGIN` threshold so this
 *   module's notion of "too close to call" is the same one the final-answer
 *   ranker already uses) — never overriding `shouldStop`'s own verdict when
 *   it already resolved, and only replacing an `exhausted`/`continue` verdict
 *   with `indistinguishable: true` when there is no informative action left
 *   AND the leader and runner-up are within the margin. A single clear
 *   leader is never flagged indistinguishable, and `shouldStop`'s existing
 *   resolved/exhausted/blocked classifications are otherwise untouched.
 *
 * Pure: no fs, network, clock, or randomness; all inputs are supplied by the
 * caller.
 */
import { type CalibrationMap, applyCalibration } from "./calibration.js";
import { type Experiment, type ExperimentPlan, planSequence } from "./experiments.js";
import type { Belief } from "./experiments.js";
import {
	type HypothesisTree,
	type Observation,
	type RecordObservationResult,
	recordObservation,
} from "./hypothesis.js";
import { MIN_MARGIN } from "./ranking.js";
import {
	DEFAULT_STOPPING_POLICY,
	type InvestigationState,
	type StopDecision,
	type StoppingPolicy,
	shouldStop,
} from "./stopping.js";

/**
 * Open/confirmed hypothesis posteriors, keyed by hypothesis id. Refuted and
 * abandoned hypotheses are excluded: they are no longer competing, so an
 * experiment planner has nothing to gain by discriminating against them.
 */
export function competingBelief(tree: HypothesisTree): Belief {
	const belief: Belief = {};
	for (const h of tree.hypotheses) {
		if (h.status === "open" || h.status === "confirmed") belief[h.id] = h.posterior;
	}
	return belief;
}

export type DifferentialPlan = {
	belief: Belief;
	plan: ExperimentPlan;
};

/**
 * Plan a sequence of discriminating experiments against a hypothesis tree's
 * own current belief.
 *
 * Delegates entirely to `planSequence` (item 74) — this function's only job
 * is deriving the belief that call needs from the tree, so a caller never has
 * to keep the two in sync by hand.
 */
export function planDiscriminatingExperiments(
	tree: HypothesisTree,
	experiments: Experiment[],
	budget: number,
	opts: Parameters<typeof planSequence>[3] = {},
): DifferentialPlan {
	const belief = competingBelief(tree);
	return { belief, plan: planSequence(belief, experiments, budget, opts) };
}

export type CalibratedObservationResult = RecordObservationResult & {
	/** True iff a calibration map was supplied and applied. */
	calibrated: boolean;
};

/**
 * Record an observation, then — when a calibration map is supplied —
 * replace the posterior of every surviving (open/confirmed) hypothesis with
 * the observed accuracy for its confidence bin.
 *
 * `recordObservation` (item 43) already does the Bayesian update, the
 * refutation/abandonment propagation, and the sibling renormalization; none
 * of that is redone here. Calibration is applied strictly after, and strictly
 * to hypotheses that update left alive, so a refuted branch's posterior
 * (already forced to ~0 or exactly 0) is never pulled back up by a calibrator
 * that has never seen it.
 */
export function applyCalibratedObservation(
	tree: HypothesisTree,
	hypothesisId: string,
	observation: Observation,
	calibration?: CalibrationMap,
): CalibratedObservationResult {
	const result = recordObservation(tree, hypothesisId, observation);
	if (!calibration) return { ...result, calibrated: false };

	for (const h of result.tree.hypotheses) {
		if (h.status === "open" || h.status === "confirmed") {
			h.posterior = applyCalibration(calibration, h.posterior);
		}
	}
	return { ...result, calibrated: true };
}

export type DifferentialStopDecision = StopDecision & {
	/**
	 * True iff the tree's two best surviving hypotheses are within
	 * `ranking.ts`'s own `MIN_MARGIN` of each other and no informative action
	 * remains to separate them. The literal case this item names: stop, or
	 * abstain, because the competitors cannot currently be told apart.
	 */
	indistinguishable: boolean;
};

/** Margin between the best and second-best surviving hypothesis posteriors. */
function leaderMargin(tree: HypothesisTree): { margin: number; contested: boolean } {
	const live = tree.hypotheses
		.filter((h) => h.status === "open" || h.status === "confirmed")
		.map((h) => h.posterior)
		.sort((a, b) => b - a);
	if (live.length < 2) return { margin: Number.POSITIVE_INFINITY, contested: false };
	return { margin: live[0] - live[1], contested: true };
}

/**
 * Decide whether a differential investigation should stop, and whether the
 * reason is that its surviving hypotheses remain indistinguishable.
 *
 * Calls `shouldStop` (item 75) unmodified and never overrides a `resolved`
 * verdict. When the underlying decision was NOT resolved and there is no
 * informative action left to run (`state.remaining_actions` filtered to
 * `expected_bits >= policy.min_action_bits` is empty), the two best surviving
 * hypotheses being within `MIN_MARGIN` of each other names the stop as
 * indistinguishable rather than leaving it as an unexplained exhaustion or an
 * open-ended "continue".
 */
export function differentialStopDecision(
	tree: HypothesisTree,
	state: InvestigationState,
	policy: StoppingPolicy = DEFAULT_STOPPING_POLICY,
): DifferentialStopDecision {
	const base = shouldStop(state, policy);
	if (base.classification === "resolved") return { ...base, indistinguishable: false };

	const { margin, contested } = leaderMargin(tree);
	const noInformativeActionLeft = !state.remaining_actions.some(
		(a) => a.expected_bits >= policy.min_action_bits,
	);
	const tooClose = contested && margin < MIN_MARGIN;

	if (!(noInformativeActionLeft && tooClose)) {
		return { ...base, indistinguishable: false };
	}

	return {
		...base,
		stop: true,
		classification: base.classification === "blocked" ? "blocked" : "exhausted",
		summary: `${state.remaining_actions.length === 0 ? "no actions remain" : "no remaining action is expected to be informative"} and the leading hypotheses are separated by only ${margin.toFixed(3)} (below the ${MIN_MARGIN} margin ranking.ts treats as decisive): the competing hypotheses remain indistinguishable with what is available`,
		unblock: "add a discriminating experiment to the catalogue, gather more budget, or abstain",
		indistinguishable: true,
	};
}
