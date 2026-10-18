/**
 * Learned remediation ranking without silent self-modification (item 97).
 *
 * `recommend()` (item 76, `./modes.ts`) ranks applicable remediation modes
 * lexicographically on (reversibility, time-to-effect, blast radius) and says
 * explicitly why it refuses a weighted score: a slow reversible action and a
 * fast irreversible one are a real trade-off that belongs to whoever is on
 * call. That refusal is correct for a *first* ranking with no outcome data.
 * It is not an argument against ever using outcome data once some exists --
 * after enough incidents, "rollback resolves regressions 95% of the time and
 * feature_disable resolves them 40% of the time" is evidence, not a
 * heuristic weighting, and ignoring it forever is its own kind of error.
 *
 * The risk is a system that updates its own ranking quietly: a learned order
 * that starts influencing on-call recommendations the moment enough rows
 * accumulate, with nobody having agreed to that, is `recommend()`'s
 * "weighted score" problem again, just hidden behind a training loop instead
 * of a formula. Three properties close that gap, mirroring how item 77's
 * approval gate closes the equivalent gap for executing an action:
 *
 * 1. **Learning never writes the live ranking.** `learnRankingPolicy` is pure
 *    and produces a `status: "draft"` policy from historical
 *    `RemediationOutcome` rows. `rankWithLearnedPolicy` -- the only function
 *    that lets a policy influence a recommendation -- ignores any policy
 *    whose `status` is not `"active"`. A draft has exactly the same effect on
 *    a live recommendation as if it did not exist.
 * 2. **A policy can only reorder the already-safe set, never grow it.**
 *    `rankWithLearnedPolicy` starts from `recommend(context).recommended` --
 *    the set that already passed every precondition and contraindication
 *    check in `./modes.ts` -- and only permutes it. A mode `evaluateMode`
 *    ruled out can never be promoted into a recommendation by learned
 *    evidence, however strong; the safety gate in `./modes.ts` remains the
 *    sole authority on *applicability*, and this module is the sole
 *    authority on *order among what is already applicable*.
 * 3. **Activation requires the item-77 approval gate, every time.**
 *    `activatePolicy` builds an ordinary `RemediationAction` out of the
 *    policy (`mode: "activate_learned_ranking_policy"`) and runs it through
 *    `checkApproval` from `./approval.ts` -- the same signed, non-self,
 *    non-expired, audited gate a rollback or traffic shift must pass. There is
 *    no separate "policy signing key" or bespoke activation path to miss when
 *    reviewing what requires sign-off; activating a ranking policy *is* a
 *    consequential remediation action, in whatever sense of blast_radius and
 *    reversibility already means something in this codebase.
 *
 * `publishPolicyReport` is the thing a reviewer reads before approving: for
 * every cause with any learned evidence it states the sample count, the
 * learned order, how that compares to what the static formula would already
 * rank first (ignoring precondition facts, to isolate the *ranking logic*
 * from the *gating logic*), and a verdict of `insufficient_data`,
 * `matches_static`, or `diverges`. A reviewer approving a policy that merely
 * confirms the static order already learns nothing was lost; a reviewer
 * approving one that diverges is approving an actual change in behavior, and
 * the report says so plainly rather than burying it in a diff of raw numbers.
 *
 * Pure throughout except `activatePolicy`, which (via `checkApproval`) reads
 * the signing key from the environment -- identical to item 77's own purity
 * boundary.
 */
import { createHash } from "node:crypto";
import type { ApprovalGrant, AuditRecord, RemediationAction } from "./approval.js";
import { checkApproval } from "./approval.js";
import type { CauseClass, RemediationContext, RemediationMode } from "./modes.js";
import { CAUSE_CLASSES, REMEDIATION_MODES, recommend } from "./modes.js";

/** One historical remediation attempt, as recorded after the fact. */
export type RemediationOutcome = {
	cause: CauseClass;
	mode: RemediationMode;
	/** Whether this attempt actually resolved the incident. */
	succeeded: boolean;
	/** Whether the same failure recurred after a nominal success. */
	recurred: boolean;
};

/** Per (cause, mode) statistics computed from outcomes. */
export type ModeStats = {
	cause: CauseClass;
	mode: RemediationMode;
	samples: number;
	success_rate: number;
	/**
	 * 95% Wilson score lower bound on the success rate. Ranking by this rather
	 * than the raw rate is what keeps a mode with 1 success out of 1 try from
	 * outranking one with 40 successes out of 45; the raw rate treats them as
	 * 100% and 89% and gets the order backwards.
	 */
	wilson_lower_bound: number;
	recurrence_rate: number;
};

const Z95 = 1.96;

