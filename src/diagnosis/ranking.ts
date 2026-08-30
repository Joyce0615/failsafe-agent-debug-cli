/**
 * Root-cause ranking with calibrated confidence and explicit contradictory
 * evidence (item 60).
 *
 * Most ranking code computes one number per candidate and sorts. That loses
 * three things that a person reading the output needs, and this module keeps
 * all three:
 *
 * 1. **Contradictory evidence is a field, not a subtraction.** A candidate with
 *    five supports and three contradictions is a genuinely different situation
 *    from one with two supports and none, even when the arithmetic lands on the
 *    same score. Netting them produces a number that cannot be argued with
 *    because the disagreement has been erased. `RankedCause` carries
 *    `contradicting` explicitly and the renderer always prints it.
 *
 * 2. **There is a residual.** Confidence is a normalized posterior over the
 *    candidate set *plus* an explicit "none of these", so a set of weak
 *    candidates produces a weak leader rather than a confident one. Normalizing
 *    over the candidates alone is why so much diagnostic tooling reports 87%
 *    confidence in its best guess when its best guess is bad: with three poor
 *    options, one of them still has to get most of the mass.
 *
 * 3. **The margin is reported.** A 0.51 / 0.49 split is not a diagnosis, it is
 *    a coin flip with a decimal point. `decisive` requires both a minimum
 *    leader confidence and a minimum margin over the runner-up, and says which
 *    of the two failed.
 *
 * Confidence is passed through the item-45 histogram calibrator when a
 * calibration map is supplied, so the number reported is one that has been
 * checked against outcomes rather than asserted.
 *
 * Pure: no I/O.
 */
import { type CalibrationMap, applyCalibration } from "./calibration.js";

/** How evidence bears on a candidate. */
export type EvidenceStance = "supports" | "contradicts";

export type RankingEvidence = {
	id: string;
	stance: EvidenceStance;
	/**
	 * How much this observation moves belief, in [0,1]. This is the *strength of
	 * the observation*, not a probability of the candidate.
	 */
	weight: number;
	/**
	 * How much the source itself can be trusted, in [0,1]. Kept separate from
	 * weight because "a strong signal from a flaky source" and "a weak signal
	 * from a reliable one" are different, and multiplying them together at the
	 * point of entry would make them indistinguishable afterwards.
	 */
	reliability: number;
	description: string;
	/**
	 * A contradiction marked decisive vetoes the candidate outright rather than
	 * reducing its score. Reserved for observations that are logically
	 * incompatible with the hypothesis — the file does not exist, the code path
	 * was never entered — not merely for strong ones.
	 */
	decisive?: boolean;
};

export type CauseCandidate = {
	id: string;
	summary: string;
	/** Prior belief before this evidence, in (0,1). Defaults to uniform. */
	prior?: number;
	evidence: RankingEvidence[];
};

export type RankedCause = {
	id: string;
	summary: string;
	confidence: number;
	/** Confidence before calibration, so the correction is auditable. */
	raw_confidence: number;
	supporting: RankingEvidence[];
	contradicting: RankingEvidence[];
	/** Sum of weight × reliability over supporting evidence. */
	support_score: number;
	/** Same over contradicting evidence. Never netted against support. */
	contradiction_score: number;
	vetoed: boolean;
	veto_reason?: string;
};

export type Ranking = {
	causes: RankedCause[];
	/**
	 * Probability that none of the candidates is the cause. Reported as a
	 * first-class member of the distribution, not as leftover.
	 */
	residual: number;
	/** Leader confidence minus runner-up confidence. */
	margin: number;
	decisive: boolean;
	/** Present exactly when `decisive` is false. */
	indecision_reason?: string;
	vetoed: RankedCause[];
	caveats: string[];
};

/**
 * Leader confidence required before a diagnosis is called decisive.
 *
 * Below half on purpose: with a live residual in the distribution, an
 * explanation that holds more belief than "none of these" and comfortably more
 * than its nearest rival has earned a look, and demanding an outright majority
 * would make two well-supported competing hypotheses indistinguishable from no
 * hypothesis at all.
 */
