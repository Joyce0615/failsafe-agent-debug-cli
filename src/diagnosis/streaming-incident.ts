/**
 * Streaming incident diagnosis (item 35).
 *
 * `hypothesis.ts` (item 43) already tracks a Bayesian hypothesis tree, and
 * its own `recordObservation` already lets a later refuting observation flip
 * a hypothesis that was previously `confirmed` to `refuted` -- status is NOT
 * monotonic there. `partial-order.ts` (item 8) already combines causal facts
 * and clock evidence into a partial order, recomputed from scratch each call
 * -- the same "recompute from the full accumulated history" discipline
 * `memory/project-index.ts`'s `refreshProjectIndex` already uses. Neither
 * module has any notion of a live SESSION: nothing decides when a changing
 * belief is worth telling an operator about, nothing says a previously
 * reported conclusion must be explicitly withdrawn (not just quietly
 * overwritten) when superseded, and nothing bounds how many times a noisy
 * sequence of events can re-alert.
 *
 * This module adds exactly that session, composing both unmodified:
 *
 * 1. **Update as events arrive.** `ingestLiveEvent` appends the new event's
 *    causal link (if any) to the accumulated history and calls
 *    `reconstructPartialOrder` over the FULL accumulated event list -- the
 *    same full-recompute honesty `refreshProjectIndex` already uses rather
 *    than a bespoke incremental graph algorithm. If the event carries an
 *    observation, it is applied via `recordObservation` unmodified.
 * 2. **Retraction is a named, logged event, not a silent overwrite.** Every
 *    time this module emits an `Alert` naming a hypothesis as the current
 *    leading conclusion, it remembers that alert. If a later event changes
 *    that hypothesis's status away from what it was when the alert fired
 *    (most concretely: `confirmed` -> `refuted`, which `recordObservation`
 *    already allows), a `Retraction` is emitted that names the alert it
 *    supersedes and why -- the operator is told the earlier conclusion was
 *    wrong, not left to notice a dashboard quietly changed.
 * 3. **Alert churn is bounded by an explicit budget, not implicitly by
 *    however often the leading hypothesis happens to change.** An alert is
 *    only even considered when the LEADING hypothesis's identity changes
 *    (not on every posterior wobble), and even then only if the session has
 *    not exceeded `max_alerts` and at least `cooldown_events` have elapsed
 *    since the last alert. A would-be alert suppressed by the budget is
 *    recorded as a `suppressed` entry -- the churn being bounded is itself
 *    visible, not silently dropped.
 * 4. **The final snapshot is reproducible.** `streamingSnapshot` canonicalizes
 *    (via `exchange/bundle.ts`'s `canonicalize`, unmodified) the session's
 *    accumulated, deterministic state and hashes it -- replaying the exact
 *    same event sequence through a fresh session always yields the same
 *    hash, because every function this module calls is itself pure.
 *
 * Pure: no fs, network, or clock (event order is the caller's own
 * `sequence`, not wall-clock arrival time), so a session is fully
 * reproducible from its event log alone.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "../exchange/bundle.js";
import {
	type HypothesisTree,
	type Observation,
	recordObservation,
	summarize,
} from "./hypothesis.js";
import { type CausalLink, reconstructPartialOrder } from "./partial-order.js";
import type { NormalizedEvent } from "./timeline.js";

export type StreamEvent = {
	/** Strictly increasing arrival sequence number, assigned by the caller. */
	sequence: number;
	/** A timing fact to fold into the accumulated partial order, if any. */
	timing?: NormalizedEvent;
	/** An explicit happens-before fact to fold into the accumulated partial order, if any. */
	causal_link?: CausalLink;
	/** A new observation against one hypothesis, if this event carries one. */
	observation?: { hypothesis_id: string; observation: Observation };
};

export type AlertChurnBudget = {
	/** Maximum alerts a session may emit, ever. */
	max_alerts: number;
	/** Minimum events that must elapse between two alerts. */
	cooldown_events: number;
};

export const DEFAULT_CHURN_BUDGET: AlertChurnBudget = { max_alerts: 5, cooldown_events: 1 };

export type Alert = {
	at_sequence: number;
	hypothesis_id: string;
	statement: string;
	posterior: number;
	status: string;
	/** Set once a later event supersedes this alert. */
	retracted?: true;
};

export type Retraction = {
	at_sequence: number;
	/** The alert's own `at_sequence`, identifying which alert this retracts. */
	retracts_alert_at_sequence: number;
	hypothesis_id: string;
	previous_status: string;
	new_status: string;
	reason: string;
};

export type SuppressedAlert = {
	at_sequence: number;
	hypothesis_id: string;
	reason: "max_alerts_reached" | "cooldown_not_elapsed";
};

export type StreamingSession = {
	schema_version: "0.1";
	failure_id: string;
	tree: HypothesisTree;
	/** Every timing fact accumulated so far, in arrival order. */
	events: NormalizedEvent[];
	/** Every causal link accumulated so far, in arrival order. */
	links: CausalLink[];
	processed: number;
	alerts: Alert[];
	retractions: Retraction[];
	suppressed: SuppressedAlert[];
	leading_hypothesis_id?: string;
	last_alert_at_sequence?: number;
};