/**
 * 95% Wilson score lower bound for a success rate.
 *
 * Non-parametric would be nicer still, but this is the standard, well-studied
 * closed form for exactly this problem (ranking small-sample binomial rates
 * conservatively), and `./rules/confidence.ts` already uses sample-size
 * weighting for the same reason on learned rule confidence -- this is the
 * same idea with a named, auditable formula instead of a linear ramp.
 */
export function wilsonLowerBound(successes: number, samples: number, z = Z95): number {
	if (samples <= 0) return 0;
	const n = samples;
	const p = Math.max(0, Math.min(1, successes / n));
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = p + z2 / (2 * n);
	const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return Math.max(0, (center - margin) / denom);
}

/** Aggregate raw outcomes into per (cause, mode) statistics. */
export function computeModeStats(outcomes: RemediationOutcome[]): ModeStats[] {
	const groups = new Map<string, RemediationOutcome[]>();
	for (const o of outcomes) {
		const key = `${o.cause}|${o.mode}`;
		const bucket = groups.get(key);
		if (bucket) bucket.push(o);
		else groups.set(key, [o]);
	}
	const stats: ModeStats[] = [];
	for (const [key, bucket] of groups) {
		const [cause, mode] = key.split("|") as [CauseClass, RemediationMode];
		const samples = bucket.length;
		const successes = bucket.filter((o) => o.succeeded).length;
		const recurrences = bucket.filter((o) => o.recurred).length;
		stats.push({
			cause,
			mode,
			samples,
			success_rate: successes / samples,
			wilson_lower_bound: wilsonLowerBound(successes, samples),
			recurrence_rate: recurrences / samples,
		});
	}
	return stats.sort((a, b) => a.cause.localeCompare(b.cause) || a.mode.localeCompare(b.mode));
}

/** Minimum samples for a (cause, mode) pair before it informs a learned order. */
export const MIN_SAMPLES_FOR_RANKING = 10;

export type CauseRanking = {
	cause: CauseClass;
	/** Modes with enough evidence, best (highest Wilson lower bound) first. */
	order: RemediationMode[];
	/** Every mode with any samples at all, for transparency even below threshold. */
	stats: ModeStats[];
	/** Modes seen but below `MIN_SAMPLES_FOR_RANKING`; excluded from `order`. */
	insufficient_evidence: RemediationMode[];
};

export type LearnedRankingPolicy = {
	id: string;
	generated_at_ms: number;
	min_samples: number;
	causes: CauseRanking[];
	status: "draft" | "active";
	activated_by?: string;
	activated_at_ms?: number;
};

function policyContentDigest(
	causes: CauseRanking[],
	minSamples: number,
	generatedAtMs: number,
): string {
	const canonical = causes
		.map((c) => `${c.cause}:${c.order.join(",")}`)
		.sort()
		.join(";");
	return createHash("sha256")
		.update(`${minSamples}|${generatedAtMs}|${canonical}`)
		.digest("hex")
		.slice(0, 32);
}

/**
 * Learn a draft ranking policy from historical outcomes.
 *
 * A cause is included only when at least two of its modes individually clear
 * `minSamples`: ranking requires comparing at least two things, and a single
 * well-evidenced mode with nothing to compare it against produces an "order"
 * of one, which is not a ranking decision at all.
 *
 * Always returns `status: "draft"`. Nothing this function returns can affect
 * a live recommendation until it passes through `activatePolicy`.
 */
export function learnRankingPolicy(
	outcomes: RemediationOutcome[],
	opts: { minSamples?: number; now_ms: number },
): LearnedRankingPolicy {
	const minSamples = opts.minSamples ?? MIN_SAMPLES_FOR_RANKING;
	const allStats = computeModeStats(outcomes);

	const causes: CauseRanking[] = [];
	for (const cause of CAUSE_CLASSES) {
		const statsForCause = allStats.filter((s) => s.cause === cause);
		if (statsForCause.length === 0) continue;

		const evidenced = statsForCause.filter((s) => s.samples >= minSamples);
		const insufficient = statsForCause.filter((s) => s.samples < minSamples).map((s) => s.mode);

		if (evidenced.length < 2) {
			// Nothing to rank: zero or one mode cleared the threshold. Still
			// publish the stats (transparency), but order stays empty so this
			// cause never influences a recommendation.
			causes.push({ cause, order: [], stats: statsForCause, insufficient_evidence: insufficient });
			continue;
		}

		const order = [...evidenced]
			.sort((a, b) => b.wilson_lower_bound - a.wilson_lower_bound || a.mode.localeCompare(b.mode))
			.map((s) => s.mode);

		causes.push({ cause, order, stats: statsForCause, insufficient_evidence: insufficient });
	}

	const id = policyContentDigest(causes, minSamples, opts.now_ms);
	return { id, generated_at_ms: opts.now_ms, min_samples: minSamples, causes, status: "draft" };
}

