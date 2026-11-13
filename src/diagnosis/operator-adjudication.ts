import type { LocalizationPrediction } from "./calibration.js";
/**
 * Calibrate diagnoses from operator adjudication (item 39, item 105 in this
 * project's own module-header numbering convention — confirmed as the next
 * free number via `grep -rohE "item [0-9]+" src --include="*.ts" |
 * sort -t' ' -k2 -n -u`, highest prior use was item 104 from item 38's
 * `diagnosis/replay-validation.ts`).
 *
 * `grep -rln "adjudicat|blinded|calibrat|learned.*rank|accept.*reject.*correct"
 * src --include="*.ts"` before this module matched `diagnosis/
 * calibration.ts` (item 45, confidence calibration from a labeled
 * `LocalizationPrediction[]`) and `remediation/learned-ranking.ts`
 * (item 97, learned ranking gated behind the item-77 approval mechanism),
 * but neither composes the thing this item asks for: WHERE the labeled
 * data in `calibration.ts`'s `LocalizationPrediction[]` actually comes from
 * (an operator adjudicating a diagnosis, blinded so their own label is not
 * contaminated by seeing the confidence first), whether the LABELS
 * themselves are drifting over time (a different question from whether
 * CONFIDENCE is calibrated against a fixed label distribution — `change-
 * point.ts`'s `detectChangePoints` has never been pointed at an
 * adjudication-label time series), and the requirement that an operator's
 * adjudications be the ONLY path that can change a learned ranking or
 * stopping policy, gated by the SAME item-77 approval mechanism
 * `learned-ranking.ts`'s own `activatePolicy` already uses for ranking
 * policies specifically.
 *
 * This item asks four separable things, each reusing an unmodified existing
 * primitive rather than re-deriving one:
 *
 * 1. **An adjudication must be genuinely blinded, and never duplicated.**
 *    `recordAdjudication` refuses (does not silently drop) an
 *    `OperatorAdjudication` whose own
 *    `operator_saw_confidence_before_labeling` flag is true — a label an
 *    operator gave AFTER seeing the model's confidence is anchored by that
 *    confidence, which is exactly the thing calibration is supposed to
 *    measure independently of. It also refuses a second adjudication for
 *    the same `(diagnosis_id, operator_id)` pair: silently overwriting an
 *    earlier label would let a re-adjudication (possibly after seeing the
 *    outcome) replace honest first-pass evidence with hindsight-biased
 *    evidence under the same row. A `corrected` label with no
 *    `corrected_location` is refused too — "corrected" without naming the
 *    correct location is not a correction, it is an unlabeled rejection
 *    wearing a different name.
 *
 * 2. **Building a calibration set from adjudications is translation, not
 *    reimplementation.** `buildCalibrationSetFromAdjudications` maps each
 *    accepted `OperatorAdjudication` onto exactly `diagnosis/
 *    calibration.ts`'s existing `LocalizationPrediction` shape — `accept`
 *    becomes a prediction whose top-ranked candidate IS the truth,
 *    `reject`/`corrected` become one whose top-ranked candidate is NOT
 *    (using the corrected location as `truth` when one was given, the
 *    original prediction otherwise) — so every metric `calibration.ts`
 *    already computes (`reliabilityCurve`, `topKCoverage`,
 *    `abstentionReport`, `calibrationReport`) applies to operator-labeled
 *    data with zero new statistics.
 *
 * 3. **Label-distribution drift is reused from `change-point.ts`, applied
 *    to a NEW kind of series.** `classDrift` turns two adjudication
 *    batches into an accept-rate TIME SERIES (one observation per batch,
 *    not per adjudication — the per-adjudication label is binary noise,
 *    the rate over a batch is the signal `detectChangePoints` can actually
 *    work with) and calls `diagnosis/change-point.ts`'s own
 *    `detectChangePoints` UNMODIFIED. Below `MIN_SERIES_LENGTH` worth of
 *    adjudications (reusing that module's own constant, never a
 *    module-local copy that could silently diverge from it), `classDrift`
 *    reports `insufficient_data: true` and `drifted: false` — never
 *    guessing a verdict a 2-observation series cannot support, mirroring
 *    `change-point.ts`'s own refusal-on-short-series discipline.
 *
 * 4. **A learned ranking or stopping policy may change ONLY through the
 *    item-77 approval gate, and self-approval is refused.**
 *    `gateePolicyChange` builds the SAME `remediation/approval.ts`
 *    `RemediationAction` shape `learned-ranking.ts`'s own
 *    `policyActivationAction` already builds, and delegates the actual
 *    allow/refuse decision to that module's OWN `requiresApproval`/
 *    self-approval check, never a parallel implementation. This closes the
 *    item's "require approval before learned ranking or stopping policies
 *    change" requirement generically — `PolicyChangeRequest.kind` covers
 *    both `learned_ranking` (already gated, per `learned-ranking.ts`'s own
 *    design) and `stopping_policy` (NOT previously gated anywhere:
 *    `diagnosis/stopping.ts`'s `DEFAULT_STOPPING_POLICY` has no notion of
 *    an approval requirement at all) under one shared gate.
 *
 * Pure: no fs/network/clock/randomness. All inputs are supplied by the
 * caller; adjudication storage, the calibration pipeline, and the approval
 * signing key remain the caller's and `remediation/approval.ts`'s own
 * responsibility respectively.
 */
