/**
 * Agent communication fault injection (item 9).
 *
 * `chaos.ts` (item 88) established the right judging question for a
 * component under adverse conditions — not "did it survive" but "did it
 * survive LOUDLY, or did it quietly accept corruption and keep going as if
 * nothing happened". This module asks the same question of the channel
 * between agents, for the six conditions a real multi-agent handoff pipe
 * actually produces:
 *
 *   - **drop** — a message never arrives. The receiver cannot see a message
 *     that was never sent to it; the only observable trace is a gap in an
 *     otherwise-monotonic sequence number, so detection here is a sequence
 *     gap, not a rejected message.
 *   - **duplicate** — the same message (same id) arrives more than once,
 *     e.g. a retry that fires after the original already landed.
 *   - **reorder** — messages from the same sender arrive out of the sequence
 *     order the sender sent them in.
 *   - **stale context** — a message is authored against an older context
 *     snapshot than one the receiver has already acted on from the same
 *     sender (a classic race: agent A reads context v1, is slow, and sends
 *     after agent A's own later message carrying v2 already landed).
 *   - **malformed artifact** — an artifact payload is missing or has
 *     invalid required fields.
 *   - **delayed approval** — an approval response arrives after the
 *     deadline named in its request.
 *
 * `processMessage` is the receiver: it either accepts a message into state,
 * or rejects it with a named fault, or (for `drop`, which is detected
 * on the *next* message, not the missing one) accepts a legitimate new
 * message while separately flagging the gap it revealed. Rejecting a
 * message that is itself fine (because *mentioning* a dropped predecessor
 * is not the same as the message being bad) would be exactly the kind of
 * false alarm that erodes trust in the gate; the distinction is deliberate.
 *
 * `injectCommFault` is the complementary half: pure transforms of a planned
 * message stream into the stream a receiver actually sees, one per fault
 * kind, so `runCommFaultSuite` can replay the corrupted stream through
 * `processMessage` and report, per scenario, whether the fault was caught
 * (`handled_loudly`) or silently absorbed (`silently_corrupted`) — the same
 * `unaffected`/`degraded_loudly`/`degraded_silently` vocabulary `chaos.ts`
 * already uses, because the judgement is the same judgement.
 *
 * Pure: no network, no clock (`sent_at_ms` plays the role of "now" the way
 * `chaos.ts`'s `ts_ms` does); the PRNG injectors take an explicit seed.
 */
import { mulberry32, randomInt } from "../utils/random.js";

export const COMM_FAULT_KINDS = [
	"drop",
	"duplicate",
	"reorder",
	"stale_context",
	"malformed_artifact",
	"delayed_approval",
] as const;
export type CommFaultKind = (typeof COMM_FAULT_KINDS)[number];

export type AgentMessageKind = "handoff" | "artifact" | "approval_request" | "approval_response";

export type AgentMessage = {
	id: string;
	from: string;
	to: string;
	kind: AgentMessageKind;
	/** Monotonic per (from, to) pair, in the order the sender actually sent them. */
	seq: number;
	/** Plays the role of "now" for this message, the way `chaos.ts`'s `ts_ms` does. */
	sent_at_ms: number;
	/** The context snapshot version this message was authored against. */
	context_version: number;
	payload: Record<string, unknown>;
};

/** What a receiver must remain able to say when a condition occurs. */
export const OBSERVABILITY_EXPECTATIONS: Record<CommFaultKind, string> = {
	drop: "a gap in an otherwise-monotonic sequence must be reported; a receiver that cannot tell it skipped a message cannot tell it lost one",
	duplicate:
		"a repeated message id must be rejected and named a duplicate, not silently re-applied as if it were new work",
	reorder:
		"a message that arrives behind one later in the sender's own sequence must be flagged, not accepted as if the sender's order never mattered",
	stale_context:
		"a message authored against a context version older than one already acted on from the same sender must be rejected, not blended into state as if it were current",
	malformed_artifact:
		"an artifact missing or failing its required-field shape must be rejected before use, not passed through to whatever consumes it",
	delayed_approval:
		"an approval response arriving after its own request's deadline must be treated as expired, not honored as if the deadline never applied",
};

export type MessageOutcome = {
	message_id: string;
	/** False exactly for the five faults that must be rejected outright. */
	accepted: boolean;
	/** Null when nothing was wrong with this message. */
	fault_detected: CommFaultKind | null;
	reason: string;
};

export type MailboxState = {
	seenIds: Set<string>;
	maxSeqBySender: Map<string, number>;
	maxContextVersionBySender: Map<string, number>;
	/** approval_request id -> its own declared response_deadline_ms. */
	pendingApprovalDeadlines: Map<string, number>;
};

