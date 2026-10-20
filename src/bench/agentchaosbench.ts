/**
 * AgentChaosBench-compatible telemetry fault evaluator (item 99).
 *
 * AgentChaosBench (arxiv.org/abs/2608.14680) asks a detector two questions
 * about recorded agent telemetry — a trace, or several traces of the same
 * underlying run captured from different vantage points — that this repo's
 * existing tooling answers only partially:
 *
 *   1. **Fault-type accuracy**: which *kind* of runtime fault actually
 *      occurred (a tool crash, a guardrail bypass, a reference-dependent
 *      fault that only manifests relative to a prior turn, etc.)?
 *   2. **Exact-location accuracy**: *which recorded span* is where the fault
 *      actually happened, not merely where it was first observed?
 *
 * `fault-localization.ts` (item 7) already answers a related but different
 * question — *why* a trace failed, found by ablation — and this module does
 * not re-implement that search. AgentChaosBench's ground truth is already
 * known (it is a labeled benchmark corpus); the job here is purely **scoring**
 * a detector's prediction against that known label, the same division of
 * labor `kernel-diagnosis.ts`/`service-diagnosis.ts` (items 44/51) already
 * use for their own labeled corpora.
 *
 * Three properties this scorer is built to get right, each the subject of a
 * named hazard in the source paper:
 *
 * 1. **Guardrail-bypass faults are a fault *type*, not a lesser case of
 *    "no fault was raised".** A detector that reports `none` whenever no
 *    exception surfaced would score every guardrail bypass as a true
 *    negative — exactly the "quiet, healthy-looking system that is in fact
 *    blind" failure mode `chaos.ts` already names for telemetry loss. The
 *    fault-type ladder treats `guardrail_bypass` as a first-class label a
 *    detector must name explicitly, not a residual of an absent exception.
 *
 * 2. **Reference-dependent faults need multi-trace input, and a single-trace
 *    detector run on them should score as abstention, not as a wrong
 *    answer.** Some AgentChaosBench cases are only detectable by diffing the
 *    current trace against a reference trace of the same task succeeding
 *    (e.g. a tool call silently returning stale cached data instead of a
 *    fresh result). A single-trace prediction on such a case is scored
 *    `insufficient_evidence`, counted separately from `wrong`, because
 *    "the detector had no way to know" and "the detector guessed and
 *    missed" are different failure modes and conflating them (as a flat
 *    accuracy would) rewards a detector for not trying.
 *
 * 3. **Exact-location accuracy is scored independently of fault-type
 *    accuracy**, following `service-diagnosis.ts`'s own "never combine
 *    separate axes into one number" rule — a detector that names the right
 *    fault type on the wrong span, or the right span with the wrong fault
 *    type, is a real and distinguishable partial success that a single
 *    composite score would hide.
 *
 * Pure: no network, no dataset download, no corpus shipped in the repo or a
 * release tar — a user supplies case rows however they obtained them, the
 * same posture `manifest.ts`/`kernel-diagnosis.ts` already take.
 */
import { z } from "zod";

export const AGENTCHAOSBENCH_VERSION = "0.1";

/** The fault-type vocabulary. `none` is a real label — a clean trace is a case too. */
export const FAULT_TYPES = [
	"none",
	"tool_crash",
	"tool_timeout",
	"tool_wrong_result",
	"guardrail_bypass",
	"reference_dependent",
	"hallucinated_tool_call",
	"infinite_loop",
	"context_corruption",
] as const;
export const FaultTypeSchema = z.enum(FAULT_TYPES);
export type FaultType = z.infer<typeof FaultTypeSchema>;

/** Fault types whose ground truth can only be established by comparing against a reference trace. */
export const REFERENCE_DEPENDENT_FAULT_TYPES: ReadonlySet<FaultType> = new Set([
	"reference_dependent",
]);

export const SpanRefSchema = z.object({
	trace_id: z.string().min(1),
	span_id: z.string().min(1),
});
export type SpanRef = z.infer<typeof SpanRefSchema>;