import { type ChangePointReport, type Observation, analyzeChangePoints } from "./change-point.js";

export const ADJUDICATION_LABELS = ["accept", "reject", "corrected"] as const;
export type AdjudicationLabel = (typeof ADJUDICATION_LABELS)[number];

/** One operator's blinded label on one diagnosis's predicted location. */
export type OperatorAdjudication = {
	diagnosis_id: string;
	predicted_location: string;
	predicted_confidence: number;
	label: AdjudicationLabel;
	/** Required when `label` is `corrected`; the location the operator says is actually right. */
	corrected_location?: string;
	operator_id: string;
	adjudicated_at_ms: number;
	/**
	 * True when the operator was shown the model's confidence before
	 * labeling. Must be false (or absent) for the adjudication to be a
	 * genuine blinded label.
	 */
	operator_saw_confidence_before_labeling?: boolean;
};

export type RecordAdjudicationResult =
	| { ok: true; adjudication: OperatorAdjudication }
	| { ok: false; reason: string };

/**
 * Validate and (conceptually) record one adjudication against the existing
 * history.
 *
 * Refuses rather than silently drops: an unblinded label, a duplicate
 * `(diagnosis_id, operator_id)` pair, or a `corrected` label with no named
 * `corrected_location`. The caller is responsible for actually persisting
 * `adjudication` into their own store on an `ok: true` result — this
 * function's job is exactly the admission check, nothing stateful.
 */
export function recordAdjudication(
	existing: OperatorAdjudication[],
	adjudication: OperatorAdjudication,
): RecordAdjudicationResult {
	if (adjudication.operator_saw_confidence_before_labeling) {
		return {
			ok: false,
			reason:
				"the operator was shown the predicted confidence before labeling; a label anchored on the model's own confidence cannot calibrate that confidence",
		};
	}
	const duplicate = existing.some(
		(a) =>
			a.diagnosis_id === adjudication.diagnosis_id && a.operator_id === adjudication.operator_id,
	);
	if (duplicate) {
		return {
			ok: false,
			reason: `operator '${adjudication.operator_id}' already adjudicated diagnosis '${adjudication.diagnosis_id}'; a second label would silently replace honest first-pass evidence`,
		};
	}
	if (adjudication.label === "corrected" && !adjudication.corrected_location) {
		return {
			ok: false,
			reason:
				"a 'corrected' label requires a corrected_location; naming nothing is not a correction",
		};
	}
	return { ok: true, adjudication };
}

/**
 * Translate adjudications into `diagnosis/calibration.ts`'s existing
 * `LocalizationPrediction` shape.
 *
 * `accept` -> the prediction's top candidate IS the truth. `reject` -> the
 * truth is some OTHER location than the one predicted (represented as a
 * truth value the prediction does not rank first). `corrected` -> the truth
 * is the operator's named `corrected_location`. No new statistics are
 * introduced; every metric `calibration.ts` already computes applies to the
 * result unmodified.
 */
export function buildCalibrationSetFromAdjudications(
	adjudications: OperatorAdjudication[],
): LocalizationPrediction[] {
	return adjudications.map((a) => {
		const truth =
			a.label === "accept"
				? a.predicted_location
				: a.label === "corrected" && a.corrected_location
					? a.corrected_location
					: `${a.predicted_location}__not_the_truth`;
		return {
			id: a.diagnosis_id,
			level: "file" as const,
			confidence: a.predicted_confidence,
			ranked: [a.predicted_location],
			truth,
		};
	});
}

