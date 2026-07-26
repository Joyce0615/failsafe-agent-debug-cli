/**
 * Debug-Gym-compatible interactive-debug trajectory harness (item 35).
 *
 * Microsoft Debug-Gym models debugging as an ordered sequence of debugger/tool
 * actions and observations over a task. This module defines a portable JSONL
 * trajectory schema for that sequence — `run`, breakpoints, step/eval/inspect
 * observations, diagnoses, patches, and verify outcomes — plus a recorder that
 * redacts every observation before persistence, a deterministic replayer, and a
 * validator that rejects a trajectory containing an unredacted secret, an
 * out-of-order DAP action, or a mismatched repository SHA.
 *
 * Everything here is pure (no fs/network/process) so episodes can be recorded,
 * serialized to JSONL, replayed, and scored reproducibly in tests/CI.
 */
import { z } from "zod";
import { SECRET_PATTERNS, redactSecrets } from "../security/redaction.js";
import { estimateTokens } from "../utils/tokens.js";

/** The ordered action kinds a debugging episode can contain. */
export const TrajectoryActionSchema = z.enum([
	"run",
	"set_breakpoint",
	"step",
	"eval",
	"inspect",
	"diagnose",
	"patch",
	"verify",
]);
export type TrajectoryAction = z.infer<typeof TrajectoryActionSchema>;

/** DAP-style actions that only make sense after a session is live at a breakpoint. */
const DAP_ACTIONS: ReadonlySet<TrajectoryAction> = new Set(["step", "eval", "inspect"]);

export const TrajectoryStepSchema = z.object({
	/** Strictly increasing, starting at 1. */
	sequence: z.number().int().positive(),
	action: TrajectoryActionSchema,
	/** The concrete command/expression/patch summary for this action. */
	input: z.string(),
	/** The observation (redacted before persistence). */
	observation: z.string(),
	/** Optional source provenance for the action. */
	location: z.object({ file: z.string(), line: z.number().int() }).optional(),
});
export type TrajectoryStep = z.infer<typeof TrajectoryStepSchema>;

export const TrajectoryBudgetSchema = z.object({
	max_steps: z.number().int().positive().optional(),
	max_tokens: z.number().int().positive().optional(),
	max_ms: z.number().int().positive().optional(),
});
export type TrajectoryBudget = z.infer<typeof TrajectoryBudgetSchema>;

export const TrajectorySchema = z.object({
	schema_version: z.literal("0.1"),
	task_id: z.string(),
	/** Repository SHA the episode was recorded against (provenance). */
	repo_sha: z.string(),
	/** The command under debug. */
	command: z.string(),
	budget: TrajectoryBudgetSchema.optional(),
	steps: z.array(TrajectoryStepSchema),
	outcome: z.enum(["resolved", "unresolved", "aborted"]),
	elapsed_ms: z.number().int().nonnegative().default(0),
});
export type Trajectory = z.infer<typeof TrajectorySchema>;

/**
 * Records an episode step-by-step, redacting every observation/input before it
 * is appended so a secret can never enter the persisted trajectory.
 */
export class TrajectoryRecorder {
	private steps: TrajectoryStep[] = [];
	private seq = 0;

	constructor(
		private readonly meta: {
			task_id: string;
			repo_sha: string;
			command: string;
			budget?: TrajectoryBudget;
		},
	) {}

	/** Append an action + observation; both are redacted before storage. */
	append(
		action: TrajectoryAction,
		input: string,
		observation: string,
		location?: { file: string; line: number },
	): TrajectoryStep {
		const step: TrajectoryStep = {
			sequence: ++this.seq,
			action,
			input: redactSecrets(input).redacted,
			observation: redactSecrets(observation).redacted,
			...(location ? { location } : {}),
		};
		this.steps.push(step);
		return step;
	}

	/** Finalize the trajectory with an outcome + elapsed time. */
	finish(outcome: Trajectory["outcome"], elapsedMs = 0): Trajectory {
		return {
			schema_version: "0.1",
			task_id: this.meta.task_id,
			repo_sha: this.meta.repo_sha,
			command: this.meta.command,
			budget: this.meta.budget,
			steps: this.steps,
			outcome,
			elapsed_ms: elapsedMs,
		};
	}
}

export type TrajectoryValidation = { valid: boolean; errors: string[] };

/** Scan a string for any known secret pattern (post-redaction leak check). */
function containsSecret(text: string): boolean {
	for (const pattern of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(text)) return true;
	}
	return false;
}

