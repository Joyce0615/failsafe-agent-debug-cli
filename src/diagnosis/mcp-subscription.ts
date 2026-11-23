/**
 * Diagnose MCP subscription loss and cross-talk (item 52, module-header
 * numbering: item 117, confirmed next-free via `grep -rohE "item [0-9]+"
 * src --include="*.ts" | sort -t' ' -k2 -n -u | tail`, highest prior
 * being item 116 from item 51's `mrtr.ts`).
 *
 * `grep -rln "subscription\|subscribe\|cross.talk\|crosstalk" src
 * --include="*.ts" -i` before this module matched only
 * `telemetry/mcp-conventions.ts` (a one-line mention that
 * `resources/subscribe`/`resources/unsubscribe` exist, with no modeling
 * of their lifecycle) and `diagnosis/async-lifecycle-race.ts` (item 47),
 * which treats `subscription_fired` as one more delivery kind that can
 * duplicate a TASK's side effect — it has no notion of the subscription
 * ITSELF: who owns it, what resource it was asked to watch, whether its
 * ack preceded its first update, or whether it closed cleanly. No module
 * answered "is this update genuinely lost, or merely unproven to have
 * arrived" before this one.
 *
 * `resources/subscribe` -> `resources/updated` notifications -> optional
 * `resources/unsubscribe` is MCP's own lifecycle for a long-lived
 * resource watch, distinct from the single-call MRTR exchange `mrtr.ts`
 * (item 51) models and from the Task lifecycle `async-lifecycle-race.ts`
 * (item 47) models: a subscription is not one request/response pair, it
 * is an open-ended STREAM of `resources/updated` deliveries against one
 * acknowledged registration, which can itself be delivered to the wrong
 * client (cross-talk), skip updates (loss), or close without ever being
 * told to (abrupt closure).
 *
 * Six independently testable checks, one subscription_id at a time:
 *
 * 1. **Acknowledgment-first ordering.** Any `update_delivered` whose
 *    `sequence` precedes the subscription's own `subscribe_acked`
 *    `sequence` (or that has NO ack recorded at all before it)
 *    violates "ack before deliver" — the server started pushing updates
 *    for a subscription it had not yet (or never) confirmed.
 * 2. **Subscription ownership / cross-talk.** Any event whose `owner_id`
 *    differs from the subscription's OWN established owner (the
 *    `owner_id` on its `subscribe_requested`/`subscribe_acked`) is
 *    cross-talk: an update, or an unsubscribe, meant for one client
 *    reaching another.
 * 3. **Requested event type.** An `update_delivered` whose
 *    `resource_uri` differs from the `resource_uri` the subscription
 *    actually requested is an unrequested delivery — the subscriber is
 *    being told about a resource it never asked to watch.
 * 4. **Duplicate updates.** Two or more `update_delivered` events
 *    sharing the same `update_sequence` for the same `subscription_id`,
 *    distinguished (mirroring `trace/integrity.ts`'s item 67 own
 *    "duplicate with identical content is redelivery; duplicate with
 *    differing content is a different defect" discipline) by whether
 *    their payloads are identical.
 * 5. **Gaps -- confirmed loss vs. transport uncertainty.** `update_sequence`
 *    is an OPTIONAL, server-supplied authoritative counter. When two or
 *    more updates for a subscription carry it, a numeric gap between
 *    consecutive values is CONFIRMED loss (the server's own counter
 *    proves something was skipped) and reported as a `confirmed_gap`
 *    finding. When a subscription's updates carry NO `update_sequence`
 *    at all, this module explicitly REFUSES to guess at loss from
 *    timing or count alone — mirroring `authorization-drift.ts`'s
 *    (item 44) own `lost_policy_source` discipline of reporting an
 *    evidence gap as an evidence gap, not as a diagnosis — and instead
 *    names that subscription in `transport_uncertain_subscriptions`,
 *    deliberately NOT a finding, so a caller can tell "proven lost" from
 *    "cannot be proven either way" at a glance.
 * 6. **Graceful vs. abrupt closure.** A `connection_closed` event for a
 *    subscription with no preceding `unsubscribe_requested` or
 *    `unsubscribe_acked` anywhere in its own event history is an
 *    `abrupt_closure`; one preceded by either is graceful and reported
 *    as nothing.
 *
 * Pure: no fs/network/process. The caller supplies an already-captured,
 * already-sequenced `SubscriptionEvent[]`; this module never re-derives
 * sequencing, clock-skew, or transport state itself.
 */

export const SUBSCRIPTION_EVENT_KINDS = [
	"subscribe_requested",
	"subscribe_acked",
	"update_delivered",
	"unsubscribe_requested",
	"unsubscribe_acked",
	"connection_closed",
] as const;
export type SubscriptionEventKind = (typeof SUBSCRIPTION_EVENT_KINDS)[number];