export function newStreamingSession(failureId: string, tree: HypothesisTree): StreamingSession {
	return {
		schema_version: "0.1",
		failure_id: failureId,
		tree,
		events: [],
		links: [],
		processed: 0,
		alerts: [],
		retractions: [],
		suppressed: [],
	};
}

/**
 * Fold one live event into the session: accumulate its timing/causal facts,
 * recompute the partial order over the full accumulated history, apply its
 * observation (if any) to the hypothesis tree, and decide -- under the churn
 * budget -- whether the result is worth a new alert or a retraction of an
 * earlier one.
 */
export function ingestLiveEvent(
	session: StreamingSession,
	event: StreamEvent,
	budget: AlertChurnBudget = DEFAULT_CHURN_BUDGET,
): StreamingSession {
	const events = event.timing ? [...session.events, event.timing] : session.events;
	const links = event.causal_link ? [...session.links, event.causal_link] : session.links;
	// Full recompute over the accumulated history -- never trusted incrementally.
	reconstructPartialOrder(events, links);

	let tree = session.tree;
	if (event.observation) {
		tree = recordObservation(
			tree,
			event.observation.hypothesis_id,
			event.observation.observation,
		).tree;
	}

	const alerts = [...session.alerts];
	const retractions = [...session.retractions];
	const suppressed = [...session.suppressed];

	// Retraction: any PREVIOUS alert whose named hypothesis has since changed
	// status is explicitly superseded, regardless of whether a new alert fires
	// this cycle.
	for (const alert of alerts) {
		if (alert.retracted) continue;
		const h = tree.hypotheses.find((x) => x.id === alert.hypothesis_id);
		if (!h || h.status === alert.status) continue;
		alert.retracted = true;
		retractions.push({
			at_sequence: event.sequence,
			retracts_alert_at_sequence: alert.at_sequence,
			hypothesis_id: alert.hypothesis_id,
			previous_status: alert.status,
			new_status: h.status,
			reason: `hypothesis '${alert.hypothesis_id}' changed from '${alert.status}' to '${h.status}' after sequence ${event.sequence}; the earlier conclusion is retracted, not silently overwritten`,
		});
	}

	const summary = summarize(tree);
	const leadingId = summary.leading?.id;
	let leadingHypothesisId = session.leading_hypothesis_id;
	let lastAlertAtSequence = session.last_alert_at_sequence;

	if (leadingId !== undefined && leadingId !== session.leading_hypothesis_id) {
		leadingHypothesisId = leadingId;
		const sinceLastAlert =
			lastAlertAtSequence === undefined
				? Number.POSITIVE_INFINITY
				: event.sequence - lastAlertAtSequence;
		const alertsEmittedSoFar = alerts.length;
		if (alertsEmittedSoFar >= budget.max_alerts) {
			suppressed.push({
				at_sequence: event.sequence,
				hypothesis_id: leadingId,
				reason: "max_alerts_reached",
			});
		} else if (sinceLastAlert < budget.cooldown_events) {
			suppressed.push({
				at_sequence: event.sequence,
				hypothesis_id: leadingId,
				reason: "cooldown_not_elapsed",
			});
		} else {
			const h = tree.hypotheses.find((x) => x.id === leadingId);
			if (h) {
				alerts.push({
					at_sequence: event.sequence,
					hypothesis_id: h.id,
					statement: h.statement,
					posterior: h.posterior,
					status: h.status,
				});
				lastAlertAtSequence = event.sequence;
			}
		}
	}

	return {
		...session,
		tree,
		events,
		links,
		processed: session.processed + 1,
		alerts,
		retractions,
		suppressed,
		leading_hypothesis_id: leadingHypothesisId,
		last_alert_at_sequence: lastAlertAtSequence,
	};
}

export type StreamingSnapshot = {
	failure_id: string;
	processed: number;
	final_status_by_hypothesis: Record<string, string>;
	active_alerts: Alert[];
	retractions: Retraction[];
	suppressed: SuppressedAlert[];
	/** Content hash of the above, deterministic across identical replays. */
	snapshot_hash: string;
};

/**
 * A reproducible final snapshot: replaying the exact same sequence of
 * `StreamEvent`s through a fresh session always yields the same
 * `snapshot_hash`, because every function this module composes is itself
 * pure.
 */
export function streamingSnapshot(session: StreamingSession): StreamingSnapshot {
	const finalStatusByHypothesis: Record<string, string> = {};
	for (const h of session.tree.hypotheses) finalStatusByHypothesis[h.id] = h.status;

	const body = {
		failure_id: session.failure_id,
		processed: session.processed,
		final_status_by_hypothesis: finalStatusByHypothesis,
		active_alerts: session.alerts.filter((a) => !a.retracted),
		retractions: session.retractions,
		suppressed: session.suppressed,
	};
	const snapshotHash = createHash("sha256").update(canonicalize(body)).digest("hex").slice(0, 32);

	return { ...body, snapshot_hash: snapshotHash };
}
