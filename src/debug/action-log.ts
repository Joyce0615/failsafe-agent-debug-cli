/**
 * Process-oriented agent action recording with causal IDs, privacy labels,
 * and deterministic replay (item 31).
 *
 * `debug/trajectory.ts` (item 35) already records a redacted, replayable
 * sequence for ONE narrow action vocabulary (`run`, `set_breakpoint`, `step`,
 * `eval`, `inspect`, `diagnose`, `patch`, `verify` — a debugger session) and
 * a linear DAP-ordering validator. The item 31 ask is broader and different
 * in kind: versioned MCP/A2A/tool/file/process actions across an agent's
 * whole run, each carrying a *causal* id (which action produced the evidence
 * that caused this one — not merely "the next step in sequence") and a
 * *privacy label* per captured value (so diagnosis can later grade how much
 * of "how a result was produced" it is actually allowed to look at).
 * `grep -rln "causal_id\|causalId" src/` before this module returned nothing,
 * and `grep -rln "ActionRecord\|action recording" src/` returned nothing —
 * neither exists anywhere in the codebase.
 *
 * Reused unmodified rather than re-derived:
 *
 * 1. **Redaction + classification is `security/data-classes.ts` (item 62)'s
 *    `classifyValue`/`redactSecrets`.** Every captured input/output/evidence
 *    string is classified into `DataClass`es (secret/pii/prompt/tool_payload)
 *    and secrets are stripped via the SAME detectors `applyDataPolicy`
 *    already uses, so a recorded action can never carry a live credential
 *    forward — exactly the guarantee `TrajectoryRecorder.append` already
 *    gives its own narrower vocabulary.
 * 2. **Schema versioning is `types/common.ts`'s `SCHEMA_VERSION`.** A
 *    recorded action log declares the schema version it was written under,
 *    the same discipline every other persisted Failsafe artifact uses.
 *
 * What is new, because nothing in the repo supplies it:
 *
 * - `ACTION_KINDS` covers the process-oriented surface the item names:
 *   `mcp_call`, `a2a_message`, `tool_call`, `file_op`, `process_op`.
 * - `causal_id` is an EXPLICIT upstream link, set by the caller at record
 *   time (not inferred from sequence order like `trajectory.ts`'s DAP
 *   ordering) — because a tool call's cause is "the MCP call that requested
 *   it", which is not necessarily the immediately preceding record once
 *   concurrent/nested actions exist. `validateActionLog` checks the link
 *   resolves to a KNOWN, EARLIER action: a dangling or forward-pointing
 *   `causal_id` is a causality violation, not a warning, because a caller
 *   that trusts it would reason about a result's provenance backward into
 *   something that cannot have caused it.
 * - `gradeActionLog` is the deterministic replay/grading half of the item:
 *   pure function of the already-redacted action list (same purity
 *   discipline as `trajectory.ts`'s `replayTrajectory`), reporting evidence
 *   completeness (fraction of actions with at least one evidence item) and
 *   per-kind counts, so a diagnosis consumer can grade *how* a result was
 *   produced rather than only *that* it was produced.
 *
 * Pure: no fs/network/process. Mirrors `trajectory.ts`'s
 * recorder/validate/replay/JSONL shape so the two modules read as siblings
 * — one for an interactive debug session, this one for an agent's recorded
 * action stream.
 */
import { type DataClass, classifyValue } from "../security/data-classes.js";
import { redactSecrets } from "../security/redaction.js";
import { SCHEMA_VERSION } from "../types/common.js";

