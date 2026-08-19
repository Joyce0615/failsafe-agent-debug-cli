/**
 * Step-level agent failure attribution (item 48).
 *
 * AgentRx-style evaluation asks a harder question than "did the run fail":
 * *which agent*, at *which step*, went wrong; whether the evidence offered
 * actually supports that claim; and what should be done about it. In a
 * long-horizon, probabilistic trajectory those come apart — a system can name
 * the right agent and the wrong step, or the right step for reasons it cannot
 * evidence.
 *
 * Four axes are scored separately:
 *
 * 1. **Agent** — which agent is blamed.
 * 2. **Step** — exact index, plus a tolerance band and the signed distance, so
 *    "off by one" and "off by forty" are not the same result.
 * 3. **Evidence sufficiency** — whether the cited steps actually contain the
 *    antecedents the ground truth says are needed. A correct attribution with
 *    insufficient evidence is a lucky guess, and is labelled as one.
 * 4. **Recovery** — the recommended action, from a controlled vocabulary.
 *
 * The report always includes two **trivial baselines**: blame the last step,
 * and blame the first step that reported an error. Long-horizon trajectories
 * usually fail near the end, so a headline accuracy that does not beat "blame
 * the last step" is measuring the corpus, not the system. Reporting the
 * baselines next to the system is the point.
 *
 * Pure: no network, no dataset download, no clock.
 */
import { z } from "zod";

/** Fixture families an attribution corpus is drawn from. */
export const ATTRIBUTION_DOMAINS = ["api", "incident", "web_file"] as const;
export const AttributionDomainSchema = z.enum(ATTRIBUTION_DOMAINS);
export type AttributionDomain = z.infer<typeof AttributionDomainSchema>;

/** Controlled recovery vocabulary; free text cannot be scored. */
export const RECOVERY_ACTIONS = [
	"retry",
	"reformulate_request",
	"switch_tool",
	"fix_input",
	"escalate",
	"abort",
] as const;
export const RecoveryActionSchema = z.enum(RECOVERY_ACTIONS);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const ATTRIBUTION_BENCH_VERSION = "0.1";

export const TrajectoryStepSchema = z.object({
	/** Position in the trajectory, 0-based and contiguous. */
	index: z.number().int().nonnegative(),
	agent: z.string().min(1),
	action: z.string(),
	observation: z.string().default(""),
	/** Whether the step itself reported success. */
	ok: z.boolean().default(true),
});
export type AttributionStep = z.infer<typeof TrajectoryStepSchema>;

export const AttributionCaseSchema = z.object({
	case_id: z.string().min(1),
	domain: AttributionDomainSchema,
	steps: z.array(TrajectoryStepSchema).min(1),
	ground_truth: z.object({
		agent: z.string().min(1),
		/** The step where the failure was *introduced*, not where it surfaced. */
		step_index: z.number().int().nonnegative(),
		/**
		 * Steps a sufficient explanation must cite — the decisive step plus its
		 * causal antecedents.
		 */
		evidence_steps: z.array(z.number().int().nonnegative()).default([]),
		recovery: RecoveryActionSchema,
	}),
});
export type AttributionCase = z.infer<typeof AttributionCaseSchema>;

export const AttributionPredictionSchema = z.object({
	case_id: z.string().min(1),
	/** Absent means the system declined to attribute. */
	agent: z.string().optional(),
	step_index: z.number().int().nonnegative().optional(),
	cited_steps: z.array(z.number().int().nonnegative()).default([]),
	recovery: RecoveryActionSchema.optional(),
});
export type AttributionPrediction = z.infer<typeof AttributionPredictionSchema>;

/** Steps either side of the truth that still count as located. */
export const DEFAULT_STEP_TOLERANCE = 1;

export type AgentScore = {
	correct: boolean;
	predicted?: string;
	expected: string;
	abstained: boolean;
};

export type StepScore = {
	exact: boolean;
	within_tolerance: boolean;
	tolerance: number;
	/** Signed `predicted - expected`, or `null` when abstained. */
	distance: number | null;
	/** Truth's position in the trajectory, 0..1. Exposes end-loaded corpora. */
	truth_position: number;
	abstained: boolean;
};

