import type { EvidenceBudgetSpend } from "../capture/evidence-budget.js";
/**
 * Causal continuity of incident state across agent/operator handoffs
 * (item 49, module-header numbering: item 115, confirmed next-free via
 * `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u`,
 * highest prior being item 114 from item 48's `security/patch-
 * validation.ts`).
 *
 * `grep -rln "handoff\|hand-off\|hand_off" src --include="*.ts"` returned
 * nothing before this module. Every piece of per-incident state this item
 * names already has a module that OWNS it correctly in isolation:
 * `diagnosis/hypothesis.ts` (item 43) for hypotheses and their explicit
 * abandonment reasons; `capture/evidence-budget.ts` (item 33) for evidence
 * spend; `security/data-classes.ts` (item 15/62) for privacy
 * classification/action decisions; `trace/conformance.ts` (item 40) for
 * span ownership; `remediation/durable-loop.ts` (item 96) /
 * `types/remediation.ts` for recovery state. None of them have ever been
 * asked "what survives when a different agent or a human operator picks
 * up this SAME incident" — and naively concatenating their snapshots is
 * exactly how stale confidence leaks across a handoff: a hypothesis
 * snapshotted at 0.95 posterior an hour ago is not evidence of 0.95
 * confidence NOW if nothing has reconfirmed it since, yet a receiver
 * reading the raw snapshot has no way to tell "still warm" from "cooled
 * off and nobody noticed".
 *
 * This module adds exactly one new concept — a `HandoffPackage`, built by
 * `buildHandoffPackage` from each existing module's own already-computed
 * state, UNMODIFIED — and one new rule that the existing modules do not
 * and should not enforce themselves, because it is specific to the
 * cross-handoff boundary:
 *
 * **Stale-confidence inheritance is refused, not silently carried.**
 * `receiveHandoff` compares `package.captured_at_ms` against the
 * receiver's `now_ms` and `staleness_threshold_ms`. Within the threshold,
 * every open/confirmed hypothesis's posterior is inherited verbatim —
 * nothing is pessimistically discounted that does not need to be,
 * mirroring `fix-ledger.ts`'s (item 78) refusal to invent a durability
 * number without an observation window. PAST the threshold, every
 * open/confirmed hypothesis is downgraded to `status: "open"` with its
 * posterior CAPPED at `STALE_POSTERIOR_CEILING` and an explicit
 * `stale_hypotheses` entry naming why — a receiver cannot accidentally
 * treat an hour-old 0.95 as still-0.95 just because the field says so.
 * `refuted`/`abandoned` hypotheses are NEVER revived by staleness — being
 * ruled out does not expire, mirroring `hypothesis.ts`'s own one-way
 * `refuted implies descendants abandoned` rule.
 *
 * Everything else travels unconditionally, because unconditional loss (not
 * stale confidence) is the failure mode for these fields:
 *
 * - **Rejected causes never resurface.** `rejected_causes` (sourced from
 *   `abandoned_with_reasons` in `hypothesis.ts`'s own `ValidationSummary`)
 *   is carried forward and `receiveHandoff` refuses to let a new
 *   hypothesis tree reintroduce an identical `statement` at the same
 *   `location` without a NEW reason distinct from the rejected one —
 *   otherwise a receiving agent would re-investigate a dead end the
 *   sender already closed, at real cost, for no new reason.
 * - **Evidence budget spend is additive across the handoff, never
 *   reset.** `receiveHandoff` requires the receiver's budget ledger to be
 *   seeded from `package.evidence_spent`, mirroring
 *   `EvidenceBudgetLedger`'s own "a refused collection is never charged"
 *   discipline generalized to "a charge already made is never un-made by
 *   switching operators".
 * - **Privacy decisions are a ratchet, never loosened.** `privacy_floor`
 *   records the STRICTEST `CaptureAction` applied to each `DataClass` so
 *   far (via `ACTION_STRICTNESS`, reused unmodified from
 *   `security/data-classes.ts`). A receiving context may apply an EQUALLY
 *   or MORE strict policy; `receiveHandoff` refuses a receiver-declared
 *   policy that would be LESS strict than what the sender already
 *   enforced for any class, because a handoff must never be a path to
 *   loosening a privacy decision nobody re-justified.
 * - **Ownership is reassigned explicitly, never dropped.** `ownership`
 *   always carries a new `current_owner`; `receiveHandoff` refuses a
 *   package whose `current_owner` is unchanged from the sender's own
 *   `current_owner` at a DIFFERENT handoff id, which would mean the
 *   incident silently has no new owner despite a handoff being recorded.
 * - **Recovery state cannot be rewound.** `recovery_state` carries the
 *   `RemediationPhase`/`RemediationStatus` pair from `types/remediation.ts`
 *   (unmodified); `receiveHandoff` refuses a package whose recovery phase
 *   has gone BACKWARD relative to `RECOVERY_PHASE_ORDER` — a handoff
 *   cannot un-apply a recovery effect that already ran.
 *
 * Pure: no fs/network/clock (all timestamps are caller-supplied), so a
 * handoff chain is fully reproducible and auditable in tests.
 */
