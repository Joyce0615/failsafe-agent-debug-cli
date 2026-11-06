import { type PrivacyBudget, requestEpsilon } from "../exchange/privacy-sharing.js";
/**
 * Cross-examination diagnosis sessions (item 33).
 *
 * `differential.ts` (item 26) already composes a hypothesis tree, an
 * experiment planner, and a stopping policy into "run discriminating
 * experiments until the leading hypotheses converge or become
 * indistinguishable" — but it has no session: nothing bounds how many turns
 * of back-and-forth a cross-examination may take, nothing accounts privacy
 * spend across those turns, and nothing lets a caller challenge an existing
 * causal claim with a NEW piece of evidence rather than only updating a
 * hypothesis posterior. `grep -rln "CrossExam|cross-examination" src/ tests/`
 * before this module returns nothing.
 *
 * This module adds exactly a session wrapper and a challenge entry point,
 * composing four already-existing, unmodified primitives:
 *
 * - {@link requestDiscriminatingEvidence} delegates to `differential.ts`'s
 *   `planDiscriminatingExperiments` (itself unmodified `experiments.ts`
 *   composition), refusing outright once the session's `max_turns` is spent
 *   — a session that already ran out of turns must not keep planning more
 *   work it cannot afford to act on.
 * - {@link recordCrossExamObservation} delegates to `differential.ts`'s
 *   `applyCalibratedObservation` (itself unmodified `hypothesis.ts`
 *   composition), but ONLY after both budgets this item names — turns via
 *   `requestEpsilon`-style all-or-nothing accounting, and privacy epsilon via
 *   `exchange/privacy-sharing.ts`'s `requestEpsilon` called unmodified —
 *   clear. A refusal leaves the session byte-for-byte unchanged: no turn
 *   consumed, no epsilon spent, no effect charged, exactly `requestEpsilon`'s
 *   own all-or-nothing discipline extended to the two new budgets a cross-
 *   examination session must also respect.
 * - {@link challengeCausalClaim} delegates to
 *   `causal-construction.ts`'s `constructCausalGraph` unmodified: "challenge
 *   a causal claim" IS exactly what an `InterventionFact` with
 *   `changed: false` already does there (refutes rather than weakly
 *   supports), so this function is a thin, honestly-named alias rather than
 *   a second implementation of refutation.
 * - {@link crossExaminationVerdict} delegates to `differential.ts`'s
 *   `differentialStopDecision` unmodified for the hypothesis-convergence
 *   question, and adds exactly the one thing neither it nor `shouldStop`
 *   knows about: a session can also run out of TURNS, independent of steps/
 *   tokens/time/actions. Turn exhaustion without a resolved verdict is named
 *   abstention, consistent with this item's wording ("converge or abstain
 *   under fixed turn ... budgets").
 *
 * Pure: no fs/network/clock/randomness; all inputs are supplied by the
 * caller. The session object itself is the only new state, and every
 * mutation returns a new session rather than mutating in place, so a caller
 * can always compare before/after.
 */
import { type CausalEvidence, constructCausalGraph } from "./causal-construction.js";
import type { CausalNode } from "./causal-graph.js";
import {
	applyCalibratedObservation,
	competingBelief,
	differentialStopDecision,
	planDiscriminatingExperiments,
} from "./differential.js";
import type { DifferentialPlan, DifferentialStopDecision } from "./differential.js";
import type { Experiment } from "./experiments.js";
import type { HypothesisTree, Observation } from "./hypothesis.js";
import type { InvestigationState, StoppingPolicy } from "./stopping.js";

export type CrossExamBudgets = {
	max_turns: number;
	epsilon_total: number;
	effects_total: number;
};

export type CrossExaminationSession = {
	tree: HypothesisTree;
	turn: number;
	max_turns: number;
	privacy_budget: PrivacyBudget;
	effects_spent: number;
	effects_total: number;
};

/** Start a fresh cross-examination session, all three budgets unspent. */
export function newCrossExaminationSession(
	tree: HypothesisTree,
	budgets: CrossExamBudgets,
): CrossExaminationSession {
	return {
		tree,
		turn: 0,
		max_turns: budgets.max_turns,
		privacy_budget: { epsilon_total: budgets.epsilon_total, epsilon_spent: 0 },
		effects_spent: 0,
		effects_total: budgets.effects_total,
	};
}

/** True once a session has no turns left to spend. */
export function turnsExhausted(session: CrossExaminationSession): boolean {
	return session.turn >= session.max_turns;
}

/**
 * Plan a sequence of discriminating experiments against the session's
 * current belief, refusing outright once the turn budget is exhausted — a
 * session with no turns left to act on a plan must not be handed one.
 */
