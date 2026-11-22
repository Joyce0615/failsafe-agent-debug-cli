/**
 * Diagnose MCP multi-round tool-response (MRTR) stalls and response
 * mismatches (item 51, module-header numbering: item 116, confirmed
 * next-free via `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t'
 * ' -k2 -n -u | tail`, highest prior being item 115 from item 49's
 * `handoff-continuity.ts`).
 *
 * MCP's MRTR pattern (multi-round tool response) lets a tool call pause
 * mid-execution, emit an `input_required` round naming exactly what it
 * needs, and resume once the caller supplies it — a request/response
 * exchange layered INSIDE a single tool call, with its own state machine
 * (`round_id`, `request_state`, retry parameters) distinct from the
 * request/response pairing `partial-order.ts` (item 8) and
 * `async-lifecycle-race.ts` (item 47) already reason about for ordinary
 * calls and Task lifecycle events.
 *
 * `grep -rln "mrtr\|input.required\|input_required\|elicitation\|multi.round" src
 * --include="*.ts" -i` returned nothing before this module: no module in
 * this project has any notion of an MRTR round, let alone one that can
 * tell a genuinely missing response from a replayed one, or a state
 * mismatch from a parameter drift.
 *
 * This module adds exactly that vocabulary and four independently
 * testable checks over a single MRTR exchange's own recorded rounds —
 * nothing here re-derives clock-skew-corrected ordering or causal links;
 * `MrtrRound`s are already caller-ordered by `sequence`, mirroring
 * `trace/integrity.ts`'s (item 67) own "producer sequence number, when
 * the exporter supplies one" discipline, because an MRTR exchange is a
 * single logical call with its own monotonic round counter, not a
 * distributed set of spans needing skew correction:
 *
 * 1. **Missing response.** An `input_required` round with no later round
 *    of kind `response` carrying the SAME `round_id` is a stall — the
 *    caller never answered (or the answer never arrived) and the tool
 *    call cannot make progress. Distinguished from `replayed_response`
 *    below rather than folded into one "mismatch" bucket, because the two
 *    need different fixes: one needs a response sent, the other needs a
 *    duplicate suppressed.
 * 2. **Replayed response.** Two OR MORE `response` rounds carrying the
 *    SAME `round_id` — the same answer (or a differing one) delivered
 *    twice. Reported with `identical_payload` so a caller can tell a
 *    harmless idempotent redelivery from a genuinely conflicting second
 *    answer, mirroring `trace/integrity.ts`'s own "duplicate with
 *    identical content vs. duplicate with differing content are different
 *    defects" distinction.
 * 3. **Request-state mismatch.** A `response` round whose `request_state`
 *    does not match the `input_required` round's own `request_state` for
 *    the SAME `round_id` — the caller answered a round that has since
 *    moved on (e.g. the tool re-issued the same `round_id` with a new
 *    `request_state` after a timeout, and an earlier answer arrived
 *    late). This is reported distinctly from retry-parameter drift
 *    (below) because a state mismatch means the ANSWER no longer applies
 *    to the CURRENT ask, while parameter drift means the ASK ITSELF
 *    changed without a new `round_id`.
 * 4. **Retry parameter drift.** Two `input_required` rounds with the SAME
 *    `round_id` whose `retry_params` differ — the tool silently changed
 *    what it is asking for (a different field, a different format) while
 *    claiming to be the same ask, which breaks a caller that cached the
 *    first ask's shape.
 * 5. **Infinite input loop.** `MAX_ROUND_REPEATS` (mirrors `stopping.ts`'s
 *    item 75 own named-threshold discipline, not a magic inline number)
 *    `input_required` rounds for the SAME `round_id` with no intervening
 *    accepted response is reported as its own finding kind rather than
 *    merely N copies of "missing response" — a loop is a structurally
 *    different failure (the tool keeps re-asking) from a single stall
 *    (the tool asked once and nothing came back).
 *
 * `locateFirstViolatedRound` names the single earliest-`sequence` finding
 * (ties broken by `round_id`, deterministic), mirroring
 * `authorization-drift.ts`'s (item 44) own `locateFirstConstraintLoss`
 * "name where the chain FIRST actually broke, not every downstream
 * symptom of it" discipline.
 *
 * Pure: no fs/network/process. The caller supplies an already-captured,
 * already-sequenced `MrtrRound[]` for one MRTR exchange; this module never
 * re-derives sequencing or clock-skew itself.
 */