/** One recorded span, trimmed to what the evaluator and a detector both need. */
export const TelemetrySpanSchema = z.object({
	trace_id: z.string().min(1),
	span_id: z.string().min(1),
	name: z.string().min(1),
	kind: z.enum(["agent", "llm", "tool", "guardrail", "retrieval"]),
	status: z.enum(["ok", "error"]),
	start_ms: z.number().nonnegative(),
	duration_ms: z.number().nonnegative(),
});
export type TelemetrySpan = z.infer<typeof TelemetrySpanSchema>;

/**
 * One AgentChaosBench case. `reference_trace_id`, when present, names a
 * second trace in the same corpus the detector may diff against; its absence
 * is itself informative (the case has no reference to diff against, so a
 * reference-dependent fault type as ground truth would be a corpus error —
 * `validateChaosBenchCase` catches that).
 */
export const ChaosBenchCaseSchema = z.object({
	case_id: z.string().min(1),
	trace: z.array(TelemetrySpanSchema).min(1),
	/** A second trace of the same task, for reference-dependent cases. Absent when none exists. */
	reference_trace: z.array(TelemetrySpanSchema).optional(),
	ground_truth: z.object({
		fault_type: FaultTypeSchema,
		/** Null exactly when `fault_type === "none"`. */
		fault_span: SpanRefSchema.nullable(),
	}),
});
export type ChaosBenchCase = z.infer<typeof ChaosBenchCaseSchema>;

export const ChaosBenchSuiteSchema = z.object({
	schema_version: z.literal(AGENTCHAOSBENCH_VERSION),
	cases: z.array(ChaosBenchCaseSchema).min(1),
});
export type ChaosBenchSuite = z.infer<typeof ChaosBenchSuiteSchema>;

export interface ChaosBenchValidation {
	ok: boolean;
	problems: string[];
}

/**
 * Catch corpus-authoring errors before they corrupt a score: a
 * `reference_dependent` ground truth with no `reference_trace` supplied is
 * unanswerable by construction, and a non-`none` fault type with a null
 * `fault_span` (or vice versa) is an internally inconsistent label.
 */
export function validateChaosBenchCase(c: ChaosBenchCase): ChaosBenchValidation {
	const problems: string[] = [];
	if (REFERENCE_DEPENDENT_FAULT_TYPES.has(c.ground_truth.fault_type) && !c.reference_trace) {
		problems.push(
			`case ${c.case_id}: ground truth fault_type '${c.ground_truth.fault_type}' requires a reference_trace, none supplied`,
		);
	}
	if (c.ground_truth.fault_type === "none" && c.ground_truth.fault_span !== null) {
		problems.push(`case ${c.case_id}: fault_type 'none' must have a null fault_span`);
	}
	if (c.ground_truth.fault_type !== "none" && c.ground_truth.fault_span === null) {
		problems.push(
			`case ${c.case_id}: fault_type '${c.ground_truth.fault_type}' must have a non-null fault_span`,
		);
	}
	if (c.ground_truth.fault_span) {
		const found = c.trace.some(
			(s) =>
				s.trace_id === c.ground_truth.fault_span?.trace_id &&
				s.span_id === c.ground_truth.fault_span?.span_id,
		);
		if (!found)
			problems.push(`case ${c.case_id}: fault_span does not name a span present in trace`);
	}
	return { ok: problems.length === 0, problems };
}

export function validateChaosBenchSuite(suite: ChaosBenchSuite): ChaosBenchValidation {
	const problems = suite.cases.flatMap((c) => validateChaosBenchCase(c).problems);
	return { ok: problems.length === 0, problems };
}

// ── Predictions ──

/**
 * One detector's prediction for one case. `used_reference_trace` records
 * whether the detector was actually given (and reports having used) the
 * reference trace for this case — a prediction on a reference-dependent case
 * made *without* it is scored as abstention regardless of what the detector
 * guessed, per the module's second design hazard.
 */
export const ChaosBenchPredictionSchema = z.object({
	case_id: z.string().min(1),
	fault_type: FaultTypeSchema,
	fault_span: SpanRefSchema.nullable(),
	used_reference_trace: z.boolean().default(false),
});
export type ChaosBenchPrediction = z.infer<typeof ChaosBenchPredictionSchema>;

// ── Scoring one case ──

export type CaseVerdict = "correct" | "wrong" | "insufficient_evidence";