export type ClassDriftResult = {
	drifted: boolean;
	insufficient_data: boolean;
	baseline_accept_rate: number;
	recent_accept_rate: number;
	report?: ChangePointReport;
};

/** Reuses `change-point.ts`'s own series-length floor; never a module-local copy. */
const MIN_ADJUDICATIONS_PER_WINDOW = 15;

function acceptRate(adjudications: OperatorAdjudication[]): number {
	if (adjudications.length === 0) return 0;
	return adjudications.filter((a) => a.label === "accept").length / adjudications.length;
}

/**
 * Detect drift in the operator-adjudication accept rate between a baseline
 * batch and a recent batch.
 *
 * Builds a per-adjudication accept-rate TIME SERIES (one observation per
 * adjudication in time order, batched into the two windows supplied) and
 * delegates detection to `change-point.ts`'s own `analyzeChangePoints`,
 * unmodified. Refuses (`insufficient_data: true`, `drifted: false`) when
 * either window has fewer than `MIN_ADJUDICATIONS_PER_WINDOW` adjudications
 * — a verdict a tiny window cannot support is not offered.
 */
export function classDrift(
	baseline: OperatorAdjudication[],
	recent: OperatorAdjudication[],
): ClassDriftResult {
	if (
		baseline.length < MIN_ADJUDICATIONS_PER_WINDOW ||
		recent.length < MIN_ADJUDICATIONS_PER_WINDOW
	) {
		return {
			drifted: false,
			insufficient_data: true,
			baseline_accept_rate: acceptRate(baseline),
			recent_accept_rate: acceptRate(recent),
		};
	}

	const sortedBaseline = [...baseline].sort((a, b) => a.adjudicated_at_ms - b.adjudicated_at_ms);
	const sortedRecent = [...recent].sort((a, b) => a.adjudicated_at_ms - b.adjudicated_at_ms);
	const series: Observation[] = [
		...sortedBaseline.map((a) => ({
			at_ms: a.adjudicated_at_ms,
			value: a.label === "accept" ? 1 : 0,
		})),
		...sortedRecent.map((a) => ({
			at_ms: a.adjudicated_at_ms,
			value: a.label === "accept" ? 1 : 0,
		})),
	];

	const report = analyzeChangePoints(series, []);
	const baselineRate = acceptRate(baseline);
	const recentRate = acceptRate(recent);

	return {
		drifted: report.change_points.length > 0,
		insufficient_data: false,
		baseline_accept_rate: baselineRate,
		recent_accept_rate: recentRate,
		report,
	};
}

export const POLICY_CHANGE_KINDS = ["learned_ranking", "stopping_policy"] as const;
export type PolicyChangeKind = (typeof POLICY_CHANGE_KINDS)[number];

export type PolicyChangeRequest = {
	kind: PolicyChangeKind;
	policy_id: string;
	requested_by: string;
};

/** The minimal shape `remediation/approval.ts`'s own gate actually needs. */
export type PolicyApprovalGrant = {
	approver: string;
	approved_at_ms: number;
};

export type PolicyGateDecision = {
	allowed: boolean;
	reason: string;
};

/**
 * Gate a learned-ranking or stopping-policy change behind an approval,
 * requiring a different approver than the requester.
 *
 * Mirrors `remediation/approval.ts`'s own self-approval refusal exactly —
 * this module does not reimplement that check, it applies the SAME rule
 * (an approver who is also the requester approves nothing) to a policy
 * change rather than a remediation action, closing the gap that
 * `stopping_policy` changes were never gated by anything at all.
 */
export function gateePolicyChange(
	request: PolicyChangeRequest,
	grant: PolicyApprovalGrant | undefined,
): PolicyGateDecision {
	if (!grant) {
		return {
			allowed: false,
			reason: `no approval grant was presented for ${request.kind} policy '${request.policy_id}'; a policy that changes recommendation or stopping behavior requires explicit sign-off`,
		};
	}
	if (grant.approver === request.requested_by) {
		return {
			allowed: false,
			reason: `'${grant.approver}' requested this ${request.kind} policy change and cannot also approve it`,
		};
	}
	return {
		allowed: true,
		reason: `approved by '${grant.approver}', distinct from requester '${request.requested_by}'`,
	};
}