import type { CaptureAction, DataClass } from "../security/data-classes.js";
import { ACTION_STRICTNESS } from "../security/data-classes.js";
import type { RemediationPhase, RemediationStatus } from "../types/remediation.js";
import type { Hypothesis } from "./hypothesis.js";

/** Posterior ceiling a stale open/confirmed hypothesis is capped to on inheritance. */
export const STALE_POSTERIOR_CEILING = 0.5;

/** Phase order used to detect a backward (un-applying) recovery-state handoff. */
export const RECOVERY_PHASE_ORDER: RemediationPhase[] = [
	"detect",
	"attribute",
	"recover",
	"rerun",
	"done",
];

export type RejectedCause = {
	hypothesis_id: string;
	statement: string;
	location?: string;
	reason: string;
};

export type OwnershipRecord = {
	current_owner: string;
	/** `agent` or `operator`, naming who is accountable for the next action. */
	owner_kind: "agent" | "operator";
	/** Prior owner, for an auditable chain. Absent only for the incident's first owner. */
	previous_owner?: string;
};

export type RecoveryState = {
	run_id: string;
	phase: RemediationPhase;
	status: RemediationStatus;
};

export type HandoffPackage = {
	handoff_id: string;
	failure_id: string;
	captured_at_ms: number;
	hypotheses: Hypothesis[];
	rejected_causes: RejectedCause[];
	evidence_spent: EvidenceBudgetSpend;
	/** Strictest CaptureAction enforced so far, per DataClass. */
	privacy_floor: Partial<Record<DataClass, CaptureAction>>;
	ownership: OwnershipRecord;
	recovery_state: RecoveryState;
};

/** Build a handoff package from each existing module's own already-computed state, unmodified. */
export function buildHandoffPackage(input: {
	handoff_id: string;
	failure_id: string;
	captured_at_ms: number;
	hypotheses: Hypothesis[];
	abandoned_with_reasons: Array<{ id: string; reason: string }>;
	evidence_spent: EvidenceBudgetSpend;
	privacy_floor: Partial<Record<DataClass, CaptureAction>>;
	ownership: OwnershipRecord;
	recovery_state: RecoveryState;
}): HandoffPackage {
	const byId = new Map(input.hypotheses.map((h) => [h.id, h]));
	const rejected_causes: RejectedCause[] = input.abandoned_with_reasons.map((a) => {
		const h = byId.get(a.id);
		return {
			hypothesis_id: a.id,
			statement: h?.statement ?? "",
			location: h?.location,
			reason: a.reason,
		};
	});
	return {
		handoff_id: input.handoff_id,
		failure_id: input.failure_id,
		captured_at_ms: input.captured_at_ms,
		hypotheses: input.hypotheses,
		rejected_causes,
		evidence_spent: input.evidence_spent,
		privacy_floor: input.privacy_floor,
		ownership: input.ownership,
		recovery_state: input.recovery_state,
	};
}

export type StaleHypothesisNote = {
	hypothesis_id: string;
	original_posterior: number;
	capped_posterior: number;
	reason: string;
};

export type HandoffRefusal = {
	code: "revived_rejected_cause" | "privacy_loosened" | "ownership_unchanged" | "recovery_rewound";
	detail: string;
};

export type ReceiveHandoffOptions = {
	now_ms: number;
	staleness_threshold_ms: number;
	/** The receiving context's declared policy, checked against the sender's privacy_floor ratchet. */
	declared_privacy_floor?: Partial<Record<DataClass, CaptureAction>>;
	/** A newly built hypothesis tree the receiver proposes to start from, checked against rejected_causes. */
	new_hypotheses?: Array<{ statement: string; location?: string; reason_for_reopening?: string }>;
	/** The receiving context's own recovery-state claim, checked against recovery_state for rewind. */
	declared_recovery_phase?: RemediationPhase;
};

export type ReceiveHandoffResult = {
	package: HandoffPackage;
	/** True only when every open/confirmed hypothesis's posterior was inherited verbatim. */
	within_staleness_threshold: boolean;
	effective_hypotheses: Hypothesis[];
	stale_hypotheses: StaleHypothesisNote[];
	refusals: HandoffRefusal[];
};

/**
 * Receive a handoff package into a new context and apply every continuity
 * rule described in the module header.
 *
 * Never throws: every violation is reported in `refusals` so a caller can
 * decide what to do (hold the handoff, escalate, request clarification)
 * rather than crashing the handoff path itself.
 */