/**
 * A maximally-permissive context for a cause: every precondition satisfied.
 *
 * Used only to read off what `recommend()`'s *ranking formula* would produce
 * when nothing is gated out, so a learned order can be compared against the
 * ranking logic in isolation from the precondition facts of any one real
 * incident. It is never used to decide whether a mode is actually safe to
 * run; `./modes.ts` alone decides that, from the real context.
 */
export function canonicalPermissiveContext(cause: CauseClass): RemediationContext {
	return {
		cause,
		failure_is_transient: true,
		previous_version: "canonical",
		previous_version_deployable: true,
		gating_flag: "canonical_flag",
		flag_covers_failure: true,
		spare_capacity_fraction: 2,
		failure_is_localized: true,
		rollback_loses_writes: false,
	};
}

export type CalibrationEntry = {
	cause: CauseClass;
	samples: number;
	/** The static formula's order, restricted to modes the policy has evidence for. */
	static_order: RemediationMode[];
	/** The learned order for this cause (empty if under-evidenced). */
	learned_order: RemediationMode[];
	leader_matches: boolean;
	full_order_matches: boolean;
	verdict: "insufficient_data" | "matches_static" | "diverges";
};

export type PolicyReport = {
	policy_id: string;
	status: LearnedRankingPolicy["status"];
	entries: CalibrationEntry[];
	diverging_causes: CauseClass[];
	caveats: string[];
};

/**
 * Publish the calibration/drift report a reviewer reads before approving.
 *
 * "Calibration" here is sample sufficiency per cause (the `insufficient_data`
 * verdict); "drift" is how the learned order differs from what the static
 * ranking formula alone would already produce for that cause
 * (`matches_static` vs `diverges`). Both are per-cause rather than a single
 * rolled-up number, because a policy that is well-evidenced and divergent for
 * `config_drift` and under-evidenced for everything else is a very different
 * approval decision from the same two facts in reverse.
 */
export function publishPolicyReport(policy: LearnedRankingPolicy): PolicyReport {
	const entries: CalibrationEntry[] = policy.causes.map((c) => {
		const totalSamples = c.stats.reduce((sum, s) => sum + s.samples, 0);
		if (c.order.length < 2) {
			return {
				cause: c.cause,
				samples: totalSamples,
				static_order: [],
				learned_order: c.order,
				leader_matches: false,
				full_order_matches: false,
				verdict: "insufficient_data",
			};
		}
		const staticFullOrder = recommend(canonicalPermissiveContext(c.cause)).recommended.map(
			(r) => r.mode,
		);
		const staticOrder = staticFullOrder.filter((m) => c.order.includes(m));
		const leaderMatches = staticOrder[0] === c.order[0];
		const fullOrderMatches =
			staticOrder.length === c.order.length && staticOrder.every((m, i) => m === c.order[i]);
		return {
			cause: c.cause,
			samples: totalSamples,
			static_order: staticOrder,
			learned_order: c.order,
			leader_matches: leaderMatches,
			full_order_matches: fullOrderMatches,
			verdict: fullOrderMatches ? "matches_static" : "diverges",
		};
	});

	const diverging = entries.filter((e) => e.verdict === "diverges").map((e) => e.cause);

	const caveats: string[] = [
		"this report compares the learned order to what the ranking formula alone would produce with every precondition satisfied; it says nothing about whether a given real incident's preconditions were met, which is decided separately and unconditionally by evaluateMode()",
	];
	if (policy.causes.every((c) => c.order.length < 2)) {
		caveats.push(
			"no cause in this policy has two or more modes with sufficient evidence; activating it would change nothing",
		);
	}
	if (diverging.length > 0) {
		caveats.push(
			`${diverging.length} cause(s) diverge from the static formula; approving this policy is approving an actual change in recommended order for those causes, not a confirmation of the status quo`,
		);
	}

	return {
		policy_id: policy.id,
		status: policy.status,
		entries,
		diverging_causes: diverging,
		caveats,
	};
}

export function renderPolicyReport(report: PolicyReport): string {
	const lines: string[] = [`policy ${report.policy_id} (${report.status})`];
	for (const e of report.entries) {
		lines.push(`  ${e.cause}: ${e.verdict} (n=${e.samples})`);
		if (e.learned_order.length > 0) {
			lines.push(`     learned:  ${e.learned_order.join(" > ")}`);
			lines.push(`     static:   ${e.static_order.join(" > ") || "(no comparable order)"}`);
		}
	}
	for (const caveat of report.caveats) lines.push(`  note: ${caveat}`);
	return lines.join("\n");
}

/** The `RemediationAction.mode` used for activation requests, for approval records. */
export const ACTIVATION_MODE = "activate_learned_ranking_policy";