export const MRTR_ROUND_KINDS = ["input_required", "response"] as const;
export type MrtrRoundKind = (typeof MRTR_ROUND_KINDS)[number];

export type RetryParams = Record<string, unknown>;

export type MrtrRound = {
	/** Monotonic position within this single MRTR exchange; the sole ordering truth this module uses. */
	sequence: number;
	round_id: string;
	kind: MrtrRoundKind;
	/** Opaque state token the tool attaches to an ask and expects echoed back on the matching answer. */
	request_state: string;
	/** Present on `input_required` rounds: what the tool is asking for this time. */
	retry_params?: RetryParams;
	/** Present on `response` rounds: the caller's answer payload, compared by deep equality for replay detection. */
	payload?: unknown;
};

export const MRTR_FINDING_KINDS = [
	"missing_response",
	"replayed_response",
	"request_state_mismatch",
	"retry_parameter_drift",
	"infinite_input_loop",
] as const;
export type MrtrFindingKind = (typeof MRTR_FINDING_KINDS)[number];

export type MrtrFinding = {
	kind: MrtrFindingKind;
	round_id: string;
	/** The earliest `sequence` among the rounds this finding is evidenced by. */
	sequence: number;
	/** Round sequences this finding's evidence came from, in encounter order. */
	evidence_sequences: number[];
	detail: string;
};

/** Repeated `input_required` rounds for the same `round_id`, past this count with no accepted response between them, is reported as an infinite input loop rather than N separate missing-response findings. */
export const MAX_ROUND_REPEATS = 3;

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function byRoundId(rounds: MrtrRound[]): Map<string, MrtrRound[]> {
	const groups = new Map<string, MrtrRound[]>();
	for (const r of rounds) {
		const group = groups.get(r.round_id);
		if (group) group.push(r);
		else groups.set(r.round_id, [r]);
	}
	for (const group of groups.values()) group.sort((a, b) => a.sequence - b.sequence);
	return groups;
}

/**
 * Detect every finding kind across every `round_id` present in `rounds`.
 *
 * A `round_id` with `MAX_ROUND_REPEATS` or more `input_required` rounds and
 * zero accepted responses is reported ONLY as `infinite_input_loop` — the
 * individual `input_required` rounds that make up the loop are not also
 * separately reported as `missing_response`, since the loop finding already
 * names every one of them as evidence and a caller does not need the same
 * repeats reported twice under different names.
 */
