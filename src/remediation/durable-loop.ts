/**
 * Detect -> Attribute -> Recover -> Rerun as a durable state machine
 * (item 96).
 *
 * `autofixLoop` (item 35, `src/cli/autofix.ts`) already composes these four
 * phases, but entirely in memory. Confirmed via a live repro: interrupt the
 * process right after a non-idempotent `fix_commands` step runs but before
 * the verification rerun is recorded, and a naive "pick the failure back up
 * and autofix again" restart re-executes that command, duplicating its
 * side effect (a counter meant to land on `"1"` lands on `"11"`).
 *
 * `runDurableRemediation` closes that gap by writing a `RemediationRun` row
 * *before* each phase's side-effecting work begins and *after* it completes,
 * and by exposing `resumeDurableRemediation`, which looks up the latest
 * still-`in_progress` run for a failure and continues from the last durably
 * recorded phase instead of re-running completed recovery effects.
 *
 * Phases:
 *   detect     - the failure/signature is already known (the caller already
 *                captured it via `analyzeCommand`); this phase just opens
 *                the run.
 *   attribute  - `diagnoseFailure` + flaky guard + fix resolution.
 *   recover    - apply the declared patch / run fix_commands. Each concrete
 *                effect is written as `pending` before it runs and flipped to
 *                `applied`/`failed`/`blocked` immediately after, so a crash
 *                mid-recovery leaves an exact, inspectable record of what
 *                already happened instead of silence.
 *   rerun      - re-execute the original command to see whether recovery
 *                took. Observing is not itself a recovery side effect, so
 *                re-executing it on resume (when recovery already finished
 *                but the rerun's outcome was never recorded) is safe to
 *                redo — unlike recovery effects, it carries no duplication
 *                risk for the state machine itself.
 *   done       - terminal; `status` carries the final verdict.
 *
 * Crash-recovery contract: `resumeDurableRemediation` never re-applies a
 * recovery effect already recorded `applied`/`failed`/`blocked` for the
 * current attempt. If the run was interrupted mid-`recover` (some effects
 * `pending`, i.e. we do not know whether they ran), it does NOT guess; it
 * marks those effects `blocked` (treating an unknown-execution-state
 * non-idempotent effect as unsafe to either repeat or silently skip) and
 * halts the run with status `requires_review`, surfacing exactly which
 * effects are of unknown execution state so a human (or a higher-level
 * caller with its own idempotency key) decides what to do next. This
 * mirrors the existing flaky-refusal safety posture (item 25): refuse to
 * guess rather than fail open or closed silently.
 */
import { runCommand } from "../capture/runner.js";
import { ExitCode } from "../cli/exit-codes.js";
import { analyzeCommand, applyFix, diagnoseFailure } from "../core/operations.js";
import { loadDeclaredRules } from "../rules/declared.js";
import { loadPolicy, parseToArgv, validateCommand } from "../security/policy.js";
import type { FailsafeStore } from "../storage/store.js";
import type { FailsafeConfig } from "../types/config.js";
import type { FailureRecord } from "../types/failure.js";
import type {
	RecoveryEffect,
	RemediationAttempt,
	RemediationRun,
	RemediationStatus,
} from "../types/remediation.js";
import { remediationRunId } from "../utils/id.js";

export type DurableRemediationResult = {
	exit_code: number;
	run: RemediationRun;
};

type ResolvedFix = {
	source: string;
	rule_id: string;
	has_patch: boolean;
	fix_commands?: string[];
};

