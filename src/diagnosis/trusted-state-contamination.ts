/**
 * Forensically detect trusted-state contamination (item 55, module-header
 * numbering: item 120, confirmed next-free via `grep -rohE "item [0-9]+"
 * src --include="*.ts" | sort -t' ' -k2 -n -u | tail`, highest prior being
 * item 119 from item 54's `oauth-misbinding.ts`).
 *
 * `debug/time-travel.ts` (item 25) already content-addresses every
 * `StateSnapshot` into an immutable `Checkpoint` and never reconstructs one
 * by re-execution. `diagnosis/recovery-packet.ts` (item 100) already
 * proposes a bounded `RecoveryAction` and measures whether a rerun improved
 * `WITHOUT` quietly expanding tool authority (`measureRerunImprovement`'s
 * `authority_expanded`/`valid` split). Neither asks the question this item
 * names: once a repair action runs, is the RESULTING state genuinely
 * derived from that action working on the actual broken state, or did the
 * "recovery" simply substitute in a state someone already trusted —
 * an externally supplied oracle answer, or a snapshot the trajectory had
 * already passed through earlier — without the declared action doing any
 * of the work its own record implies? `measureRerunImprovement`'s own
 * `authority_expanded` taints a MEASUREMENT when tool authority grew
 * between reruns; this module applies the same "an improvement can be
 * fake even when the numbers look right" discipline to the STATE ITSELF,
 * one repair attempt at a time, by comparing: the checkpoint immediately
 * before the repair ran, the `RecoveryAction` that was declared, the
 * `StateDelta` actually recorded while it ran (or the explicit absence of
 * one), the resulting checkpoint, and two independent sources of prior
 * trust — an externally supplied oracle/known-good reference list, and
 * the trajectory's OWN earlier history.
 *
 * One attempt classifies to exactly ONE of four verdicts, mirroring
 * `security/patch-validation.ts`'s (item 48) own "each verdict a distinct
 * fact rather than folded into one score" discipline:
 *
 * - `unverifiable`: no `StateDelta` was recorded between the pre- and
 *   post-repair checkpoints at all. Containment can be neither confirmed
 *   NOR refuted from this attempt alone — reported as its own verdict
 *   rather than defaulting to "genuine" (which would be claiming
 *   confidence this attempt never earned) or to one of the contamination
 *   verdicts (which would be accusing without evidence). This is checked
 *   FIRST and takes priority over the other three, because a missing
 *   delta means there is no evidence basis to even evaluate them.
 * - `oracle_injection`: the post-repair checkpoint's content address
 *   exactly matches one of the caller-supplied `trusted_checkpoint_ids` —
 *   references considered trusted INDEPENDENTLY of this repair attempt,
 *   e.g. a canonical known-good snapshot library — AND the recorded delta
 *   shows literally no derivation work (`changed_variables`,
 *   `branch_events`, `exceptions`, and `console_events` all empty). State
 *   that matches a pre-known answer while recording zero work to get
 *   there is not evidence of a correct repair; it is evidence the "repair"
 *   substituted the oracle's answer instead of performing one. (Matching
 *   a trusted reference WHILE a substantial delta was recorded is not
 *   flagged here — genuine repair converging on the one correct state is
 *   expected to look identical to the canonical answer; what is suspicious
 *   is matching it with no recorded work.)
 * - `stale_snapshot_reuse`: the post-repair checkpoint's content address
 *   matches a checkpoint the trajectory had ALREADY recorded earlier in
 *   this same session, strictly before the pre-repair checkpoint's own
 *   sequence. The "recovery" reproduced a state the trajectory had
 *   already passed through, rather than deriving a new resolution to the
 *   CURRENT failure — checked regardless of how much delta work was
 *   recorded, since reproducing old content is itself the evidence,
 *   independent of how busy the repair looked while doing it.
 * - `genuine`: none of the above — a delta was recorded, it shows actual
 *   work, and the resulting state matches neither a prior-trusted oracle
 *   reference achieved for free nor a stale already-seen state.
 *
 * Pure: no fs/network/process/clock. Checkpoints, the declared action, and
 * the recorded delta are supplied by the caller — the exact same
 * (`Checkpoint`, `RecoveryAction`, `StateDelta`) shapes `time-travel.ts`
 * and `recovery-packet.ts` already produce, reused UNMODIFIED.
 */
import type { Checkpoint } from "../debug/time-travel.js";
import type { StateDelta } from "../types/debug.js";
import type { RecoveryAction } from "./recovery-packet.js";

export type RepairAttempt = {
	/** An identifier for this attempt, carried through into the verdict for correlation. Never a raw token/secret. */
	attempt_id: string;
	pre_repair: Checkpoint;
	action: RecoveryAction;
	post_repair: Checkpoint;
	/** The `StateDelta` actually recorded live between `pre_repair` and `post_repair`. `null` means none was captured at all. */
	recorded_delta: StateDelta | null;
};