export type EvidenceSufficiency = {
	/** Every required antecedent was cited. */
	sufficient: boolean;
	precision: number;
	recall: number;
	cited: number;
	required: number;
	/** Cited step indices that do not exist in the trajectory. */
	out_of_range_citations: number;
};

export type RecoveryScore = {
	correct: boolean;
	predicted?: RecoveryAction;
	expected: RecoveryAction;
	abstained: boolean;
};

export type AttributionScore = {
	case_id: string;
	domain: AttributionDomain;
	agent: AgentScore;
	step: StepScore;
	/** Agent and step both correct. The claim an operator would actually act on. */
	joint_correct: boolean;
	/**
	 * Joint-correct *and* evidence-sufficient. The difference between this and
	 * `joint_correct` is the share of right answers the system cannot support.
	 */
	joint_supported: boolean;
	evidence: EvidenceSufficiency;
	recovery: RecoveryScore;
};

export function scoreAttribution(
	testCase: AttributionCase,
	prediction: AttributionPrediction,
	opts: { tolerance?: number } = {},
): AttributionScore {
	const tolerance = opts.tolerance ?? DEFAULT_STEP_TOLERANCE;
	const truth = testCase.ground_truth;
	const lastIndex = testCase.steps.length - 1;

	const agent: AgentScore = {
		correct: prediction.agent === truth.agent,
		...(prediction.agent ? { predicted: prediction.agent } : {}),
		expected: truth.agent,
		abstained: prediction.agent === undefined,
	};

	const stepAbstained = prediction.step_index === undefined;
	const distance = stepAbstained ? null : (prediction.step_index as number) - truth.step_index;
	const step: StepScore = {
		exact: distance === 0,
		within_tolerance: distance !== null && Math.abs(distance) <= tolerance,
		tolerance,
		distance,
		truth_position: lastIndex > 0 ? truth.step_index / lastIndex : 0,
		abstained: stepAbstained,
	};

	const valid = new Set(testCase.steps.map((s) => s.index));
	const cited = new Set(prediction.cited_steps);
	const required = new Set(truth.evidence_steps);
	let matched = 0;
	for (const index of cited) {
		if (required.has(index)) matched++;
	}
	let outOfRange = 0;
	for (const index of cited) {
		if (!valid.has(index)) outOfRange++;
	}
	const evidence: EvidenceSufficiency = {
		sufficient: [...required].every((index) => cited.has(index)),
		precision: cited.size > 0 ? matched / cited.size : 0,
		recall: required.size > 0 ? matched / required.size : 1,
		cited: cited.size,
		required: required.size,
		out_of_range_citations: outOfRange,
	};

	const recovery: RecoveryScore = {
		correct: prediction.recovery === truth.recovery,
		...(prediction.recovery ? { predicted: prediction.recovery } : {}),
		expected: truth.recovery,
		abstained: prediction.recovery === undefined,
	};

	const jointCorrect = agent.correct && step.exact;
	return {
		case_id: testCase.case_id,
		domain: testCase.domain,
		agent,
		step,
		joint_correct: jointCorrect,
		joint_supported: jointCorrect && evidence.sufficient,
		evidence,
		recovery,
	};
}

/**
 * Control: blame the last step, its agent, cite it, and recommend a retry.
 *
 * Not a strawman — it is what an end-loaded corpus rewards, and any system that
 * cannot beat it has not demonstrated attribution.
 */
export function lastStepBaseline(testCase: AttributionCase): AttributionPrediction {
	const last = testCase.steps[testCase.steps.length - 1];
	return {
		case_id: testCase.case_id,
		agent: last.agent,
		step_index: last.index,
		cited_steps: [last.index],
		recovery: "retry",
	};
}

/**
 * Control: blame the first step that reported an error.
 *
 * Distinct from the last-step control because a failure is usually *introduced*
 * before it *surfaces*; this baseline is right exactly when the two coincide.
 */