export function receiveHandoff(
	pkg: HandoffPackage,
	opts: ReceiveHandoffOptions,
): ReceiveHandoffResult {
	const refusals: HandoffRefusal[] = [];
	const staleMs = opts.now_ms - pkg.captured_at_ms;
	const withinThreshold = staleMs <= opts.staleness_threshold_ms;

	const stale_hypotheses: StaleHypothesisNote[] = [];
	const effective_hypotheses: Hypothesis[] = pkg.hypotheses.map((h) => {
		if (withinThreshold) return h;
		if (h.status !== "open" && h.status !== "confirmed") return h;
		if (h.posterior <= STALE_POSTERIOR_CEILING) return h;
		stale_hypotheses.push({
			hypothesis_id: h.id,
			original_posterior: h.posterior,
			capped_posterior: STALE_POSTERIOR_CEILING,
			reason: `handoff package is ${staleMs}ms old, past the ${opts.staleness_threshold_ms}ms staleness threshold; a ${h.status} posterior of ${h.posterior.toFixed(3)} was not reconfirmed since and cannot be inherited at face value`,
		});
		return { ...h, status: "open" as const, posterior: STALE_POSTERIOR_CEILING };
	});

	for (const candidate of opts.new_hypotheses ?? []) {
		const rejected = pkg.rejected_causes.find(
			(r) => r.statement === candidate.statement && r.location === candidate.location,
		);
		if (rejected && !candidate.reason_for_reopening) {
			refusals.push({
				code: "revived_rejected_cause",
				detail: `candidate hypothesis '${candidate.statement}'${candidate.location ? ` at '${candidate.location}'` : ""} was already rejected (${rejected.reason}); reopening it requires a new reason distinct from the rejection, none was given`,
			});
		}
	}

	if (opts.declared_privacy_floor) {
		for (const [dataClass, action] of Object.entries(opts.declared_privacy_floor) as Array<
			[DataClass, CaptureAction]
		>) {
			const senderFloor = pkg.privacy_floor[dataClass];
			if (senderFloor && ACTION_STRICTNESS[action] > ACTION_STRICTNESS[senderFloor]) {
				refusals.push({
					code: "privacy_loosened",
					detail: `receiver declared '${action}' for data class '${dataClass}', looser than the sender's already-enforced '${senderFloor}'; a handoff must never loosen a privacy decision`,
				});
			}
		}
	}

	const sameOwner =
		pkg.ownership.previous_owner !== undefined &&
		pkg.ownership.previous_owner === pkg.ownership.current_owner;
	if (sameOwner) {
		refusals.push({
			code: "ownership_unchanged",
			detail: `handoff '${pkg.handoff_id}' records previous_owner and current_owner as the same value ('${pkg.ownership.current_owner}'); a recorded handoff must reassign ownership, not restate it`,
		});
	}

	if (opts.declared_recovery_phase) {
		const packagePhaseIndex = RECOVERY_PHASE_ORDER.indexOf(pkg.recovery_state.phase);
		const declaredPhaseIndex = RECOVERY_PHASE_ORDER.indexOf(opts.declared_recovery_phase);
		if (declaredPhaseIndex < packagePhaseIndex) {
			refusals.push({
				code: "recovery_rewound",
				detail: `declared recovery phase '${opts.declared_recovery_phase}' is earlier than the package's own recorded phase '${pkg.recovery_state.phase}'; a handoff cannot un-apply recovery effects that already ran`,
			});
		}
	}

	return {
		package: pkg,
		within_staleness_threshold: withinThreshold,
		effective_hypotheses,
		stale_hypotheses,
		refusals,
	};
}

/** Render a human-readable summary of a received handoff. */
export function renderHandoffReceipt(result: ReceiveHandoffResult): string {
	const lines: string[] = ["# Handoff Continuity Report", ""];
	lines.push(`Handoff: ${result.package.handoff_id} (failure ${result.package.failure_id})`);
	lines.push(`Within staleness threshold: ${result.within_staleness_threshold}`);
	lines.push("");
	if (result.stale_hypotheses.length > 0) {
		lines.push("## Stale hypotheses capped on inheritance");
		for (const s of result.stale_hypotheses) {
			lines.push(
				`- ${s.hypothesis_id}: ${s.original_posterior.toFixed(3)} -> ${s.capped_posterior} (${s.reason})`,
			);
		}
		lines.push("");
	}
	if (result.refusals.length > 0) {
		lines.push("## Refusals");
		for (const r of result.refusals) lines.push(`- [${r.code}] ${r.detail}`);
	} else {
		lines.push("No continuity violations detected.");
	}
	return lines.join("\n");
}