export const CONTAINMENT_VERDICTS = [
	"genuine",
	"oracle_injection",
	"stale_snapshot_reuse",
	"unverifiable",
] as const;
export type ContainmentVerdictKind = (typeof CONTAINMENT_VERDICTS)[number];

export type ContainmentVerdict = {
	attempt_id: string;
	verdict: ContainmentVerdictKind;
	reason: string;
};

/** Whether a `StateDelta` records ANY actual derivation work, across all four of its own evidence fields. */
function hasRecordedWork(delta: StateDelta): boolean {
	return (
		delta.changed_variables.length > 0 ||
		delta.branch_events.length > 0 ||
		delta.exceptions.length > 0 ||
		delta.console_events.length > 0
	);
}

/**
 * Classify one repair attempt into exactly one of the four verdicts above.
 * `priorCheckpointIds` must be the set of `checkpoint_id`s the trajectory
 * had ALREADY recorded strictly before `attempt.pre_repair.sequence` — the
 * caller's responsibility to filter by sequence, since this function has
 * no other way to know which checkpoints came "before" without also being
 * handed `pre_repair` for comparison.
 */
export function classifyRepairAttempt(
	attempt: RepairAttempt,
	trustedCheckpointIds: ReadonlySet<string>,
	priorCheckpointIds: ReadonlySet<string>,
): ContainmentVerdict {
	const { attempt_id, post_repair, recorded_delta } = attempt;

	if (recorded_delta === null) {
		return {
			attempt_id,
			verdict: "unverifiable",
			reason:
				"no StateDelta was recorded between the pre- and post-repair checkpoints; containment cannot be confirmed or refuted from this attempt alone",
		};
	}

	if (trustedCheckpointIds.has(post_repair.checkpoint_id) && !hasRecordedWork(recorded_delta)) {
		return {
			attempt_id,
			verdict: "oracle_injection",
			reason: `the resulting state (checkpoint '${post_repair.checkpoint_id}') matches an independently pre-trusted reference, but the recorded delta shows no actual derivation work (no changed variables, branch events, exceptions, or console events) — the repair substituted a known answer instead of performing one`,
		};
	}

	if (priorCheckpointIds.has(post_repair.checkpoint_id)) {
		return {
			attempt_id,
			verdict: "stale_snapshot_reuse",
			reason: `the resulting state (checkpoint '${post_repair.checkpoint_id}') is byte-identical to a checkpoint this same trajectory had already recorded earlier, before this repair attempt began — the "recovery" reproduced an already-seen state rather than deriving a new resolution to the current failure`,
		};
	}

	return {
		attempt_id,
		verdict: "genuine",
		reason:
			"a non-empty StateDelta was recorded and the resulting state matches neither a pre-trusted oracle reference achieved with zero recorded work nor a stale state this trajectory had already passed through",
	};
}

export type ContaminationReport = {
	verdicts: ContainmentVerdict[];
	/** The id of the first attempt (in input order) classified as `oracle_injection` or `stale_snapshot_reuse`, naming where contamination first appears rather than every downstream recurrence. `undefined` when no attempt was contaminated. */
	first_contaminated_attempt_id?: string;
};

const CONTAMINATED: ReadonlySet<ContainmentVerdictKind> = new Set([
	"oracle_injection",
	"stale_snapshot_reuse",
]);

/**
 * Classify every attempt in trajectory order and name the first one found
 * to be contaminated, mirroring `mrtr.ts`'s (item 51) `first_violated_round`
 * and `mcp-subscription.ts`'s (item 52) `first_violation` discipline of
 * naming where a chain FIRST broke rather than listing every downstream
 * symptom with equal weight.
 */
export function diagnoseRepairAttempts(
	attempts: RepairAttempt[],
	trustedCheckpointIds: ReadonlySet<string>,
	priorCheckpointIds: ReadonlySet<string>,
): ContaminationReport {
	const verdicts = attempts.map((attempt) =>
		classifyRepairAttempt(attempt, trustedCheckpointIds, priorCheckpointIds),
	);
	const firstContaminated = verdicts.find((v) => CONTAMINATED.has(v.verdict));
	return {
		verdicts,
		...(firstContaminated ? { first_contaminated_attempt_id: firstContaminated.attempt_id } : {}),
	};
}

/** Render a human-readable trusted-state contamination report. */
export function renderContaminationReport(report: ContaminationReport): string {
	const lines: string[] = ["# Trusted-State Contamination Report", ""];
	if (report.verdicts.length === 0) {
		lines.push("No repair attempts supplied.");
		return lines.join("\n");
	}
	for (const v of report.verdicts) {
		lines.push(`- [${v.verdict}] attempt '${v.attempt_id}': ${v.reason}`);
	}
	lines.push("");
	lines.push(
		report.first_contaminated_attempt_id
			? `First contaminated attempt: ${report.first_contaminated_attempt_id}`
			: "No contamination detected.",
	);
	return lines.join("\n");
}
