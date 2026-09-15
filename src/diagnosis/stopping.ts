/**
 * Stopping rules for an investigation (item 75).
 *
 * An investigation has to end, and there are only two respectable ways for it
 * to do so: it answered the question, or it ran out of something. The single
 * most damaging thing a debugging system can do is confuse the two — reporting
 * "diagnosis complete" when what happened is "token budget exhausted" sends
 * someone to act on a conclusion the system never reached. So the decision this
 * module returns carries a `classification` alongside its reason, and
 * `resolved` is reachable by exactly one path.
 *
 * The other three ideas here are all about not stopping too early:
 *
 * 1. **High confidence after almost no work is not a result.** If the leading
 *    hypothesis was already at 0.8 before any evidence was gathered, stopping
 *    at 0.85 reports the prior back to the caller with a new label. A minimum
 *    number of evidence-gathering steps is required before `confidence_reached`
 *    can fire; below it the decision is `confident_but_unexamined` and the
 *    investigation continues.
 *
 * 2. **Diminishing returns must be measured over a window.** One uninformative
 *    step is completely normal — most probes fail to discriminate. Stopping on
 *    a single flat step would abandon investigations that were about to turn.
 *    The rule looks at the mean gain over the last several steps.
 *
 * 3. **"Nothing left I am allowed to do" is not "nothing left to do".** When
 *    every remaining action exceeds the risk ceiling, the investigation is
 *    `blocked`, and the report says which tier would unblock it. Reporting that
 *    as exhaustion hides an answerable question behind a policy decision nobody
 *    was asked to make.
 *
 * Pure: no I/O.
 */