export function requestDiscriminatingEvidence(
	session: CrossExaminationSession,
	experiments: Experiment[],
	budget: number,
	opts: Parameters<typeof planDiscriminatingExperiments>[3] = {},
): DifferentialPlan {
	if (turnsExhausted(session)) {
		throw new Error(
			`cross-examination session has spent all ${session.max_turns} turn(s); request more turns before planning further evidence`,
		);
	}
	return planDiscriminatingExperiments(session.tree, experiments, budget, opts);
}

export type CrossExamSpend = { epsilon: number; effect: number };

export type RecordObservationOutcome =
	| { ok: true; session: CrossExaminationSession; calibrated: boolean }
	| { ok: false; session: CrossExaminationSession; reason: string };

/**
 * Record an observation against one hypothesis, consuming one turn and both
 * the privacy and effect budgets this item names. All-or-nothing: if either
 * budget would be exceeded, or no turns remain, the session returned is the
 * SAME session passed in, unchanged, and the caller is told exactly why.
 */
export function recordCrossExamObservation(
	session: CrossExaminationSession,
	hypothesisId: string,
	observation: Observation,
	spend: CrossExamSpend,
	calibration?: Parameters<typeof applyCalibratedObservation>[3],
): RecordObservationOutcome {
	if (turnsExhausted(session)) {
		return {
			ok: false,
			session,
			reason: `cross-examination session has spent all ${session.max_turns} turn(s)`,
		};
	}
	if (session.effects_spent + spend.effect > session.effects_total) {
		return {
			ok: false,
			session,
			reason: `recording this observation would spend ${session.effects_spent + spend.effect} effect(s), exceeding the ${session.effects_total} effect budget`,
		};
	}
	const epsilonResult = requestEpsilon(session.privacy_budget, spend.epsilon);
	if (!epsilonResult.ok) {
		return { ok: false, session, reason: epsilonResult.message };
	}

	const applied = applyCalibratedObservation(session.tree, hypothesisId, observation, calibration);
	return {
		ok: true,
		calibrated: applied.calibrated,
		session: {
			...session,
			tree: applied.tree,
			turn: session.turn + 1,
			privacy_budget: epsilonResult.budget,
			effects_spent: session.effects_spent + spend.effect,
		},
	};
}

export type CausalChallengeResult = ReturnType<typeof constructCausalGraph>;

/**
 * Challenge an existing causal claim with new evidence. A thin, honestly
 * named alias for `constructCausalGraph` (item 83, unmodified): an
 * `InterventionFact` with `changed: false` is already exactly a refutation
 * there, so "challenge a causal claim" names what that call already does
 * rather than re-implementing it.
 */
export function challengeCausalClaim(
	nodes: CausalNode[],
	interventions: CausalEvidence["interventions"],
	otherEvidence: Omit<CausalEvidence, "interventions"> = {},
): CausalChallengeResult {
	return constructCausalGraph(nodes, { ...otherEvidence, interventions });
}

export type CrossExaminationVerdict = {
	abstain: boolean;
	reason: string;
	decision: DifferentialStopDecision;
};

/**
 * Decide whether a cross-examination session should converge or abstain.
 *
 * Checks the turn budget FIRST, independent of `differential.ts`'s own
 * stopping logic: a session can be turn-exhausted while the hypothesis
 * tree still looks informative, and conversely a hypothesis tree can
 * converge well within its turn budget. Only when turns remain does this
 * defer entirely to `differentialStopDecision` (item 26, unmodified) for the
 * hypothesis-convergence question; `abstain` is then true exactly when that
 * decision did NOT resolve.
 */
export function crossExaminationVerdict(
	session: CrossExaminationSession,
	partialState: Omit<
		InvestigationState,
		"leading_confidence" | "residual" | "steps" | "actions_taken" | "tokens_spent" | "elapsed_ms"
	>,
	policy?: StoppingPolicy,
): CrossExaminationVerdict {
	const belief = competingBelief(session.tree);
	const sorted = Object.values(belief).sort((a, b) => b - a);
	const leading = sorted[0] ?? 0;
	const residual = Math.max(0, 1 - sorted.reduce((a, b) => a + b, 0));

	const state: InvestigationState = {
		steps: session.turn,
		elapsed_ms: 0,
		tokens_spent: 0,
		actions_taken: session.turn,
		leading_confidence: leading,
		residual,
		...partialState,
	};

	if (turnsExhausted(session)) {
		const decision = differentialStopDecision(session.tree, state, policy);
		return {
			abstain: decision.classification !== "resolved",
			reason:
				decision.classification === "resolved"
					? decision.summary
					: `the turn budget of ${session.max_turns} is spent without the leading hypotheses converging: ${decision.summary}`,
			decision,
		};
	}

	const decision = differentialStopDecision(session.tree, state, policy);
	return {
		abstain: false,
		reason: decision.summary,
		decision,
	};
}
