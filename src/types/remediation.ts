import { z } from "zod";

/**
 * Detect -> Attribute -> Recover -> Rerun as a durable state machine
 * (item 96).
 *
 * The existing `autofixLoop` (item 35) composes the same four phases, but
 * entirely in memory: a process crash (OOM, kill, power loss) between
 * "ran the fix_commands" and "recorded the verification outcome" leaves no
 * durable trace that a remediation was attempted at all. A caller that
 * restarts and picks the same failure back up has no way to know a
 * non-idempotent `fix_command` already ran — appending to a file, bumping a
 * counter, sending a notification — and `autofixLoop` will cheerfully run it
 * again, duplicating the side effect. Confirmed live: a `fix_commands` step
 * that appends `"1"` to a counter file, interrupted right after the command
 * runs but before the rerun confirms, is re-executed in full on restart,
 * leaving the counter at `"11"` instead of `"1"`.
 *
 * `RemediationRun` makes every phase transition an explicit, durably
 * persisted row **before** the side-effecting work for that phase begins,
 * and **after** it completes — so a crash leaves the run in a known phase
 * with a known, inspectable set of recorded side effects, and resuming
 * means "continue from the last durably-recorded phase", never "start over
 * from Detect".
 */
export const RemediationPhaseSchema = z.enum(["detect", "attribute", "recover", "rerun", "done"]);
export type RemediationPhase = z.infer<typeof RemediationPhaseSchema>;

/**
 * Terminal statuses a run can land in. Mirrors `autofixLoop`'s existing
 * vocabulary (`fixed`, `flaky_refused`, `no_fix`, `fix_ineffective`,
 * `exhausted`) plus `crash_recovered_duplicate_guard`, which fires only when
 * resuming after a crash finds recorded evidence that recovery's side effects
 * already ran and must not be re-applied blind.
 */
export const RemediationStatusSchema = z.enum([
	"in_progress",
	"fixed",
	"flaky_refused",
	"no_fix",
	"fix_ineffective",
	"exhausted",
	"rerun_error",
	"requires_review",
]);
export type RemediationStatus = z.infer<typeof RemediationStatusSchema>;

/** One durably-recorded recovery side effect: a patch apply or a fix command. */
export const RecoveryEffectSchema = z.object({
	kind: z.enum(["patch", "command"]),
	/** The patch diff (for `patch`) or the literal command string (for `command`). */
	descriptor: z.string(),
	/** `pending` is written before the effect runs; `applied`/`failed`/`blocked` after. */
	status: z.enum(["pending", "applied", "failed", "blocked"]),
	detail: z.string().optional(),
	files_changed: z.array(z.string()).optional(),
	recorded_at: z.string(),
});
export type RecoveryEffect = z.infer<typeof RecoveryEffectSchema>;

/** One attempt (one Recover+Rerun cycle) within a run. */
export const RemediationAttemptSchema = z.object({
	attempt: z.number().int().min(1),
	fix_source: z.string(),
	/**
	 * The failure_id this attempt was diagnosed against and whose `command` is
	 * re-run to verify recovery. Persisted so a crash-resume can reconstruct
	 * exactly which failure an in-progress attempt belongs to without
	 * depending on `rerun_failure_id` (which does not exist yet until the
	 * rerun phase completes).
	 */
	attributed_failure_id: z.string(),
	/** Durably recorded in commit order, each with its own pending->applied/failed record. */
	effects: z.array(RecoveryEffectSchema),
	rerun_status: z.enum(["pending", "passed", "failed", "timeout", "error"]),
	rerun_failure_id: z.string().optional(),
});
export type RemediationAttempt = z.infer<typeof RemediationAttemptSchema>;

export const RemediationRunSchema = z.object({
	run_id: z.string(),
	failure_id: z.string(),
	phase: RemediationPhaseSchema,
	status: RemediationStatusSchema,
	max_attempts: z.number().int().min(1),
	attempts: z.array(RemediationAttemptSchema),
	tried_fix_keys: z.array(z.string()),
	message: z.string().optional(),
	created_at: z.string(),
	updated_at: z.string(),
});
export type RemediationRun = z.infer<typeof RemediationRunSchema>;