export function diagnoseMrtrStalls(rounds: MrtrRound[]): MrtrFinding[] {
	const findings: MrtrFinding[] = [];
	const groups = byRoundId(rounds);

	for (const [roundId, group] of groups) {
		const asks = group.filter((r) => r.kind === "input_required");
		const answers = group.filter((r) => r.kind === "response");

		// 5. Infinite input loop takes priority over missing_response for this round_id.
		if (asks.length >= MAX_ROUND_REPEATS && answers.length === 0) {
			findings.push({
				kind: "infinite_input_loop",
				round_id: roundId,
				sequence: asks[0].sequence,
				evidence_sequences: asks.map((a) => a.sequence),
				detail: `round '${roundId}' re-issued 'input_required' ${asks.length} time(s) with zero accepted responses — the tool kept re-asking instead of stalling once`,
			});
		} else if (asks.length > 0 && answers.length === 0) {
			// 1. Missing response: at least one ask, never answered, and not a loop.
			findings.push({
				kind: "missing_response",
				round_id: roundId,
				sequence: asks[0].sequence,
				evidence_sequences: asks.map((a) => a.sequence),
				detail: `round '${roundId}' asked for input at sequence ${asks[0].sequence} and never received a response`,
			});
		}

		// 2. Replayed response: 2+ response rounds for the same round_id.
		if (answers.length >= 2) {
			for (let i = 1; i < answers.length; i++) {
				const first = answers[0];
				const dup = answers[i];
				const identical = deepEqual(first.payload, dup.payload);
				findings.push({
					kind: "replayed_response",
					round_id: roundId,
					sequence: first.sequence,
					evidence_sequences: [first.sequence, dup.sequence],
					detail: `round '${roundId}' received a second 'response' at sequence ${dup.sequence} after the first at ${first.sequence}; payloads are ${identical ? "identical (idempotent redelivery)" : "DIFFERENT (conflicting answers)"}`,
				});
			}
		}

		// 3. Request-state mismatch: a response whose request_state does not
		// match the MOST RECENT preceding input_required round's request_state.
		for (const answer of answers) {
			const precedingAsks = asks.filter((a) => a.sequence < answer.sequence);
			if (precedingAsks.length === 0) continue;
			const latestAsk = precedingAsks[precedingAsks.length - 1];
			if (latestAsk.request_state !== answer.request_state) {
				findings.push({
					kind: "request_state_mismatch",
					round_id: roundId,
					sequence: latestAsk.sequence,
					evidence_sequences: [latestAsk.sequence, answer.sequence],
					detail: `round '${roundId}' response at sequence ${answer.sequence} carries request_state '${answer.request_state}', but the latest preceding ask at sequence ${latestAsk.sequence} expects '${latestAsk.request_state}' — this answer no longer applies to the current ask`,
				});
			}
		}

		// 4. Retry parameter drift: 2+ input_required rounds for the same
		// round_id whose retry_params differ.
		for (let i = 1; i < asks.length; i++) {
			const prev = asks[i - 1];
			const cur = asks[i];
			if (!deepEqual(prev.retry_params, cur.retry_params)) {
				findings.push({
					kind: "retry_parameter_drift",
					round_id: roundId,
					sequence: prev.sequence,
					evidence_sequences: [prev.sequence, cur.sequence],
					detail: `round '${roundId}' re-asked at sequence ${cur.sequence} with different retry_params than the ask at sequence ${prev.sequence}, while claiming the same round_id`,
				});
			}
		}
	}

	return findings;
}

export type MrtrReport = {
	findings: MrtrFinding[];
	first_violated_round: MrtrFinding | null;
};

/**
 * Diagnose every finding, then name the single earliest-`sequence`
 * violation (ties broken by `round_id`, deterministic) — the point in the
 * exchange where something FIRST went wrong, not every downstream symptom.
 */
export function diagnoseMrtrExchange(rounds: MrtrRound[]): MrtrReport {
	const findings = diagnoseMrtrStalls(rounds);
	const sorted = [...findings].sort((a, b) =>
		a.sequence !== b.sequence ? a.sequence - b.sequence : a.round_id < b.round_id ? -1 : 1,
	);
	return { findings, first_violated_round: sorted[0] ?? null };
}

/** Render a human-readable MRTR diagnosis report. */
export function renderMrtrReport(report: MrtrReport): string {
	const lines: string[] = ["# MRTR Stall & Response Mismatch Report", ""];
	if (report.findings.length === 0) {
		lines.push("No MRTR violations found.");
		return lines.join("\n");
	}
	lines.push(
		report.first_violated_round
			? `First violated round: [${report.first_violated_round.kind}] round '${report.first_violated_round.round_id}' at sequence ${report.first_violated_round.sequence}`
			: "First violated round: none",
	);
	lines.push("");
	lines.push("## Findings");
	for (const f of report.findings) {
		lines.push(`- [${f.kind}] round '${f.round_id}' (sequence ${f.sequence}): ${f.detail}`);
	}
	return lines.join("\n");
}