export const STOP_REASONS = [
	"confidence_reached",
	"budget_exhausted",
	"time_exhausted",
	"action_limit_reached",
	"diminishing_returns",
	"no_informative_action",
	"risk_ceiling_blocks_progress",
	"confident_but_unexamined",
	"continue",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * What the reason means for whoever reads the result.
 *
 * The mapping is the load-bearing part: only `confidence_reached` maps to
 * `resolved`, so no exhaustion path can be mistaken for an answer.
 */
export const REASON_CLASSIFICATION: Record<
	StopReason,
	"resolved" | "exhausted" | "blocked" | "continue"
> = {
	confidence_reached: "resolved",
	budget_exhausted: "exhausted",
	time_exhausted: "exhausted",
	action_limit_reached: "exhausted",
	diminishing_returns: "exhausted",
	no_informative_action: "exhausted",
	risk_ceiling_blocks_progress: "blocked",
	confident_but_unexamined: "continue",
	continue: "continue",
};

export const RISK_TIERS = ["observational", "reversible", "disruptive", "destructive"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export type InvestigationState = {
	/** Evidence-gathering steps completed. */
	steps: number;
	elapsed_ms: number;
	tokens_spent: number;
	actions_taken: number;
	/** Confidence in the leading hypothesis, 0..1. */
	leading_confidence: number;
	/** Belief that none of the hypotheses is the cause. */
	residual: number;
	/** Information gain (bits) from each step, oldest first. */
	step_gains: number[];
	/** Actions still available, with the risk tier each requires. */
	remaining_actions: Array<{ id: string; risk: RiskTier; expected_bits: number }>;
};

export type StoppingPolicy = {
	/** Confidence at which the question is considered answered. */
	target_confidence: number;
	max_tokens: number;
	max_ms: number;
	max_actions: number;
	/** Highest risk tier the investigation is authorized to use. */
	max_risk: RiskTier;
	/** Steps that must be taken before confidence can end the investigation. */
	min_steps: number;
	/** Window over which diminishing returns are assessed. */
	returns_window: number;
	/** Mean bits per step below which the window counts as flat. */
	min_mean_gain: number;
	/** Expected bits below which an action is not worth taking. */
	min_action_bits: number;
};

export const DEFAULT_STOPPING_POLICY: StoppingPolicy = {
	target_confidence: 0.85,
	max_tokens: 50_000,
	max_ms: 300_000,
	max_actions: 25,
	max_risk: "reversible",
	// Three, not one: a conclusion reached without gathering evidence is the
	// prior wearing a different name.
	min_steps: 3,
	returns_window: 3,
	min_mean_gain: 0.05,
	min_action_bits: 0.05,
};

export type StopDecision = {
	stop: boolean;
	reason: StopReason;
	classification: "resolved" | "exhausted" | "blocked" | "continue";
	/** One sentence stating what happened, in terms a reader can act on. */
	summary: string;
	/** Everything that was true at the moment of the decision, for the record. */
	observations: string[];
	/** What would change the outcome. Empty when the investigation resolved. */
	unblock?: string;
};

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Decide whether to stop, and why.
 *
 * Order is deliberate. Exhaustion checks come *before* the confidence check,
 * because a run that is both out of budget and confident got there partly by
 * luck of scheduling, and reporting it as resolved would make the budget
 * invisible. The one exception is that `confident_but_unexamined` is evaluated
 * with the confidence check, so a shallow high-confidence run is never
 * mislabelled as anything else.
 */
export function shouldStop(
	state: InvestigationState,
	policy: StoppingPolicy = DEFAULT_STOPPING_POLICY,
): StopDecision {
	const observations: string[] = [
		`${state.steps} step(s), ${state.actions_taken} action(s), ${state.tokens_spent} tokens, ${state.elapsed_ms}ms`,
		`leading confidence ${state.leading_confidence.toFixed(3)}, residual ${state.residual.toFixed(3)}`,
	];

	const decide = (reason: StopReason, summary: string, unblock?: string): StopDecision => ({
		stop: REASON_CLASSIFICATION[reason] !== "continue",
		reason,
		classification: REASON_CLASSIFICATION[reason],
		summary,
		observations,
		...(unblock ? { unblock } : {}),
	});

	if (state.tokens_spent >= policy.max_tokens) {
		return decide(
			"budget_exhausted",
			`the token budget of ${policy.max_tokens} is spent; the leading hypothesis stands at ${state.leading_confidence.toFixed(2)} and has NOT been confirmed`,
			`raise max_tokens above ${state.tokens_spent}`,
		);
	}
	if (state.elapsed_ms >= policy.max_ms) {
		return decide(
			"time_exhausted",
			`the time budget of ${policy.max_ms}ms is spent; the investigation is incomplete`,
			`raise max_ms above ${state.elapsed_ms}`,
		);
	}
	if (state.actions_taken >= policy.max_actions) {
		return decide(
			"action_limit_reached",
			`the action limit of ${policy.max_actions} is reached; the investigation is incomplete`,
			`raise max_actions above ${state.actions_taken}`,
		);
	}

	// Confidence, with the shallow-run guard.
	if (state.leading_confidence >= policy.target_confidence) {
		if (state.steps < policy.min_steps) {
			return decide(
				"confident_but_unexamined",
				`confidence is ${state.leading_confidence.toFixed(2)} after only ${state.steps} step(s); with fewer than ${policy.min_steps} steps of evidence this is the prior, not a finding, so the investigation continues`,
				`gather ${policy.min_steps - state.steps} more step(s) of evidence`,
			);
		}
		return decide(
			"confidence_reached",
			`the leading hypothesis reached ${state.leading_confidence.toFixed(2)} (target ${policy.target_confidence}) after ${state.steps} steps of evidence`,
		);
	}

	// Available actions, split by whether policy permits them.
	const ceiling = RISK_TIERS.indexOf(policy.max_risk);
	const permitted = state.remaining_actions.filter((a) => RISK_TIERS.indexOf(a.risk) <= ceiling);
	const informativePermitted = permitted.filter((a) => a.expected_bits >= policy.min_action_bits);
	const informativeBlocked = state.remaining_actions.filter(
		(a) => RISK_TIERS.indexOf(a.risk) > ceiling && a.expected_bits >= policy.min_action_bits,
	);

	if (informativePermitted.length === 0 && informativeBlocked.length > 0) {
		const cheapestTier = informativeBlocked
			.map((a) => RISK_TIERS.indexOf(a.risk))
			.sort((a, b) => a - b)[0];
		return decide(
			"risk_ceiling_blocks_progress",
			`every remaining informative action requires a risk tier above '${policy.max_risk}'; the question is answerable but not under the current authorization`,
			`authorize risk tier '${RISK_TIERS[cheapestTier]}' to continue`,
		);
	}
	if (informativePermitted.length === 0) {
		return decide(
			"no_informative_action",
			`no remaining action is expected to yield ${policy.min_action_bits} bits; the leading hypothesis stands at ${state.leading_confidence.toFixed(2)} and cannot be improved with what is available`,
			"add experiments to the catalogue, or accept the current confidence",
		);
	}

	// Diminishing returns, over a window rather than a single step.
	if (state.step_gains.length >= policy.returns_window) {
		const window = state.step_gains.slice(-policy.returns_window);
		const windowMean = mean(window);
		if (windowMean < policy.min_mean_gain) {
			observations.push(
				`last ${policy.returns_window} steps yielded ${window.map((g) => g.toFixed(3)).join(", ")} bits`,
			);
			return decide(
				"diminishing_returns",
				`the last ${policy.returns_window} steps averaged ${windowMean.toFixed(3)} bits, below the ${policy.min_mean_gain} floor; further work on this line is not paying`,
				"change approach: the remaining actions are not addressing what is still uncertain",
			);
		}
	}

	return decide(
		"continue",
		`confidence ${state.leading_confidence.toFixed(2)} is below the ${policy.target_confidence} target and ${informativePermitted.length} informative action(s) remain`,
	);
}

export type StoppingTrace = {
	decisions: StopDecision[];
	final: StopDecision;
	/** True only when the investigation ended by answering the question. */
	resolved: boolean;
};

/**
 * Replay a sequence of states through the policy.
 *
 * Useful for auditing a completed investigation: it makes visible whether the
 * run stopped where the policy says it should have, and — more usefully —
 * whether it was one step away from resolving when its budget ran out.
 */
export function replay(
	states: InvestigationState[],
	policy: StoppingPolicy = DEFAULT_STOPPING_POLICY,
): StoppingTrace {
	const decisions: StopDecision[] = [];
	for (const state of states) {
		const decision = shouldStop(state, policy);
		decisions.push(decision);
		if (decision.stop) break;
	}
	const final = decisions[decisions.length - 1] ?? shouldStop(states[0], policy);
	return { decisions, final, resolved: final.classification === "resolved" };
}

/**
 * How close an exhausted investigation was to resolving.
 *
 * The number worth knowing after a budget-limited run: a run that stopped at
 * 0.83 against a 0.85 target should probably be given more budget, and one that
 * stopped at 0.21 should not. Returns `null` for a resolved run, where the
 * question does not arise.
 */
export function shortfall(
	decision: StopDecision,
	state: InvestigationState,
	policy: StoppingPolicy = DEFAULT_STOPPING_POLICY,
): { gap: number; residual: number; worth_extending: boolean } | null {
	if (decision.classification === "resolved") return null;
	const gap = policy.target_confidence - state.leading_confidence;
	return {
		gap,
		residual: state.residual,
		// Extending is worth it only when the belief is concentrated *and* close.
		// A high residual means the answer is probably not among the candidates,
		// and more budget spent on the same candidates buys nothing.
		worth_extending: gap <= 0.15 && state.residual < 0.3,
	};
}