export const MIN_LEADER_CONFIDENCE = 0.45;
/** Required gap between the leader and the runner-up. */
export const MIN_MARGIN = 0.15;

/**
 * Evidence mass at which a candidate is considered fully explained.
 *
 * Used to scale raw support into an unnormalized likelihood. Set so that a
 * single strong, reliable observation is suggestive but not conclusive — one
 * log line agreeing with a hypothesis should not end an investigation.
 */
export const SATURATION = 2.5;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function scoreOf(evidence: RankingEvidence[]): number {
	return evidence.reduce((sum, e) => sum + clamp01(e.weight) * clamp01(e.reliability), 0);
}

/**
 * Unnormalized likelihood of a candidate given its evidence.
 *
 * Support saturates: the second and third confirming observation are worth less
 * than the first, because they are usually the same fact reported twice.
 * Contradiction is applied multiplicatively and does *not* saturate, so
 * accumulating disagreement keeps costing — which is the asymmetry that stops a
 * candidate from being argued into place by volume of weak support.
 */
export function likelihood(candidate: CauseCandidate): number {
	const prior = candidate.prior !== undefined ? clamp01(candidate.prior) : 0.5;
	return Math.max(1e-9, prior * fit(candidate));
}

/**
 * How well the evidence is explained by this candidate, independent of prior.
 *
 * Separated from `likelihood` because the residual is computed from *fit*, not
 * from posterior mass. Folding the prior into the residual would mean a lone
 * candidate could never exceed its own prior no matter how completely it
 * explained everything, which is a bug that looks like caution.
 */
export function fit(candidate: CauseCandidate): number {
	const support = scoreOf(candidate.evidence.filter((e) => e.stance === "supports"));
	const against = scoreOf(candidate.evidence.filter((e) => e.stance === "contradicts"));
	const explained = 1 - Math.exp(-support / SATURATION);
	const penalty = Math.exp(-against);
	return explained * penalty;
}

/** A decisive contradiction, if the candidate has one. */
function vetoOf(candidate: CauseCandidate): RankingEvidence | undefined {
	return candidate.evidence.find((e) => e.stance === "contradicts" && e.decisive === true);
}

export type RankOptions = {
	calibration?: CalibrationMap;
	min_leader_confidence?: number;
	min_margin?: number;
};

/**
 * Rank candidates into a calibrated distribution with an explicit residual.
 *
 * The residual's unnormalized mass is the *shortfall* of the best candidate:
 * how much of the evidence the leading explanation fails to account for. With
 * three poor candidates the residual dominates and every candidate reports a
 * low confidence, which is the honest answer and the one that normalizing over
 * candidates alone can never produce.
 */
