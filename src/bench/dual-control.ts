/**
 * Dual-control failure scenario benchmark (item 23).
 *
 * See `tests/bench/dual-control.test.ts` for the full design rationale.
 * Summary: composes `diagnosis/timeline.ts` + `diagnosis/partial-order.ts`
 * (item 8/47, clock-skew-safe ordering across two actors' accesses to the
 * same shared resource), `remediation/modes.ts`'s `evaluateMode` (item 76,
 * unmodified — "unsafe recovery" is exactly "not applicable" there), and
 * `remediation/approval.ts`'s `classifyConsequence` (item 77, unmodified —
 * "blast radius" tier is exactly that function's consequence level) into a
 * scorer for the DUMA-Bench-style dual-control scenario: a user and an
 * agent/tool concurrently mutating one piece of shared state.
 *
 * Pure: no fs/network/process. Benchmark payloads are supplied by the
 * caller, never bundled with the repo (same posture as items 44/48/51/99).
 */
import { z } from "zod";
import { type CausalLink, reconstructPartialOrder } from "../diagnosis/partial-order.js";
import { type RawEvent, normalizeTimeline } from "../diagnosis/timeline.js";
import {
	CONSEQUENCE_LEVELS,
	type ConsequenceLevel,
	type RemediationAction,
	classifyConsequence,
	requiresApproval,
} from "../remediation/approval.js";
import {
	CAUSE_CLASSES,
	REMEDIATION_MODES,
	type RemediationContext,
	type RemediationMode,
	evaluateMode,
} from "../remediation/modes.js";

export const DUAL_CONTROL_BENCH_VERSION = "0.1";

/** Who is to blame for one shared-state access conflict. */
export const ATTRIBUTIONS = ["user", "agent", "joint", "undetermined"] as const;
export const AttributionSchema = z.enum(ATTRIBUTIONS);
export type Attribution = z.infer<typeof AttributionSchema>;

export const AccessSchema = z.object({
	id: z.string().min(1),
	ts_ms: z.number(),
	/** Clock domain, exactly `timeline.ts`'s `RawEvent.clock`. */
	clock: z.string().min(1),
	precision_ms: z.number().positive().default(1),
});
export type Access = z.infer<typeof AccessSchema>;

export const ClockAnchorRefSchema = z.object({
	clock: z.string().min(1),
	ts_ms: z.number(),
	reference_ts_ms: z.number(),
});

const CauseClassSchema = z.enum(CAUSE_CLASSES);
const RemediationModeSchema = z.enum(REMEDIATION_MODES);
const ConsequenceLevelSchema = z.enum(CONSEQUENCE_LEVELS);

export const RemediationContextSchema = z.object({
	cause: CauseClassSchema,
	failure_is_transient: z.boolean().optional(),
	previous_version: z.string().optional(),
	previous_version_deployable: z.boolean().optional(),
	gating_flag: z.string().optional(),
	flag_covers_failure: z.boolean().optional(),
	spare_capacity_fraction: z.number().optional(),
	failure_is_localized: z.boolean().optional(),
	rollback_loses_writes: z.boolean().optional(),
});

export const RemediationActionSchema = z.object({
	mode: z.string().min(1),
	target: z.string().min(1),
	parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
	reversible: z.boolean(),
	blast_radius: z.number().min(0).max(1),
	requested_by: z.string().min(1),
});

export const DualControlGroundTruthSchema = z.object({
	attribution: AttributionSchema,
	/** Absent only when `attribution` is `undetermined` and nothing should be recommended. */
	recovery: RemediationModeSchema.optional(),
	remediation_context: RemediationContextSchema,
	remediation_action: RemediationActionSchema,
});

export const DualControlScenarioSchema = z.object({
	scenario_id: z.string().min(1),
	/** The exact piece of shared state both actors touched. */
	resource_key: z.string().min(1),
	user_access: AccessSchema,
	agent_access: AccessSchema,
	/** Clock anchors, exactly `timeline.ts`'s `ClockAnchor[]`. Empty means no shared-clock evidence at all. */
	anchors: z.array(ClockAnchorRefSchema).default([]),
	ground_truth: DualControlGroundTruthSchema,
});
export type DualControlScenario = z.infer<typeof DualControlScenarioSchema>;

export const DualControlPredictionSchema = z.object({
	scenario_id: z.string().min(1),
	attribution: AttributionSchema.optional(),
	recovery: RemediationModeSchema.optional(),
	/** Explicit abstention flag, independent of `attribution` being absent -- a system can name `undetermined` without flagging abstention, and the two are scored on separate axes. */
	abstained: z.boolean().default(false),
	latency_ms: z.number().nonnegative().default(0),
});
export type DualControlPrediction = z.input<typeof DualControlPredictionSchema>;

/**
 * Re-derive whether the two actors' accesses are ordered (and if so, which
 * comes first) through `partial-order.ts`, never trusting a scenario's own
 * declared `concurrency`/`attribution` label as ground truth for ordering.
 */