export function firstErrorBaseline(testCase: AttributionCase): AttributionPrediction {
	const first = testCase.steps.find((s) => !s.ok) ?? testCase.steps[0];
	return {
		case_id: testCase.case_id,
		agent: first.agent,
		step_index: first.index,
		cited_steps: [first.index],
		recovery: "retry",
	};
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export type AttributionMetrics = {
	cases: number;
	agent_accuracy: number;
	step_exact_accuracy: number;
	step_within_tolerance: number;
	mean_absolute_step_distance: number;
	joint_accuracy: number;
	/** Joint-correct answers the system could also evidence. */
	joint_supported_accuracy: number;
	evidence_sufficiency_rate: number;
	mean_evidence_precision: number;
	recovery_accuracy: number;
	abstention_rate: number;
	out_of_range_citations: number;
};

export function summarizeScores(scores: AttributionScore[]): AttributionMetrics {
	const located = scores.filter((s) => s.step.distance !== null);
	return {
		cases: scores.length,
		agent_accuracy: mean(scores.map((s) => (s.agent.correct ? 1 : 0))),
		step_exact_accuracy: mean(scores.map((s) => (s.step.exact ? 1 : 0))),
		step_within_tolerance: mean(scores.map((s) => (s.step.within_tolerance ? 1 : 0))),
		mean_absolute_step_distance: mean(located.map((s) => Math.abs(s.step.distance as number))),
		joint_accuracy: mean(scores.map((s) => (s.joint_correct ? 1 : 0))),
		joint_supported_accuracy: mean(scores.map((s) => (s.joint_supported ? 1 : 0))),
		evidence_sufficiency_rate: mean(scores.map((s) => (s.evidence.sufficient ? 1 : 0))),
		mean_evidence_precision: mean(scores.map((s) => s.evidence.precision)),
		recovery_accuracy: mean(scores.map((s) => (s.recovery.correct ? 1 : 0))),
		abstention_rate: mean(scores.map((s) => (s.step.abstained || s.agent.abstained ? 1 : 0))),
		out_of_range_citations: scores.reduce((a, s) => a + s.evidence.out_of_range_citations, 0),
	};
}

export type AttributionReport = {
	schema_version: typeof ATTRIBUTION_BENCH_VERSION;
	system: AttributionMetrics;
	baselines: { last_step: AttributionMetrics; first_error: AttributionMetrics };
	/**
	 * `system.joint_accuracy` minus the better baseline's. Negative or near-zero
	 * means the corpus, not the system, is producing the number.
	 */
	joint_lift_over_best_baseline: number;
	by_domain: Array<{ domain: AttributionDomain } & AttributionMetrics>;
	/**
	 * Mean position of the true failure step in its trajectory. Near 1 means an
	 * end-loaded corpus where the last-step baseline is hard to beat for
	 * uninteresting reasons.
	 */
	mean_truth_position: number;
	verdict: "beats_baselines" | "matches_baselines" | "below_baselines" | "no_cases";
};

/** Lift below this is treated as indistinguishable from the baseline. */
export const LIFT_TOLERANCE = 0.02;

export function scoreCases(
	cases: AttributionCase[],
	predictions: AttributionPrediction[],
	opts: { tolerance?: number } = {},
): AttributionScore[] {
	const byId = new Map(predictions.map((p) => [p.case_id, p]));
	return cases.map((c) =>
		scoreAttribution(
			c,
			byId.get(c.case_id) ?? AttributionPredictionSchema.parse({ case_id: c.case_id }),
			opts,
		),
	);
}

export function attributionReport(
	cases: AttributionCase[],
	predictions: AttributionPrediction[],
	opts: { tolerance?: number } = {},
): AttributionReport {
	const scores = scoreCases(cases, predictions, opts);
	const system = summarizeScores(scores);
	const lastStep = summarizeScores(scoreCases(cases, cases.map(lastStepBaseline), opts));
	const firstError = summarizeScores(scoreCases(cases, cases.map(firstErrorBaseline), opts));

	const bestBaseline = Math.max(lastStep.joint_accuracy, firstError.joint_accuracy);
	const lift = system.joint_accuracy - bestBaseline;

	const byDomain = ATTRIBUTION_DOMAINS.map((domain) => {
		const subset = scores.filter((s) => s.domain === domain);
		return { domain, ...summarizeScores(subset) };
	}).filter((entry) => entry.cases > 0);

	let verdict: AttributionReport["verdict"];
	if (cases.length === 0) verdict = "no_cases";
	else if (lift > LIFT_TOLERANCE) verdict = "beats_baselines";
	else if (lift < -LIFT_TOLERANCE) verdict = "below_baselines";
	else verdict = "matches_baselines";

	return {
		schema_version: ATTRIBUTION_BENCH_VERSION,
		system,
		baselines: { last_step: lastStep, first_error: firstError },
		joint_lift_over_best_baseline: lift,
		by_domain: byDomain,
		mean_truth_position: mean(scores.map((s) => s.step.truth_position)),
		verdict,
	};
}

export type CaseIssue = { case_id: string; problem: string };

/**
 * Reject corpora that cannot produce meaningful attribution scores.
 *
 * The step-index checks matter most: a ground truth pointing outside the
 * trajectory, or a trajectory with non-contiguous indices, makes every distance
 * metric meaningless while still producing numbers.
 */
export function validateCases(cases: AttributionCase[]): CaseIssue[] {
	const issues: CaseIssue[] = [];
	const seen = new Set<string>();
	for (const c of cases) {
		if (seen.has(c.case_id)) issues.push({ case_id: c.case_id, problem: "duplicate case_id" });
		seen.add(c.case_id);

		const indices = c.steps.map((s) => s.index);
		const contiguous = indices.every((index, i) => index === i);
		if (!contiguous) {
			issues.push({ case_id: c.case_id, problem: "step indices are not contiguous from 0" });
		}

		const valid = new Set(indices);
		if (!valid.has(c.ground_truth.step_index)) {
			issues.push({
				case_id: c.case_id,
				problem: `ground-truth step ${c.ground_truth.step_index} is outside the trajectory`,
			});
		}
		const truthStep = c.steps.find((s) => s.index === c.ground_truth.step_index);
		if (truthStep && truthStep.agent !== c.ground_truth.agent) {
			issues.push({
				case_id: c.case_id,
				problem: `ground-truth agent '${c.ground_truth.agent}' does not own step ${c.ground_truth.step_index} (owned by '${truthStep.agent}')`,
			});
		}
		for (const index of c.ground_truth.evidence_steps) {
			if (!valid.has(index)) {
				issues.push({
					case_id: c.case_id,
					problem: `evidence step ${index} is outside the trajectory`,
				});
			}
		}
		if (c.ground_truth.evidence_steps.length === 0) {
			issues.push({
				case_id: c.case_id,
				problem: "no evidence steps: sufficiency cannot be scored",
			});
		}
	}
	return issues;
}

type Row = Record<string, unknown>;

/**
 * Normalize exported multi-agent trajectory rows into cases.
 *
 * Rows missing an attributable agent/step are skipped rather than defaulted:
 * defaulting to the last step would silently manufacture cases that the
 * last-step baseline scores perfectly, which is precisely the bias this module
 * is built to detect.
 */
export function fromTrajectoryRows(rows: Row[]): AttributionCase[] {
	const cases: AttributionCase[] = [];
	for (const row of rows) {
		const parsed = AttributionCaseSchema.safeParse({
			case_id: row.case_id ?? row.id,
			domain: row.domain,
			steps: Array.isArray(row.steps)
				? (row.steps as Row[]).map((s, i) => ({
						index: typeof s.index === "number" ? s.index : i,
						agent: s.agent ?? s.role,
						action: s.action ?? s.name ?? "",
						observation: s.observation ?? s.output ?? "",
						ok: s.ok !== false && s.error === undefined,
					}))
				: [],
			ground_truth: {
				agent: (row.ground_truth as Row | undefined)?.agent ?? row.failing_agent,
				step_index: (row.ground_truth as Row | undefined)?.step_index ?? row.failing_step,
				evidence_steps:
					(row.ground_truth as Row | undefined)?.evidence_steps ?? row.evidence_steps ?? [],
				recovery: (row.ground_truth as Row | undefined)?.recovery ?? row.recovery,
			},
		});
		if (parsed.success) cases.push(parsed.data);
	}
	return cases;
}