export interface ChaosBenchCaseScore {
	case_id: string;
	ground_truth_fault_type: FaultType;
	predicted_fault_type: FaultType;
	fault_type_verdict: CaseVerdict;
	/**
	 * Only meaningful when ground truth has a non-null `fault_span`; `null`
	 * for `fault_type === "none"` cases (there is nothing to localize).
	 */
	location_verdict: CaseVerdict | null;
	/** True when this case's ground truth required a reference trace. */
	reference_dependent: boolean;
	/** True when `guardrail_bypass` is the ground truth, tracked for its own ladder (hazard 1). */
	is_guardrail_bypass: boolean;
}

function spanRefEqual(a: SpanRef | null, b: SpanRef | null): boolean {
	if (a === null || b === null) return a === b;
	return a.trace_id === b.trace_id && a.span_id === b.span_id;
}

/**
 * Score one prediction against one case's ground truth. Never re-derives the
 * ground truth and never runs a detector itself — this is pure comparison.
 */
export function scoreChaosBenchCase(
	c: ChaosBenchCase,
	prediction: ChaosBenchPrediction,
): ChaosBenchCaseScore {
	const referenceDependent = REFERENCE_DEPENDENT_FAULT_TYPES.has(c.ground_truth.fault_type);
	const isGuardrailBypass = c.ground_truth.fault_type === "guardrail_bypass";

	// Hazard 2: a reference-dependent case scored by a detector that did not
	// use the reference trace is insufficient evidence, never "wrong" --
	// whatever the detector guessed, it had no basis for an answer.
	const abstainedForMissingReference = referenceDependent && !prediction.used_reference_trace;

	const faultTypeVerdict: CaseVerdict = abstainedForMissingReference
		? "insufficient_evidence"
		: prediction.fault_type === c.ground_truth.fault_type
			? "correct"
			: "wrong";

	let locationVerdict: CaseVerdict | null = null;
	if (c.ground_truth.fault_span !== null) {
		locationVerdict = abstainedForMissingReference
			? "insufficient_evidence"
			: spanRefEqual(prediction.fault_span, c.ground_truth.fault_span)
				? "correct"
				: "wrong";
	}

	return {
		case_id: c.case_id,
		ground_truth_fault_type: c.ground_truth.fault_type,
		predicted_fault_type: prediction.fault_type,
		fault_type_verdict: faultTypeVerdict,
		location_verdict: locationVerdict,
		reference_dependent: referenceDependent,
		is_guardrail_bypass: isGuardrailBypass,
	};
}

// ── Aggregation ──

function rate(scores: readonly CaseVerdict[], want: CaseVerdict): number {
	if (scores.length === 0) return 0;
	return scores.filter((v) => v === want).length / scores.length;
}

/**
 * Accuracy computed over *resolved* cases only (excludes `insufficient_evidence`
 * from the denominator) -- separate from the raw rate, which counts
 * abstention against the detector the way a benchmark leaderboard should,
 * following `kernel-diagnosis.ts`'s own abstention-rate precedent of
 * reporting abstention as its own number rather than folding it into
 * accuracy either way.
 */
function resolvedAccuracy(scores: readonly CaseVerdict[]): number {
	const resolved = scores.filter((v) => v !== "insufficient_evidence");
	if (resolved.length === 0) return 0;
	return resolved.filter((v) => v === "correct").length / resolved.length;
}

export interface ChaosBenchReport {
	schema_version: typeof AGENTCHAOSBENCH_VERSION;
	cases: number;
	fault_type: {
		accuracy: number;
		insufficient_evidence_rate: number;
		resolved_accuracy: number;
	};
	location: {
		/** Over the subset of cases with a non-null ground-truth fault_span. */
		accuracy: number;
		insufficient_evidence_rate: number;
		resolved_accuracy: number;
		scored_cases: number;
	};
	/** Hazard 1: guardrail-bypass cases scored on their own, so they cannot hide inside the overall rate. */
	guardrail_bypass: {
		cases: number;
		fault_type_accuracy: number;
	};
	/** Hazard 2: reference-dependent cases scored on their own. */
	reference_dependent: {
		cases: number;
		fault_type_accuracy: number;
		insufficient_evidence_rate: number;
	};
	/** `fault_type_verdict === "correct" && location_verdict !== "wrong"`, named apart per the service-diagnosis separate-axes rule. */
	joint_correct_rate: number;
	per_case: ChaosBenchCaseScore[];
}