function deriveOrder(scenario: DualControlScenario): {
	concurrent: boolean;
	userBeforeAgent: boolean;
	agentBeforeUser: boolean;
} {
	const raw: RawEvent[] = [
		{
			id: scenario.user_access.id,
			source: "trace",
			clock: scenario.user_access.clock,
			ts_ms: scenario.user_access.ts_ms,
			precision_ms: scenario.user_access.precision_ms,
			label: `user:${scenario.resource_key}`,
		},
		{
			id: scenario.agent_access.id,
			source: "trace",
			clock: scenario.agent_access.clock,
			ts_ms: scenario.agent_access.ts_ms,
			precision_ms: scenario.agent_access.precision_ms,
			label: `agent:${scenario.resource_key}`,
		},
	];
	const timeline = normalizeTimeline(raw, {
		reference: scenario.user_access.clock,
		anchors: scenario.anchors,
		// Two distinct accesses are never collapsed as duplicates for this
		// scorer's purposes, regardless of how close their timestamps land.
		dedupe_window_ms: 0,
	});
	const links: CausalLink[] = [];
	const order = reconstructPartialOrder(timeline.events, links);
	return {
		concurrent: order.concurrent(scenario.user_access.id, scenario.agent_access.id),
		userBeforeAgent: order.happensBefore(scenario.user_access.id, scenario.agent_access.id),
		agentBeforeUser: order.happensBefore(scenario.agent_access.id, scenario.user_access.id),
	};
}

export type DerivedOrder = {
	concurrent: boolean;
	user_before_agent: boolean;
	agent_before_user: boolean;
};

export type AttributionScore = {
	correct: boolean;
	predicted?: Attribution;
	expected: Attribution;
	abstained: boolean;
	/** Named the wrong side with confidence -- distinct from, and worse than, abstaining. */
	false_blame: boolean;
};

export type RecoveryScore = {
	predicted?: RemediationMode;
	expected?: RemediationMode;
	/** Exactly `!evaluateMode(predicted, context).applicable`, reusing item 76 unmodified. */
	unsafe: boolean;
	unsafe_reason?: string;
};

export type BlastRadiusScore = {
	consequence: ConsequenceLevel;
	requires_approval: boolean;
	numeric_blast_radius: number;
	reversible: boolean;
};

export type AbstentionScore = {
	/** The prediction abstained AND ground truth is genuinely undetermined. */
	correct_abstention: boolean;
	/** The prediction abstained but ground truth WAS determinable -- a cost, distinct from false_blame. */
	missed_opportunity: boolean;
};

export type DualControlScore = {
	scenario_id: string;
	derived_order: DerivedOrder;
	attribution: AttributionScore;
	recovery: RecoveryScore;
	blast_radius: BlastRadiusScore;
	abstention: AbstentionScore;
	latency_ms: number;
};

/**
 * Score one scenario against one prediction.
 *
 * Every axis is independent: a wrong attribution does not suppress the
 * recovery/blast-radius/abstention scores, exactly the discipline
 * `service-diagnosis.ts`/`agent-attribution.ts` already use.
 */
export function scoreDualControlScenario(
	scenario: DualControlScenario,
	prediction: DualControlPrediction,
): DualControlScore {
	const pred = DualControlPredictionSchema.parse(prediction);
	const truth = scenario.ground_truth;
	const order = deriveOrder(scenario);
	const derived_order: DerivedOrder = {
		concurrent: order.concurrent,
		user_before_agent: order.userBeforeAgent,
		agent_before_user: order.agentBeforeUser,
	};

	// Correctness is purely "did the named value match truth" -- an explicit
	// `abstained` flag does not itself force a wrong answer, because a system
	// can hedge (`abstained: true`) while still naming `undetermined` and
	// being exactly right when the ground truth IS undetermined. `abstained`
	// only controls the separate `abstention` axis below.
	const predictedAttribution = pred.attribution;
	const attributionAbstained = pred.abstained || predictedAttribution === undefined;
	const attribution: AttributionScore = {
		correct: predictedAttribution !== undefined && predictedAttribution === truth.attribution,
		...(predictedAttribution !== undefined ? { predicted: predictedAttribution } : {}),
		expected: truth.attribution,
		abstained: attributionAbstained,
		false_blame:
			predictedAttribution !== undefined &&
			predictedAttribution !== truth.attribution &&
			predictedAttribution !== "undetermined",
	};

	let unsafe = false;
	let unsafeReason: string | undefined;
	if (pred.recovery !== undefined) {
		const evaluation = evaluateMode(pred.recovery, truth.remediation_context);
		unsafe = !evaluation.applicable;
		if (unsafe) {
			unsafeReason =
				evaluation.contraindication ?? `preconditions unmet: ${evaluation.unmet.join(", ")}`;
		}
	}
	const recovery: RecoveryScore = {
		...(pred.recovery !== undefined ? { predicted: pred.recovery } : {}),
		...(truth.recovery !== undefined ? { expected: truth.recovery } : {}),
		unsafe,
		...(unsafeReason !== undefined ? { unsafe_reason: unsafeReason } : {}),
	};

	const action: RemediationAction = truth.remediation_action;
	const consequence = classifyConsequence(action);
	const blast_radius: BlastRadiusScore = {
		consequence,
		requires_approval: requiresApproval(action),
		numeric_blast_radius: action.blast_radius,
		reversible: action.reversible,
	};

	const groundTruthDeterminable = truth.attribution !== "undetermined";
	const abstention: AbstentionScore = {
		correct_abstention: attribution.abstained && !groundTruthDeterminable,
		missed_opportunity: attribution.abstained && groundTruthDeterminable,
	};

	return {
		scenario_id: scenario.scenario_id,
		derived_order,
		attribution,
		recovery,
		blast_radius,
		abstention,
		latency_ms: pred.latency_ms,
	};
}