export const ACTION_KINDS = [
	"mcp_call",
	"a2a_message",
	"tool_call",
	"file_op",
	"process_op",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type ActionRecord = {
	schema_version: string;
	id: string;
	task_id: string;
	kind: ActionKind;
	/** The id of the action that caused this one, or undefined for a root action. */
	causal_id?: string;
	sequence: number;
	at_ms: number;
	input: string;
	output: string;
	evidence: string[];
	/** Union of DataClasses found across input/output/evidence, pre-redaction. */
	privacy_labels: DataClass[];
};

function redactValue(value: string): { redacted: string; classes: DataClass[] } {
	const classes = classifyValue("", value);
	return { redacted: redactSecrets(value).redacted, classes };
}

/**
 * Records a process-oriented agent action stream, redacting every captured
 * value and labeling it with the data classes it was found to carry before
 * it is appended — mirrors `TrajectoryRecorder.append`'s redact-before-store
 * discipline, generalized to a richer action vocabulary and explicit causal
 * links instead of implicit sequence ordering.
 */
export class ActionRecorder {
	private records: ActionRecord[] = [];
	private seq = 0;
	private counter = 0;

	constructor(private readonly meta: { task_id: string }) {}

	record(
		kind: ActionKind,
		causalId: string | undefined,
		payload: { input: string; output: string; evidence: string[] },
		atMs = Date.now(),
	): ActionRecord {
		const inputResult = redactValue(payload.input);
		const outputResult = redactValue(payload.output);
		const evidenceResults = payload.evidence.map(redactValue);

		const labels = new Set<DataClass>([
			...inputResult.classes,
			...outputResult.classes,
			...evidenceResults.flatMap((e) => e.classes),
		]);

		const record: ActionRecord = {
			schema_version: SCHEMA_VERSION,
			id: `${this.meta.task_id}-${++this.counter}`,
			task_id: this.meta.task_id,
			kind,
			...(causalId !== undefined ? { causal_id: causalId } : {}),
			sequence: ++this.seq,
			at_ms: atMs,
			input: inputResult.redacted,
			output: outputResult.redacted,
			evidence: evidenceResults.map((e) => e.redacted),
			privacy_labels: [...labels].sort(),
		};
		this.records.push(record);
		return record;
	}

	actions(): ActionRecord[] {
		return [...this.records];
	}
}

export type ActionLogValidation = { valid: boolean; errors: string[] };

/**
 * Validate a recorded action log for causal integrity: every `causal_id`
 * must resolve to a KNOWN action that occurs STRICTLY EARLIER (lower
 * `sequence`) in the same log. A dangling or forward-pointing link is a
 * causality violation — accepting it would let a later analysis reason
 * about a result's provenance through a link that cannot, in fact, have
 * produced it.
 */
export function validateActionLog(actions: ActionRecord[]): ActionLogValidation {
	const errors: string[] = [];
	const bySequence = new Map(actions.map((a) => [a.id, a.sequence]));

	for (const action of actions) {
		if (action.causal_id === undefined) continue;
		const causalSequence = bySequence.get(action.causal_id);
		if (causalSequence === undefined) {
			errors.push(
				`action ${action.id} (sequence ${action.sequence}) has causal_id '${action.causal_id}' which does not resolve to any action in this log`,
			);
			continue;
		}
		if (causalSequence >= action.sequence) {
			errors.push(
				`action ${action.id} (sequence ${action.sequence}) has a forward-pointing causal_id '${action.causal_id}' (sequence ${causalSequence}); a cause cannot occur after its effect`,
			);
		}
	}

	return { valid: errors.length === 0, errors };
}

export type ActionLogGrade = {
	total_actions: number;
	by_kind: Record<ActionKind, number>;
	/** Fraction of actions carrying at least one evidence item. */
	evidence_completeness: number;
	verdict: "well_evidenced" | "under_evidenced";
	caveats: string[];
};

/** Below this fraction of actions carrying evidence, the log is under-evidenced. */
export const EVIDENCE_COMPLETENESS_THRESHOLD = 0.5;

/**
 * Deterministically grade an already-recorded action log: how the result was
 * produced, not merely that it was. Pure function of the (already-redacted)
 * action list — the same replay-determinism discipline
 * `trajectory.ts`'s `replayTrajectory` already uses.
 */
export function gradeActionLog(actions: ActionRecord[]): ActionLogGrade {
	const by_kind = {} as Record<ActionKind, number>;
	for (const kind of ACTION_KINDS) by_kind[kind] = 0;
	for (const action of actions) by_kind[action.kind]++;

	const withEvidence = actions.filter((a) => a.evidence.length > 0).length;
	const evidence_completeness = actions.length === 0 ? 0 : withEvidence / actions.length;
	const verdict: ActionLogGrade["verdict"] =
		evidence_completeness >= EVIDENCE_COMPLETENESS_THRESHOLD ? "well_evidenced" : "under_evidenced";

	const caveats: string[] = [];
	if (actions.length === 0) {
		caveats.push("no actions recorded; nothing to grade");
	} else if (verdict === "under_evidenced") {
		caveats.push(
			`only ${(evidence_completeness * 100).toFixed(0)}% of actions carry evidence, below the ${(EVIDENCE_COMPLETENESS_THRESHOLD * 100).toFixed(0)}% threshold for a diagnosis to trust how the result was produced`,
		);
	}

	return { total_actions: actions.length, by_kind, evidence_completeness, verdict, caveats };
}

/** Serialize a recorded action log to JSONL, one action per line. */
export function toJsonl(actions: ActionRecord[]): string {
	return actions.map((a) => JSON.stringify(a)).join("\n");
}

/** Parse JSONL back into an {@link ActionRecord} array. */
export function fromJsonl(jsonl: string): ActionRecord[] {
	return jsonl
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as ActionRecord);
}