/**
 * Validate a trajectory for replay: sequence integrity, DAP action ordering
 * (a step/eval/inspect must follow `run` + a `set_breakpoint`), budget limits,
 * secret-freedom, and — when `expectedSha` is given — repository-SHA provenance.
 */
export function validateTrajectory(
	trajectory: Trajectory,
	opts: { expectedSha?: string } = {},
): TrajectoryValidation {
	const errors: string[] = [];

	// Provenance: repository SHA must match the expected checkout.
	if (opts.expectedSha !== undefined && trajectory.repo_sha !== opts.expectedSha) {
		errors.push(
			`repo_sha mismatch: trajectory recorded against ${trajectory.repo_sha}, expected ${opts.expectedSha}`,
		);
	}

	let hasRun = false;
	let hasBreakpoint = false;
	for (let i = 0; i < trajectory.steps.length; i++) {
		const step = trajectory.steps[i];

		// Sequence must be strictly increasing from 1.
		if (step.sequence !== i + 1) {
			errors.push(`step ${i} has out-of-order sequence ${step.sequence} (expected ${i + 1})`);
		}

		// DAP actions require a live, broken session.
		if (DAP_ACTIONS.has(step.action) && !(hasRun && hasBreakpoint)) {
			errors.push(
				`out-of-order DAP action '${step.action}' at step ${step.sequence} before run+breakpoint`,
			);
		}

		// Secrets must have been redacted before persistence.
		if (containsSecret(step.input) || containsSecret(step.observation)) {
			errors.push(`unredacted secret at step ${step.sequence}`);
		}

		if (step.action === "run") hasRun = true;
		if (step.action === "set_breakpoint") hasBreakpoint = true;
	}

	// Budget enforcement.
	const budget = trajectory.budget;
	if (budget?.max_steps !== undefined && trajectory.steps.length > budget.max_steps) {
		errors.push(`step budget exceeded: ${trajectory.steps.length} > ${budget.max_steps}`);
	}
	if (budget?.max_ms !== undefined && trajectory.elapsed_ms > budget.max_ms) {
		errors.push(`time budget exceeded: ${trajectory.elapsed_ms}ms > ${budget.max_ms}ms`);
	}
	const tokens = replayTokenCost(trajectory);
	if (budget?.max_tokens !== undefined && tokens > budget.max_tokens) {
		errors.push(`token budget exceeded: ${tokens} > ${budget.max_tokens}`);
	}

	return { valid: errors.length === 0, errors };
}

/** Estimated token cost of a trajectory (sum over step input+observation bytes). */
export function replayTokenCost(trajectory: Trajectory): number {
	let bytes = 0;
	for (const step of trajectory.steps) {
		bytes += Buffer.byteLength(step.input) + Buffer.byteLength(step.observation);
	}
	return estimateTokens(bytes);
}

export type ReplayResult = {
	task_id: string;
	outcome: Trajectory["outcome"];
	steps: number;
	actions: TrajectoryAction[];
	resolved: boolean;
	tokens_used: number;
};

/**
 * Deterministically replay a (validated) trajectory into a compact score. Pure:
 * the same trajectory always yields the same result, so episodes are comparable
 * across runs under identical budgets.
 */
export function replayTrajectory(trajectory: Trajectory): ReplayResult {
	return {
		task_id: trajectory.task_id,
		outcome: trajectory.outcome,
		steps: trajectory.steps.length,
		actions: trajectory.steps.map((s) => s.action),
		resolved: trajectory.outcome === "resolved",
		tokens_used: replayTokenCost(trajectory),
	};
}

/** Serialize a trajectory to JSONL (metadata line + one line per step). */
export function toJsonl(trajectory: Trajectory): string {
	const header = {
		schema_version: trajectory.schema_version,
		task_id: trajectory.task_id,
		repo_sha: trajectory.repo_sha,
		command: trajectory.command,
		budget: trajectory.budget,
		outcome: trajectory.outcome,
		elapsed_ms: trajectory.elapsed_ms,
	};
	return [JSON.stringify(header), ...trajectory.steps.map((s) => JSON.stringify(s))].join("\n");
}

/** Parse JSONL back into a validated {@link Trajectory}. */
export function fromJsonl(jsonl: string): Trajectory {
	const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) throw new Error("empty trajectory");
	const header = JSON.parse(lines[0]) as Record<string, unknown>;
	const steps = lines.slice(1).map((l) => JSON.parse(l));
	return TrajectorySchema.parse({ ...header, steps });
}