export function createMailbox(): MailboxState {
	return {
		seenIds: new Set(),
		maxSeqBySender: new Map(),
		maxContextVersionBySender: new Map(),
		pendingApprovalDeadlines: new Map(),
	};
}

const REQUIRED_ARTIFACT_FIELDS = ["name", "sha256", "bytes"] as const;

function isWellFormedArtifact(payload: Record<string, unknown>): boolean {
	for (const field of REQUIRED_ARTIFACT_FIELDS) {
		if (!(field in payload)) return false;
	}
	if (typeof payload.name !== "string" || payload.name.length === 0) return false;
	if (typeof payload.sha256 !== "string" || payload.sha256.length !== 64) return false;
	if (typeof payload.bytes !== "number" || !Number.isFinite(payload.bytes) || payload.bytes < 0) {
		return false;
	}
	return true;
}

function senderKey(message: AgentMessage): string {
	return `${message.from}>${message.to}`;
}

function outcome(
	message_id: string,
	accepted: boolean,
	fault_detected: CommFaultKind | null,
	reason: string,
): MessageOutcome {
	return { message_id, accepted, fault_detected, reason };
}

/**
 * Process one message against mailbox state, mutating state in place and
 * returning what happened.
 *
 * Checks run in a fixed, deliberate order because each check's correctness
 * depends on the ones before it having already run: a duplicate must be
 * caught before anything updates sequence/context state from it (replaying
 * a duplicate's seq would hide a real reorder on the ORIGINAL message if it
 * somehow arrived a second time between two others); sequence gap/order
 * must be resolved before context staleness is judged, because an
 * out-of-order message's context_version says nothing about what the
 * sender's *current* context actually is.
 */
export function processMessage(state: MailboxState, message: AgentMessage): MessageOutcome {
	if (state.seenIds.has(message.id)) {
		return outcome(message.id, false, "duplicate", `message '${message.id}' was already processed`);
	}
	state.seenIds.add(message.id);

	const key = senderKey(message);
	const maxSeq = state.maxSeqBySender.get(key);

	if (maxSeq !== undefined && message.seq <= maxSeq) {
		return outcome(
			message.id,
			false,
			"reorder",
			`seq ${message.seq} from '${message.from}' arrived after seq ${maxSeq} from the same sender`,
		);
	}

	// A gap is detectable both mid-stream (seq jumped by more than one from
	// the last message seen from this sender) and at the very start: the
	// protocol's own convention is that a sender's seq space starts at 0, so
	// a FIRST-ever message from a sender whose seq is not 0 reveals that its
	// predecessor(s) were dropped before this receiver ever saw this sender
	// at all -- the receiver does not need prior state to know that.
	const gapDetected = maxSeq !== undefined ? message.seq > maxSeq + 1 : message.seq > 0;
	state.maxSeqBySender.set(key, message.seq);

	const maxContext = state.maxContextVersionBySender.get(key);
	if (maxContext !== undefined && message.context_version < maxContext) {
		return outcome(
			message.id,
			false,
			"stale_context",
			`message was authored against context v${message.context_version}, but v${maxContext} from '${message.from}' has already been acted on`,
		);
	}
	state.maxContextVersionBySender.set(
		key,
		Math.max(maxContext ?? Number.NEGATIVE_INFINITY, message.context_version),
	);

	if (message.kind === "approval_request") {
		const deadline = message.payload.response_deadline_ms;
		if (typeof deadline === "number") {
			state.pendingApprovalDeadlines.set(message.id, deadline);
		}
	}

	if (message.kind === "approval_response") {
		const requestId = message.payload.request_id;
		if (typeof requestId === "string") {
			const deadline = state.pendingApprovalDeadlines.get(requestId);
			if (deadline !== undefined) {
				state.pendingApprovalDeadlines.delete(requestId);
				if (message.sent_at_ms > deadline) {
					return outcome(
						message.id,
						false,
						"delayed_approval",
						`approval response for '${requestId}' arrived ${message.sent_at_ms - deadline}ms past its ${deadline}ms deadline`,
					);
				}
			}
		}
	}

	if (message.kind === "artifact" && !isWellFormedArtifact(message.payload)) {
		return outcome(
			message.id,
			false,
			"malformed_artifact",
			`artifact payload is missing or has an invalid required field (${REQUIRED_ARTIFACT_FIELDS.join(", ")})`,
		);
	}

	if (gapDetected) {
		return outcome(
			message.id,
			true,
			"drop",
			`seq jumped from ${maxSeq} to ${message.seq} for sender '${message.from}'; at least one message in between was never received`,
		);
	}

	return outcome(message.id, true, null, "accepted");
}