/**
 * Aggregate scored cases into the full report. Fault-type and location
 * accuracy are reported as entirely separate sections (never combined into
 * one score), matching `service-diagnosis.ts`'s own discipline.
 */
export function aggregateChaosBench(scores: ChaosBenchCaseScore[]): ChaosBenchReport {
	const faultTypeVerdicts = scores.map((s) => s.fault_type_verdict);
	const locatable = scores.filter((s) => s.location_verdict !== null);
	const locationVerdicts = locatable.map((s) => s.location_verdict as CaseVerdict);

	const guardrailCases = scores.filter((s) => s.is_guardrail_bypass);
	const referenceCases = scores.filter((s) => s.reference_dependent);

	const jointCorrect = scores.filter(
		(s) =>
			s.fault_type_verdict === "correct" &&
			(s.location_verdict === null || s.location_verdict !== "wrong"),
	);

	return {
		schema_version: AGENTCHAOSBENCH_VERSION,
		cases: scores.length,
		fault_type: {
			accuracy: rate(faultTypeVerdicts, "correct"),
			insufficient_evidence_rate: rate(faultTypeVerdicts, "insufficient_evidence"),
			resolved_accuracy: resolvedAccuracy(faultTypeVerdicts),
		},
		location: {
			accuracy: rate(locationVerdicts, "correct"),
			insufficient_evidence_rate: rate(locationVerdicts, "insufficient_evidence"),
			resolved_accuracy: resolvedAccuracy(locationVerdicts),
			scored_cases: locatable.length,
		},
		guardrail_bypass: {
			cases: guardrailCases.length,
			fault_type_accuracy: rate(
				guardrailCases.map((s) => s.fault_type_verdict),
				"correct",
			),
		},
		reference_dependent: {
			cases: referenceCases.length,
			fault_type_accuracy: rate(
				referenceCases.map((s) => s.fault_type_verdict),
				"correct",
			),
			insufficient_evidence_rate: rate(
				referenceCases.map((s) => s.fault_type_verdict),
				"insufficient_evidence",
			),
		},
		joint_correct_rate: scores.length === 0 ? 0 : jointCorrect.length / scores.length,
		per_case: scores,
	};
}

/** Score and aggregate a full suite of predictions in one call. Throws if a prediction's case_id is unknown. */
export function scoreChaosBenchSuite(
	suite: ChaosBenchSuite,
	predictions: ChaosBenchPrediction[],
): ChaosBenchReport {
	const byId = new Map(suite.cases.map((c) => [c.case_id, c]));
	const scores = predictions.map((p) => {
		const c = byId.get(p.case_id);
		if (!c) throw new Error(`prediction references unknown case_id '${p.case_id}'`);
		return scoreChaosBenchCase(c, p);
	});
	return aggregateChaosBench(scores);
}

export function renderChaosBenchReport(report: ChaosBenchReport): string[] {
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	const lines: string[] = [];
	lines.push(`AgentChaosBench report — ${report.cases} case(s)`);
	lines.push(
		`  fault-type: accuracy=${pct(report.fault_type.accuracy)} resolved_accuracy=${pct(report.fault_type.resolved_accuracy)} insufficient_evidence=${pct(report.fault_type.insufficient_evidence_rate)}`,
	);
	lines.push(
		`  location (${report.location.scored_cases} scorable): accuracy=${pct(report.location.accuracy)} resolved_accuracy=${pct(report.location.resolved_accuracy)} insufficient_evidence=${pct(report.location.insufficient_evidence_rate)}`,
	);
	lines.push(
		`  guardrail_bypass (${report.guardrail_bypass.cases} case(s)): fault_type_accuracy=${pct(report.guardrail_bypass.fault_type_accuracy)}`,
	);
	lines.push(
		`  reference_dependent (${report.reference_dependent.cases} case(s)): fault_type_accuracy=${pct(report.reference_dependent.fault_type_accuracy)} insufficient_evidence=${pct(report.reference_dependent.insufficient_evidence_rate)}`,
	);
	lines.push(`  joint correct rate: ${pct(report.joint_correct_rate)}`);
	return lines;
}