export function rankCauses(candidates: CauseCandidate[], opts: RankOptions = {}): Ranking {
	const minLeader = opts.min_leader_confidence ?? MIN_LEADER_CONFIDENCE;
	const minMargin = opts.min_margin ?? MIN_MARGIN;

	const vetoed: RankedCause[] = [];
	const live: Array<{ candidate: CauseCandidate; mass: number }> = [];

	for (const candidate of candidates) {
		const veto = vetoOf(candidate);
		const supporting = candidate.evidence.filter((e) => e.stance === "supports");
		const contradicting = candidate.evidence.filter((e) => e.stance === "contradicts");
		if (veto) {
			vetoed.push({
				id: candidate.id,
				summary: candidate.summary,
				confidence: 0,
				raw_confidence: 0,
				supporting,
				contradicting,
				support_score: scoreOf(supporting),
				contradiction_score: scoreOf(contradicting),
				vetoed: true,
				veto_reason: veto.description,
			});
			continue;
		}
		live.push({ candidate, mass: likelihood(candidate) });
	}

	// The residual is what the best explanation leaves *unexplained* — a
	// function of fit, not of posterior mass. A candidate that accounts for
	// everything leaves nothing over; a field of weak ones leaves almost all
	// of it, which is the honest reading and the one that normalizing over
	// candidates alone can never produce.
	const bestFit = live.reduce((max, l) => Math.max(max, fit(l.candidate)), 0);
	const residualMass = Math.max(0, 1 - bestFit);
	const total = live.reduce((sum, l) => sum + l.mass, 0) + residualMass;

	const causes: RankedCause[] = live
		.map(({ candidate, mass }) => {
			const supporting = candidate.evidence.filter((e) => e.stance === "supports");
			const contradicting = candidate.evidence.filter((e) => e.stance === "contradicts");
			const raw = total > 0 ? mass / total : 0;
			return {
				id: candidate.id,
				summary: candidate.summary,
				raw_confidence: round(raw),
				confidence: round(opts.calibration ? applyCalibration(opts.calibration, raw) : raw),
				supporting,
				contradicting,
				support_score: round(scoreOf(supporting)),
				contradiction_score: round(scoreOf(contradicting)),
				vetoed: false,
			};
		})
		.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));

	const leader = causes[0];
	const runnerUp = causes[1];
	const margin = round((leader?.confidence ?? 0) - (runnerUp?.confidence ?? 0));
	const residual = round(total > 0 ? residualMass / total : 1);

	let indecision: string | undefined;
	if (!leader) {
		indecision = "no candidate survived: every hypothesis was vetoed or none was supplied";
	} else if (leader.confidence < minLeader) {
		indecision = `leading candidate reaches only ${leader.confidence}; ${round(residual)} of the belief is that none of these is the cause`;
	} else if (causes.length > 1 && margin < minMargin) {
		indecision = `'${leader.id}' and '${runnerUp.id}' are separated by ${margin}, below the ${minMargin} required to prefer one`;
	}

	const caveats: string[] = [];
	if (vetoed.length > 0) {
		caveats.push(
			`${vetoed.length} candidate(s) vetoed by decisive contradicting evidence; see 'vetoed'`,
		);
	}
	const disputed = causes.filter((c) => c.contradicting.length > 0);
	if (disputed.length > 0) {
		caveats.push(
			`${disputed.length} ranked candidate(s) have contradicting evidence that was not netted away: ${disputed
				.map((c) => c.id)
				.join(", ")}`,
		);
	}
	if (residual > 0.5) {
		caveats.push(
			"most of the belief is on 'none of these': the candidate set is probably missing the real cause",
		);
	}
	if (opts.calibration === undefined) {
		caveats.push("confidences are uncalibrated: no calibration map was supplied");
	}

	return {
		causes,
		residual,
		margin,
		decisive: indecision === undefined,
		...(indecision ? { indecision_reason: indecision } : {}),
		vetoed,
		caveats,
	};
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Render a ranking for an agent.
 *
 * Contradicting evidence is printed under every candidate that has any, and the
 * residual is printed as a line of the distribution rather than as a footnote.
 * The formatting choice is the point: a reader who skims must still see the
 * disagreement.
 */
export function renderRanking(ranking: Ranking): string {
	const lines: string[] = [];
	for (const cause of ranking.causes) {
		lines.push(`${cause.confidence} ${cause.id} — ${cause.summary}`);
		for (const e of cause.supporting) {
			lines.push(`    + ${e.description} (w=${e.weight}, r=${e.reliability})`);
		}
		for (const e of cause.contradicting) {
			lines.push(`    - CONTRADICTS: ${e.description} (w=${e.weight}, r=${e.reliability})`);
		}
	}
	lines.push(`${ranking.residual} (none of these)`);
	for (const cause of ranking.vetoed) {
		lines.push(`VETOED ${cause.id} — ${cause.veto_reason}`);
	}
	lines.push(
		ranking.decisive
			? `decisive: leader ahead by ${ranking.margin}`
			: `NOT decisive: ${ranking.indecision_reason}`,
	);
	for (const caveat of ranking.caveats) lines.push(`note: ${caveat}`);
	return lines.join("\n");
}