export type CommFaultScenario = {
	kind: CommFaultKind;
	/** Which message ids this scenario acts on. */
	target_ids: string[];
	/** Extra copies for `duplicate`; slots shifted for `reorder`; version/ms offset for `stale_context`/`delayed_approval`. */
	magnitude?: number;
};

/**
 * Transform a planned message stream into the stream a receiver actually
 * sees under one fault scenario. Pure; does not mutate `messages`.
 */
export function injectCommFault(
	messages: AgentMessage[],
	scenario: CommFaultScenario,
): AgentMessage[] {
	const targets = new Set(scenario.target_ids);

	switch (scenario.kind) {
		case "drop":
			return messages.filter((m) => !targets.has(m.id));

		case "duplicate": {
			const copies = Math.max(1, scenario.magnitude ?? 1);
			const result: AgentMessage[] = [];
			for (const m of messages) {
				result.push(m);
				if (targets.has(m.id)) {
					for (let i = 0; i < copies; i++) result.push({ ...m });
				}
			}
			return result;
		}

		case "reorder": {
			const shift = Math.max(1, scenario.magnitude ?? 1);
			const result = [...messages];
			// Move each targeted message later by `shift` slots, latest target
			// first so repeated shifts do not re-collide with an already-moved one.
			const indices = result
				.map((m, i) => (targets.has(m.id) ? i : -1))
				.filter((i) => i >= 0)
				.sort((a, b) => b - a);
			for (const i of indices) {
				const dest = Math.min(result.length - 1, i + shift);
				const [item] = result.splice(i, 1);
				result.splice(dest, 0, item);
			}
			return result;
		}

		case "stale_context": {
			const back = Math.max(1, scenario.magnitude ?? 1);
			return messages.map((m) =>
				targets.has(m.id) ? { ...m, context_version: Math.max(0, m.context_version - back) } : m,
			);
		}

		case "malformed_artifact":
			return messages.map((m) => {
				if (!targets.has(m.id)) return m;
				const { sha256: _drop, ...rest } = m.payload;
				return { ...m, payload: rest };
			});

		case "delayed_approval": {
			const delay = Math.max(1, scenario.magnitude ?? 1);
			return messages.map((m) =>
				targets.has(m.id) ? { ...m, sent_at_ms: m.sent_at_ms + delay } : m,
			);
		}
	}
}

export const RESILIENCE_VERDICTS = ["unaffected", "handled_loudly", "silently_corrupted"] as const;
export type CommResilienceVerdict = (typeof RESILIENCE_VERDICTS)[number];

export type CommFaultReport = {
	scenario: CommFaultKind;
	target_count: number;
	verdict: CommResilienceVerdict;
	/** Outcomes for every targeted message id, in replay order. */
	target_outcomes: MessageOutcome[];
	detail: string;
};

/**
 * Replay one scenario's actual arrival stream through a fresh mailbox and
 * judge whether every targeted fault was caught.
 */
export function assessCommResilience(
	baseline: AgentMessage[],
	scenario: CommFaultScenario,
): CommFaultReport {
	const actual = injectCommFault(baseline, scenario);
	const mailbox = createMailbox();
	const outcomes = actual.map((m) => processMessage(mailbox, m));

	// What counts as "the outcome(s) that should show evidence of this fault"
	// differs by kind, because the fault changes a different thing about the
	// stream:
	//  - `drop` removes messages entirely, so the evidence lives on whichever
	//    later message's seq gap reveals the hole -- never on the dropped
	//    ids themselves, which never arrive.
	//  - `duplicate` inserts EXTRA copies that share an id with a message
	//    already in the baseline. The first occurrence of that id is the
	//    original, legitimate message and must still be accepted normally;
	//    only the extra copies are the fault, so only they are judged.
	//  - every other kind modifies exactly one existing message per target
	//    id without changing how many messages carry that id, so filtering
	//    by id gives exactly the outcome(s) to judge.
	let targetOutcomes: MessageOutcome[];
	if (scenario.kind === "drop") {
		targetOutcomes = outcomes.filter((o) => o.fault_detected === "drop");
	} else if (scenario.kind === "duplicate") {
		const seenCountByTargetId = new Map<string, number>();
		targetOutcomes = [];
		for (const o of outcomes) {
			if (!scenario.target_ids.includes(o.message_id)) continue;
			const seen = seenCountByTargetId.get(o.message_id) ?? 0;
			seenCountByTargetId.set(o.message_id, seen + 1);
			if (seen > 0) targetOutcomes.push(o); // skip the first (original) occurrence
		}
	} else {
		targetOutcomes = outcomes.filter((o) => scenario.target_ids.includes(o.message_id));
	}

	const caught = targetOutcomes.filter((o) => o.fault_detected === scenario.kind);

	let verdict: CommResilienceVerdict;
	if (scenario.target_ids.length === 0) {
		verdict = "unaffected";
	} else if (targetOutcomes.length === 0) {
		// drop with nothing to reveal the gap (e.g. the dropped message was
		// the sender's last) is the one case with no evidence to check at all.
		verdict = scenario.kind === "drop" ? "silently_corrupted" : "unaffected";
	} else if (caught.length === targetOutcomes.length) {
		verdict = "handled_loudly";
	} else {
		verdict = "silently_corrupted";
	}

	const detail =
		verdict === "unaffected"
			? "no messages were targeted, or nothing about this scenario changed the stream; this run establishes nothing"
			: verdict === "handled_loudly"
				? `every targeted ${scenario.kind} instance was caught and rejected (or, for drop, the gap it left was flagged)`
				: `${targetOutcomes.length - caught.length} of ${targetOutcomes.length} targeted ${scenario.kind} instance(s) were silently accepted`;

	return {
		scenario: scenario.kind,
		target_count: scenario.target_ids.length,
		verdict,
		target_outcomes: targetOutcomes,
		detail,
	};
}