function resolveFix(
	failure: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
): ResolvedFix | null {
	const diagnosis = store.getDiagnosis(failure.failure_id);
	if (!diagnosis || !diagnosis.rule_source || !diagnosis.rule_id) return null;

	if (diagnosis.rule_source === "declared") {
		const rulesFilePath = `${failure.cwd}/${config.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
		const rule = loadDeclaredRules(rulesFilePath).find((r) => r.id === diagnosis.rule_id);
		if (!rule) return null;
		return {
			source: "declared",
			rule_id: rule.id,
			has_patch: !!rule.diagnosis.fix_patch,
			fix_commands: rule.diagnosis.fix_commands,
		};
	}
	if (diagnosis.rule_source === "learned") {
		const learned = store.getLearnedRule(diagnosis.rule_id);
		return {
			source: "learned",
			rule_id: diagnosis.rule_id,
			has_patch: false,
			fix_commands: learned?.fix_commands,
		};
	}
	return { source: diagnosis.rule_source, rule_id: diagnosis.rule_id, has_patch: false };
}

function fixKeyOf(fix: ResolvedFix): string {
	return `${fix.rule_id}|${fix.has_patch}|${(fix.fix_commands ?? []).join(";")}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function persist(store: FailsafeStore, run: RemediationRun, isNew: boolean): void {
	run.updated_at = nowIso();
	if (isNew) store.insertRemediationRun(run);
	else store.updateRemediationRun(run);
}

/**
 * Durably apply one recovery effect: write the `pending` row, perform the
 * side effect, then flip the row to its final status. The `pending` write is
 * what lets `resumeDurableRemediation` tell "never ran" apart from "ran but
 * we crashed before recording the result" for every *other* effect in the
 * attempt. A crash inside this function's own await (between the pending
 * write and the status flip) is the one window this design cannot close
 * without transactional external side effects, which `git apply`/shell
 * commands do not offer — that window is exactly what resume treats as
 * `requires_review` rather than silently guessing.
 */
async function applyPatchEffect(
	current: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
	run: RemediationRun,
	attempt: RemediationAttempt,
): Promise<void> {
	const effect: RecoveryEffect = {
		kind: "patch",
		descriptor: "declared fix_patch",
		status: "pending",
		recorded_at: nowIso(),
	};
	attempt.effects.push(effect);
	persist(store, run, false);

	const applied = await applyFix(current, store, config, { confirm: true });
	const status = String(applied.data.status);
	effect.status = status === "applied" || status === "dry_run" ? "applied" : "failed";
	effect.detail = status;
	effect.files_changed = applied.data.files as string[] | undefined;
	persist(store, run, false);
}

async function runCommandEffects(
	commands: string[],
	cwd: string,
	config: FailsafeConfig,
	timeoutMs: number,
	store: FailsafeStore,
	run: RemediationRun,
	attempt: RemediationAttempt,
): Promise<void> {
	const policy = loadPolicy(config);
	for (const command of commands) {
		const effect: RecoveryEffect = {
			kind: "command",
			descriptor: command,
			status: "pending",
			recorded_at: nowIso(),
		};
		attempt.effects.push(effect);
		// Durably record "about to run" before the side effect, so a crash here
		// leaves `pending` on disk rather than silence.
		persist(store, run, false);

		const validation = validateCommand(command, policy);
		if (!validation.allowed) {
			effect.status = "blocked";
			effect.detail = validation.reason;
			persist(store, run, false);
			continue;
		}
		const parsed = parseToArgv(command);
		if (parsed.kind === "needs_shell") {
			effect.status = "blocked";
			effect.detail = parsed.reason;
			persist(store, run, false);
			continue;
		}
		const res = await runCommand(command, { cwd, timeout_ms: timeoutMs, argv: parsed.argv });
		effect.status = res.exit_code === 0 ? "applied" : "failed";
		persist(store, run, false);
	}
}

function terminal(
	store: FailsafeStore,
	run: RemediationRun,
	status: RemediationStatus,
	exitCode: number,
	message?: string,
): DurableRemediationResult {
	run.phase = "done";
	run.status = status;
	if (message) run.message = message;
	persist(store, run, false);
	return { exit_code: exitCode, run };
}

/** Re-run the attempt's command and interpret the result; shared by the fresh-attempt and resumed-rerun paths. */
async function doRerun(
	run: RemediationRun,
	attempt: RemediationAttempt,
	current: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
	timeoutMs: number,
): Promise<{ done: DurableRemediationResult } | { next: FailureRecord }> {
	run.phase = "rerun";
	persist(store, run, false);

	const rerun = await analyzeCommand(current.command, config, store, { timeoutMs });
	if (!rerun.ok) {
		attempt.rerun_status = "error";
		return { done: terminal(store, run, "rerun_error", ExitCode.ERROR, rerun.error.message) };
	}

	const rerunStatus = String(rerun.data.status) as RemediationAttempt["rerun_status"];
	const rerunId = rerun.data.failure_id as string;
	attempt.rerun_status = rerunStatus;
	attempt.rerun_failure_id = rerunId;
	persist(store, run, false);

	if (rerunStatus === "passed") {
		return {
			done: terminal(store, run, "fixed", ExitCode.OK, "Recovery verified: the re-run passed."),
		};
	}

	const next = store.getFailure(rerunId);
	return { next: next ?? current };
}

/** Diagnose + resolve a fix + recover for a brand-new attempt, then rerun. */
async function runFreshAttempt(
	run: RemediationRun,
	attemptNumber: number,
	current: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
	timeoutMs: number,
	triedFixes: Set<string>,
): Promise<{ done: DurableRemediationResult } | { next: FailureRecord }> {
	run.phase = "attribute";
	persist(store, run, false);

	const diag = await diagnoseFailure(current.failure_id, store, config);
	if (!diag.ok) {
		return { done: terminal(store, run, "rerun_error", diag.error.exit_code, diag.error.message) };
	}

	if (diag.data.severity === "flaky") {
		return {
			done: terminal(
				store,
				run,
				"flaky_refused",
				ExitCode.OK,
				"Failure signature is flaky; refusing to auto-fix. Re-run the command to confirm before fixing.",
			),
		};
	}

	const fix = resolveFix(current, store, config);
	if (!fix || (!fix.has_patch && !(fix.fix_commands && fix.fix_commands.length > 0))) {
		return {
			done: terminal(
				store,
				run,
				"no_fix",
				ExitCode.DEBUG_UNAVAILABLE,
				"No applicable fix (patch or commands) for this failure.",
			),
		};
	}

	const fixKey = fixKeyOf(fix);
	if (triedFixes.has(fixKey)) {
		return {
			done: terminal(
				store,
				run,
				"fix_ineffective",
				ExitCode.ERROR,
				"The same fix was already applied but the failure persists.",
			),
		};
	}
	triedFixes.add(fixKey);
	run.tried_fix_keys = [...triedFixes];

	const attempt: RemediationAttempt = {
		attempt: attemptNumber,
		fix_source: fix.source,
		attributed_failure_id: current.failure_id,
		effects: [],
		rerun_status: "pending",
	};
	run.attempts.push(attempt);
	run.phase = "recover";
	persist(store, run, false);

	if (fix.has_patch) {
		await applyPatchEffect(current, store, config, run, attempt);
	}
	if (fix.fix_commands && fix.fix_commands.length > 0) {
		await runCommandEffects(fix.fix_commands, current.cwd, config, timeoutMs, store, run, attempt);
	}

	return doRerun(run, attempt, current, store, config, timeoutMs);
}

/**
 * Start a brand-new durable remediation run for a failure (phase: `detect`).
 * The caller is expected to have already captured the failure (e.g. via
 * `analyzeCommand`); this opens the run row and immediately drives it through
 * Attribute -> Recover -> Rerun, persisting every transition.
 */
export async function startDurableRemediation(
	failure: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
	opts: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<DurableRemediationResult> {
	const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
	const run: RemediationRun = {
		run_id: remediationRunId(),
		failure_id: failure.failure_id,
		phase: "detect",
		status: "in_progress",
		max_attempts: maxAttempts,
		attempts: [],
		tried_fix_keys: [],
		created_at: nowIso(),
		updated_at: nowIso(),
	};
	store.insertRemediationRun(run);

	const timeoutMs = opts.timeoutMs ?? 120_000;
	const triedFixes = new Set<string>();
	let current = failure;

	for (let attemptNumber = 1; attemptNumber <= run.max_attempts; attemptNumber++) {
		const step = await runFreshAttempt(
			run,
			attemptNumber,
			current,
			store,
			config,
			timeoutMs,
			triedFixes,
		);
		if ("done" in step) return step.done;
		current = step.next;
	}

	return terminal(
		store,
		run,
		"exhausted",
		ExitCode.ERROR,
		`Failure still present after ${run.max_attempts} attempt(s).`,
	);
}

/**
 * Resume the latest `in_progress` durable remediation run for a failure, if
 * any. Returns `null` when there is nothing to resume (no open run — the
 * caller should start a new one via `startDurableRemediation`).
 *
 * This is the crash-recovery entry point: it never re-diagnoses or re-applies
 * recovery effects for an attempt whose effects already reached a final
 * state — it only redoes the (side-effect-free) rerun observation for that
 * attempt, then continues with fresh attempts as needed. If the interrupted
 * attempt left any effect `pending` (crashed mid-recovery, unknown whether
 * the side effect ran), the run is halted at `requires_review` rather than
 * guessing either way.
 */
export async function resumeDurableRemediation(
	failureId: string,
	store: FailsafeStore,
	config: FailsafeConfig,
	opts: { timeoutMs?: number } = {},
): Promise<DurableRemediationResult | null> {
	const run = store.getInProgressRemediationRun(failureId);
	if (!run) return null;

	const timeoutMs = opts.timeoutMs ?? 120_000;
	const triedFixes = new Set(run.tried_fix_keys);
	const lastAttempt = run.attempts.at(-1);

	let current: FailureRecord | null = null;
	let nextAttemptNumber: number;

	if (lastAttempt && lastAttempt.rerun_status === "pending") {
		// Recovery for this attempt was in flight or just finished when the
		// crash happened. If any effect never reached a final state we cannot
		// tell "ran" from "did not run" for a (possibly non-idempotent) side
		// effect — refuse to guess.
		const unknownEffects = lastAttempt.effects.filter((e) => e.status === "pending");
		if (unknownEffects.length > 0) {
			for (const e of unknownEffects) e.status = "blocked";
			return terminal(
				store,
				run,
				"requires_review",
				ExitCode.ERROR,
				`Run was interrupted mid-recovery with ${unknownEffects.length} effect(s) of unknown execution state (process crashed after the effect was recorded pending but before its outcome was recorded). Refusing to guess whether they already ran; a human must inspect and decide whether to resume.`,
			);
		}

		// Every recovery effect for this attempt reached a final state, but the
		// rerun observation never completed (or was never recorded). Redoing
		// the rerun is safe: it is an observation, not a recovery side effect.
		current = store.getFailure(lastAttempt.attributed_failure_id);
		if (!current) {
			return terminal(
				store,
				run,
				"rerun_error",
				ExitCode.ERROR,
				`Attributed failure ${lastAttempt.attributed_failure_id} not found; cannot resume rerun.`,
			);
		}
		const step = await doRerun(run, lastAttempt, current, store, config, timeoutMs);
		if ("done" in step) return step.done;
		current = step.next;
		nextAttemptNumber = lastAttempt.attempt + 1;
	} else if (lastAttempt?.rerun_status === "passed") {
		// The rerun was recorded as `passed` but the crash happened before
		// `terminal()` persisted the run's own `status`/`phase` as `done`/
		// `fixed`. The recovery truly succeeded; finalize accordingly rather
		// than starting another, unnecessary attempt.
		return terminal(store, run, "fixed", ExitCode.OK, "Recovery verified: the re-run passed.");
	} else if (lastAttempt) {
		// The last attempt fully completed (rerun outcome recorded, and it was
		// not `passed`) but the run was never finalized — e.g. crash right
		// after persisting the rerun result and before the loop's
		// next-iteration decision. Continue from its rerun outcome.
		current = lastAttempt.rerun_failure_id
			? (store.getFailure(lastAttempt.rerun_failure_id) ?? null)
			: null;
		if (!current) {
			return terminal(
				store,
				run,
				"rerun_error",
				ExitCode.ERROR,
				"Could not resolve the failure to continue resuming from.",
			);
		}
		nextAttemptNumber = lastAttempt.attempt + 1;
	} else {
		// No attempts recorded yet: the run was opened (phase `detect`) but
		// crashed before the first attempt's diagnosis. Resume from the
		// original failure.
		current = store.getFailure(run.failure_id);
		if (!current) {
			return terminal(
				store,
				run,
				"rerun_error",
				ExitCode.ERROR,
				`Failure ${run.failure_id} not found.`,
			);
		}
		nextAttemptNumber = 1;
	}

	for (let attemptNumber = nextAttemptNumber; attemptNumber <= run.max_attempts; attemptNumber++) {
		const step = await runFreshAttempt(
			run,
			attemptNumber,
			current,
			store,
			config,
			timeoutMs,
			triedFixes,
		);
		if ("done" in step) return step.done;
		current = step.next;
	}

	return terminal(
		store,
		run,
		"exhausted",
		ExitCode.ERROR,
		`Failure still present after ${run.max_attempts} attempt(s).`,
	);
}