export type SubscriptionEvent = {
	/** Monotonic position across this subscription's own recorded events; the sole ordering truth this module uses. */
	sequence: number;
	subscription_id: string;
	/** The client/session this event concerns. */
	owner_id: string;
	kind: SubscriptionEventKind;
	/** Present on subscribe_requested/subscribe_acked (what was asked for) and update_delivered (what this update is about). */
	resource_uri?: string;
	/**
	 * Present on update_delivered ONLY when the server/transport actually
	 * supplies an authoritative counter for this subscription. Its absence
	 * is not itself a finding — it just means gap detection for this
	 * subscription's updates is impossible, and this module says so rather
	 * than guessing.
	 */
	update_sequence?: number;
	payload?: unknown;
};

export const SUBSCRIPTION_FINDING_KINDS = [
	"acknowledgment_order_violation",
	"cross_talk",
	"unrequested_resource",
	"duplicate_update",
	"confirmed_gap",
	"abrupt_closure",
] as const;
export type SubscriptionFindingKind = (typeof SUBSCRIPTION_FINDING_KINDS)[number];

export type SubscriptionFinding = {
	kind: SubscriptionFindingKind;
	subscription_id: string;
	/** The earliest `sequence` among the events this finding is evidenced by. */
	sequence: number;
	evidence_sequences: number[];
	detail: string;
};

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function byId(events: SubscriptionEvent[]): Map<string, SubscriptionEvent[]> {
	const groups = new Map<string, SubscriptionEvent[]>();
	for (const e of events) {
		const group = groups.get(e.subscription_id);
		if (group) group.push(e);
		else groups.set(e.subscription_id, [e]);
	}
	for (const group of groups.values()) group.sort((a, b) => a.sequence - b.sequence);
	return groups;
}

export type SubscriptionDiagnosis = {
	findings: SubscriptionFinding[];
	/**
	 * Subscription ids whose updates carried NO `update_sequence` at all --
	 * loss cannot be confirmed OR ruled out for them. Deliberately kept out
	 * of `findings`: this is an evidence gap, not evidence of a defect.
	 */
	transport_uncertain_subscriptions: string[];
};

/** Diagnose every finding kind, and separately name every subscription whose loss cannot be confirmed either way, across all `subscription_id`s present in `events`. */
export function diagnoseSubscriptionEvents(events: SubscriptionEvent[]): SubscriptionDiagnosis {
	const findings: SubscriptionFinding[] = [];
	const transportUncertain: string[] = [];
	const groups = byId(events);

	for (const [subId, group] of groups) {
		const subscribeRequested = group.find((e) => e.kind === "subscribe_requested");
		const subscribeAcked = group.find((e) => e.kind === "subscribe_acked");
		const updates = group.filter((e) => e.kind === "update_delivered");
		const establishedOwner = subscribeRequested?.owner_id ?? subscribeAcked?.owner_id;
		const establishedUri = subscribeRequested?.resource_uri ?? subscribeAcked?.resource_uri;

		// 1. Acknowledgment-first ordering.
		const ackSequence = subscribeAcked?.sequence ?? Number.POSITIVE_INFINITY;
		for (const update of updates) {
			if (update.sequence < ackSequence) {
				findings.push({
					kind: "acknowledgment_order_violation",
					subscription_id: subId,
					sequence: update.sequence,
					evidence_sequences: subscribeAcked
						? [update.sequence, subscribeAcked.sequence]
						: [update.sequence],
					detail: subscribeAcked
						? `subscription '${subId}' delivered an update at sequence ${update.sequence} before its own ack at sequence ${subscribeAcked.sequence}`
						: `subscription '${subId}' delivered an update at sequence ${update.sequence} with no 'subscribe_acked' recorded at all`,
				});
			}
		}

		// 2. Subscription ownership / cross-talk.
		if (establishedOwner !== undefined) {
			for (const e of group) {
				if (e === subscribeRequested) continue;
				if (e.owner_id !== establishedOwner) {
					findings.push({
						kind: "cross_talk",
						subscription_id: subId,
						sequence: e.sequence,
						evidence_sequences: [e.sequence],
						detail: `subscription '${subId}' is owned by '${establishedOwner}', but its '${e.kind}' event at sequence ${e.sequence} belongs to '${e.owner_id}'`,
					});
				}
			}
		}

		// 3. Requested event type.
		if (establishedUri !== undefined) {
			for (const update of updates) {
				if (update.resource_uri !== undefined && update.resource_uri !== establishedUri) {
					findings.push({
						kind: "unrequested_resource",
						subscription_id: subId,
						sequence: update.sequence,
						evidence_sequences: [update.sequence],
						detail: `subscription '${subId}' requested '${establishedUri}' but its update at sequence ${update.sequence} is about '${update.resource_uri}'`,
					});
				}
			}
		}

		// 4. Duplicate updates, grouped by update_sequence.
		const byUpdateSeq = new Map<number, SubscriptionEvent[]>();
		for (const update of updates) {
			if (update.update_sequence === undefined) continue;
			const bucket = byUpdateSeq.get(update.update_sequence);
			if (bucket) bucket.push(update);
			else byUpdateSeq.set(update.update_sequence, [update]);
		}
		for (const bucket of byUpdateSeq.values()) {
			if (bucket.length < 2) continue;
			const [first, ...rest] = bucket;
			for (const dup of rest) {
				const identical = deepEqual(first.payload, dup.payload);
				findings.push({
					kind: "duplicate_update",
					subscription_id: subId,
					sequence: first.sequence,
					evidence_sequences: [first.sequence, dup.sequence],
					detail: `subscription '${subId}' received update_sequence ${first.update_sequence} twice (sequence ${first.sequence} and ${dup.sequence}); payloads are ${identical ? "identical (idempotent redelivery)" : "DIFFERENT (conflicting updates)"}`,
				});
			}
		}

		// 5. Gaps: confirmed loss vs. transport uncertainty.
		const withUpdateSeq = updates.filter((u) => u.update_sequence !== undefined);
		if (withUpdateSeq.length === 0 && updates.length > 0) {
			transportUncertain.push(subId);
		} else if (withUpdateSeq.length >= 2) {
			const sorted = [...withUpdateSeq].sort(
				(a, b) => (a.update_sequence as number) - (b.update_sequence as number),
			);
			for (let i = 1; i < sorted.length; i++) {
				const prev = sorted[i - 1].update_sequence as number;
				const cur = sorted[i].update_sequence as number;
				if (cur - prev > 1) {
					const missing: number[] = [];
					for (let m = prev + 1; m < cur; m++) missing.push(m);
					findings.push({
						kind: "confirmed_gap",
						subscription_id: subId,
						sequence: sorted[i - 1].sequence,
						evidence_sequences: [sorted[i - 1].sequence, sorted[i].sequence],
						detail: `subscription '${subId}' update_sequence jumped from ${prev} to ${cur}; missing update_sequence value(s): ${missing.join(", ")}`,
					});
				}
			}
		}

		// 6. Graceful vs. abrupt closure.
		const closed = group.find((e) => e.kind === "connection_closed");
		if (closed) {
			const unsubscribed = group.some(
				(e) =>
					(e.kind === "unsubscribe_requested" || e.kind === "unsubscribe_acked") &&
					e.sequence <= closed.sequence,
			);
			if (!unsubscribed) {
				findings.push({
					kind: "abrupt_closure",
					subscription_id: subId,
					sequence: closed.sequence,
					evidence_sequences: [closed.sequence],
					detail: `subscription '${subId}' closed at sequence ${closed.sequence} with no preceding 'unsubscribe_requested' or 'unsubscribe_acked'`,
				});
			}
		}
	}

	return { findings, transport_uncertain_subscriptions: transportUncertain.sort() };
}