export type CommFaultSuiteResult = {
	reports: CommFaultReport[];
	silently_corrupted: CommFaultKind[];
	untested: CommFaultKind[];
	caveats: string[];
};

/** Run every scenario against the same baseline stream and summarize. */
export function runCommFaultSuite(
	baseline: AgentMessage[],
	scenarios: CommFaultScenario[],
): CommFaultSuiteResult {
	const reports = scenarios.map((scenario) => assessCommResilience(baseline, scenario));
	const tested = new Set(scenarios.map((s) => s.kind));
	const untested = COMM_FAULT_KINDS.filter((kind) => !tested.has(kind));
	const silentlyCorrupted = reports
		.filter((r) => r.verdict === "silently_corrupted")
		.map((r) => r.scenario);

	const caveats: string[] = [];
	if (untested.length > 0) {
		caveats.push(
			`${untested.length} condition(s) were not exercised (${untested.join(", ")}); this run establishes nothing about them`,
		);
	}
	if (silentlyCorrupted.length > 0) {
		caveats.push(
			`${silentlyCorrupted.length} condition(s) were silently absorbed (${silentlyCorrupted.join(", ")}): a corrupted message was accepted with no rejection`,
		);
	}
	if (baseline.length === 0) {
		caveats.push("the baseline stream is empty; every scenario passed vacuously");
	}

	return { reports, silently_corrupted: silentlyCorrupted, untested, caveats };
}

/**
 * A deterministic baseline conversation: `handoff`/`artifact` messages from
 * one agent, framed by an `approval_request`/`approval_response` pair.
 * Reproducible from `seed` alone.
 */
export function commBaseline(seed: number, count = 10): AgentMessage[] {
	const rand = mulberry32(seed);
	const messages: AgentMessage[] = [];
	let contextVersion = 1;
	for (let i = 0; i < count; i++) {
		if (rand() < 0.15) contextVersion++;
		const kind: AgentMessageKind = i === 0 ? "handoff" : rand() < 0.5 ? "handoff" : "artifact";
		messages.push({
			id: `msg-${seed}-${i}`,
			from: "agent-a",
			to: "agent-b",
			kind,
			seq: i,
			sent_at_ms: 1000 + i * 100,
			context_version: contextVersion,
			payload:
				kind === "artifact"
					? { name: `artifact-${i}`, sha256: "a".repeat(64), bytes: randomInt(rand, 1, 1000) }
					: { note: `handoff ${i}` },
		});
	}
	const requestAt = count;
	messages.push({
		id: `msg-${seed}-approval-req`,
		from: "agent-b",
		to: "agent-a",
		kind: "approval_request",
		// A fresh sender pair ("agent-b" -> "agent-a") starts its own seq
		// space at 0; reusing `requestAt` (the "agent-a" -> "agent-b"
		// counter) would be meaningless here since seq is scoped per
		// (from, to) pair, not global across the whole conversation.
		seq: 0,
		sent_at_ms: 1000 + requestAt * 100,
		context_version: contextVersion,
		payload: { response_deadline_ms: 1000 + requestAt * 100 + 500 },
	});
	messages.push({
		id: `msg-${seed}-approval-resp`,
		from: "agent-a",
		to: "agent-b",
		kind: "approval_response",
		// Same sender pair as the handoff/artifact messages above
		// ("agent-a" -> "agent-b"), so this continues THAT pair's seq
		// space immediately after the last one of those (`count - 1`),
		// not the unrelated request-side counter.
		seq: count,
		sent_at_ms: 1000 + requestAt * 100 + 100,
		context_version: contextVersion,
		payload: { request_id: `msg-${seed}-approval-req`, approved: true },
	});
	return messages;
}