/**
 * Build the `RemediationAction` an activation request is approved against.
 *
 * `blast_radius: 1` and `reversible: true` are not measurements of this one
 * policy's riskiness; they are a deliberate floor. Classifying activation by
 * the policy's own apparent blast radius would let a policy that only touches
 * one rarely-seen cause slip in under a lower consequence tier, and the
 * actual risk of a ranking change is "every future recommendation for every
 * cause it covers," which is never small enough to skip approval.
 */
export function policyActivationAction(
	policy: LearnedRankingPolicy,
	requestedBy: string,
): RemediationAction {
	return {
		mode: ACTIVATION_MODE,
		target:
			policy.causes
				.map((c) => c.cause)
				.sort()
				.join(",") || "none",
		parameters: {
			policy_id: policy.id,
			generated_at_ms: policy.generated_at_ms,
			cause_count: policy.causes.filter((c) => c.order.length >= 2).length,
		},
		reversible: true,
		blast_radius: 1,
		requested_by: requestedBy,
	};
}

export type ActivationResult =
	| { ok: true; policy: LearnedRankingPolicy }
	| { ok: false; reason: string; audit?: AuditRecord };

/**
 * Activate a policy, gated by the item-77 approval mechanism.
 *
 * This is the only function in the module that can turn a `"draft"` policy
 * into an `"active"` one, and it does so by constructing an ordinary
 * `RemediationAction` and running it through `checkApproval` -- the identical
 * signed/non-self/non-expired/audited path a rollback or traffic shift must
 * pass. No separate signing key, no bespoke "policy approval" format: the
 * reviewer who already knows how to read a remediation-action approval knows
 * how to read this one.
 */
export function activatePolicy(
	policy: LearnedRankingPolicy,
	requestedBy: string,
	grant: ApprovalGrant | undefined,
	opts: { now_ms?: number; key?: string } = {},
): ActivationResult {
	if (policy.status === "active") {
		return {
			ok: false,
			reason: "this policy is already active; re-activating it would hide a no-op behind a success",
		};
	}
	const learnedCauses = policy.causes.filter((c) => c.order.length >= 2);
	if (learnedCauses.length === 0) {
		return {
			ok: false,
			reason:
				"this policy has no cause with two or more sufficiently-evidenced modes; there is nothing learned to activate",
		};
	}

	const action = policyActivationAction(policy, requestedBy);
	const decision = checkApproval(action, grant, opts);
	if (!decision.allowed) {
		return { ok: false, reason: decision.reason, audit: decision.audit };
	}

	return {
		ok: true,
		policy: {
			...policy,
			status: "active",
			activated_by: decision.audit.approver ?? requestedBy,
			activated_at_ms: opts.now_ms ?? Date.now(),
		},
	};
}

/**
 * Rank a context's applicable remediations, deferring to a learned order only
 * when one is active and covers this cause.
 *
 * Starts from `recommend(context)` -- the full, safety-checked result,
 * contraindications and preconditions already applied -- and only permutes
 * `.recommended`. A mode that is not in that set cannot appear here no matter
 * what the policy says, because the policy's `order` is never consulted for
 * applicability, only for sequencing among modes `recommend()` already
 * allowed. Modes the policy has no evidence for keep their original relative
 * static order and sort after every evidenced mode, so partial evidence can
 * only ever reorder a prefix, never invent an opinion about the rest.
 */
export function rankWithLearnedPolicy(
	context: RemediationContext,
	policy?: LearnedRankingPolicy,
): ReturnType<typeof recommend> {
	const base = recommend(context);
	if (!policy || policy.status !== "active") return base;

	const causeRanking = policy.causes.find((c) => c.cause === context.cause);
	if (!causeRanking || causeRanking.order.length < 2) return base;

	const order = causeRanking.order;
	const rank = (mode: RemediationMode) => order.indexOf(mode);

	const reordered = [...base.recommended].sort((a, b) => {
		const ra = rank(a.mode);
		const rb = rank(b.mode);
		if (ra === -1 && rb === -1) return 0;
		if (ra === -1) return 1;
		if (rb === -1) return -1;
		return ra - rb;
	});

	const unevidenced = base.recommended.map((r) => r.mode).filter((m) => !order.includes(m));
	const caveats = [
		...base.caveats,
		`ranking order for applicable modes was reordered by learned policy ${policy.id} (approved by ${policy.activated_by ?? "unknown"})`,
		...(unevidenced.length > 0
			? [
					`mode(s) ${unevidenced.join(", ")} have no evidence under this policy and kept their static-ranking position`,
				]
			: []),
	];

	return { ...base, recommended: reordered, caveats };
}

/** All modes this module knows about, re-exported for test/report convenience. */
export const KNOWN_MODES = REMEDIATION_MODES;