export type SubscriptionReport = SubscriptionDiagnosis & {
	first_violation: SubscriptionFinding | null;
};

/**
 * Diagnose every finding, then name the single earliest-`sequence`
 * violation (ties broken by `subscription_id`, deterministic) — mirrors
 * `authorization-drift.ts`'s (item 44) `locateFirstConstraintLoss` and
 * `mrtr.ts`'s (item 51) `first_violated_round` "name where the exchange
 * FIRST broke, not every downstream symptom" discipline.
 */
export function diagnoseSubscriptionExchange(events: SubscriptionEvent[]): SubscriptionReport {
	const diagnosis = diagnoseSubscriptionEvents(events);
	const sorted = [...diagnosis.findings].sort((a, b) =>
		a.sequence !== b.sequence
			? a.sequence - b.sequence
			: a.subscription_id < b.subscription_id
				? -1
				: 1,
	);
	return { ...diagnosis, first_violation: sorted[0] ?? null };
}

/** Render a human-readable subscription diagnosis report. */
export function renderSubscriptionReport(report: SubscriptionReport): string {
	const lines: string[] = ["# MCP Subscription Loss & Cross-Talk Report", ""];
	if (report.findings.length === 0 && report.transport_uncertain_subscriptions.length === 0) {
		lines.push("No subscription violations found, and no transport uncertainty.");
		return lines.join("\n");
	}
	lines.push(
		report.first_violation
			? `First violation: [${report.first_violation.kind}] subscription '${report.first_violation.subscription_id}' at sequence ${report.first_violation.sequence}`
			: "First violation: none",
	);
	lines.push("");
	lines.push("## Findings");
	if (report.findings.length === 0) lines.push("None.");
	for (const f of report.findings) {
		lines.push(
			`- [${f.kind}] subscription '${f.subscription_id}' (sequence ${f.sequence}): ${f.detail}`,
		);
	}
	lines.push("");
	lines.push("## Transport-uncertain subscriptions (loss cannot be confirmed or ruled out)");
	if (report.transport_uncertain_subscriptions.length === 0) lines.push("None.");
	for (const id of report.transport_uncertain_subscriptions) lines.push(`- ${id}`);
	return lines.join("\n");
}