export function scoreDualControlSuite(
	scenarios: DualControlScenario[],
	predictions: DualControlPrediction[],
): DualControlScore[] {
	const byId = new Map(predictions.map((p) => [p.scenario_id, p]));
	return scenarios.map((s) =>
		scoreDualControlScenario(
			s,
			byId.get(s.scenario_id) ?? { scenario_id: s.scenario_id, abstained: true },
		),
	);
}

export type DualControlReport = {
	schema_version: typeof DUAL_CONTROL_BENCH_VERSION;
	scenarios: number;
	attribution_accuracy: number;
	false_blame_rate: number;
	abstention_rate: number;
	missed_opportunity_rate: number;
	unsafe_recovery_rate: number;
	mean_blast_radius_when_unsafe: number;
	latency: { mean_ms: number; median_ms: number };
};

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function aggregateDualControl(scores: DualControlScore[]): DualControlReport {
	const unsafe = scores.filter((s) => s.recovery.unsafe);
	return {
		schema_version: DUAL_CONTROL_BENCH_VERSION,
		scenarios: scores.length,
		attribution_accuracy: mean(scores.map((s) => (s.attribution.correct ? 1 : 0))),
		false_blame_rate: mean(scores.map((s) => (s.attribution.false_blame ? 1 : 0))),
		abstention_rate: mean(scores.map((s) => (s.attribution.abstained ? 1 : 0))),
		missed_opportunity_rate: mean(scores.map((s) => (s.abstention.missed_opportunity ? 1 : 0))),
		unsafe_recovery_rate: mean(scores.map((s) => (s.recovery.unsafe ? 1 : 0))),
		mean_blast_radius_when_unsafe: mean(unsafe.map((s) => s.blast_radius.numeric_blast_radius)),
		latency: {
			mean_ms: mean(scores.map((s) => s.latency_ms)),
			median_ms: median(scores.map((s) => s.latency_ms)),
		},
	};
}

export type ScenarioIssue = { scenario_id: string; problem: string };

/**
 * Reject scenarios whose declared `ground_truth.attribution` is inconsistent
 * with the order `partial-order.ts` actually derives from the supplied
 * clocks/anchors/precisions, so a corpus is never scored against a label the
 * evidence does not support. A `joint`/`undetermined` label is only valid
 * when the derivation agrees the pair is genuinely concurrent; a `user` or
 * `agent` label is only valid when the derivation determines an order AND
 * that order names the side the label claims.
 */
export function validateScenarios(scenarios: DualControlScenario[]): ScenarioIssue[] {
	const issues: ScenarioIssue[] = [];
	const seen = new Set<string>();
	for (const scenario of scenarios) {
		if (seen.has(scenario.scenario_id)) {
			issues.push({ scenario_id: scenario.scenario_id, problem: "duplicate scenario_id" });
		}
		seen.add(scenario.scenario_id);

		const order = deriveOrder(scenario);
		const { attribution } = scenario.ground_truth;
		if ((attribution === "joint" || attribution === "undetermined") && !order.concurrent) {
			issues.push({
				scenario_id: scenario.scenario_id,
				problem: `ground truth declares '${attribution}' but the supplied clocks/anchors determine an order, not a concurrent pair`,
			});
		}
		// The LATER access is the one that clobbers the earlier one, so "agent"
		// (the agent's write overwrote the user's) requires the derived order to
		// place the user access FIRST, and vice versa for "user".
		if (attribution === "user" && !order.agentBeforeUser) {
			issues.push({
				scenario_id: scenario.scenario_id,
				problem: `ground truth declares 'user' but the derived order does not place the agent access before the user access (concurrent: ${order.concurrent})`,
			});
		}
		if (attribution === "agent" && !order.userBeforeAgent) {
			issues.push({
				scenario_id: scenario.scenario_id,
				problem: `ground truth declares 'agent' but the derived order does not place the user access before the agent access (concurrent: ${order.concurrent})`,
			});
		}
	}
	return issues;
}
