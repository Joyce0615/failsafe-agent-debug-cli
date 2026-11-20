/**
 * Diagnose asynchronous Task lifecycle races: retries, webhooks,
 * subscriptions, expiry, and cancellation racing against the task's own
 * side effect (item 47, module-header numbering: item 113, confirmed
 * next-free via `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t'
 * ' -k2 -n -u`, highest prior being item 112 from item 46's
 * `leakage-trace.ts`).
 *
 * `grep -rln "webhook\|subscription\|cancellation.*race\|async.*lifecycle\|
 * task.*expir" src --include="*.ts"` before this module matched nothing
 * project-specific (the sole hit, `redaction.ts`'s `SLACK_WEBHOOK_URL`
 * constant, is unrelated). `partial-order.ts` (item 8) already answers "is
 * event A known to happen before event B, or is their order genuinely
 * undetermined" from causal links and skew-corrected clocks — reused here
 * UNMODIFIED as the one source of ordering truth, exactly the discipline
 * `incident-graph.ts` (item 22) already established for the same module.
 * This module adds the Task-lifecycle vocabulary (`trigger_fired`,
 * `retry_fired`, `webhook_delivered`, `subscription_fired`, `expired`,
 * `cancel_requested`, ...) and the one question `partial-order.ts` cannot
 * answer on its own: when two lifecycle events for the SAME task are
 * `concurrent()` (order genuinely undetermined, not merely unknown), did
 * EACH one independently execute the task's side effect — which is a race
 * that duplicates real work — or did only one, in which case the
 * concurrency is a harmless scheduling ambiguity, not a bug.
 *
 * Two kinds of race, deliberately kept DISTINCT rather than folded into
 * one "racy pair" shape, because they represent different failures:
 *
 * 1. **Duplicate delivery** (`retry_duplication` / `webhook_duplicate_delivery`
 *    / `subscription_duplicate_fire`): two deliveries of the SAME kind for
 *    the same task that are mutually concurrent. A retry firing because its
 *    deadline expired while the original attempt was still silently
 *    in-flight is the textbook case this item names.
 * 2. **Boundary race** (`cancellation_race` / `expiry_race`): a
 *    `cancel_requested` or `expired` boundary signal concurrent with ANY
 *    effect-applying event for the same task. The boundary signal's whole
 *    point is to prevent the effect; concurrency with it means the attempt
 *    to stop the task and the task's own completion were racing, and
 *    `effect_duplicated` on the finding tells a caller which one actually
 *    ran (almost always exactly one — a boundary signal is not itself a
 *    delivery — so `effect_duplicated` on a boundary race being `true`
 *    is its own, rarer, signal that the boundary handler ALSO re-ran the
 *    effect while "cancelling").
 *
 * `effect_duplicated` is computed uniformly from the finding's own two
 * `legs`' `effect_applied` flags (both `true` => genuinely duplicated;
 * otherwise merely raced) rather than special-cased per race kind, so one
 * rule explains every finding's evidence field.
 *
 * `reconstructTaskSchedule` asks the companion "deterministic schedule"
 * question the item also names: a stable sort by `happensBefore` is a
 * valid linear extension of the partial order whenever one exists, and
 * `undetermined_pairs` (every pair the schedule had to arbitrarily break
 * a tie on, read straight off `order.concurrent`) is the honest admission
 * that the schedule is ONE valid linearization, not THE schedule, exactly
 * where `partial-order.ts`'s own `concurrent()` already drew that line.
 *
 * Pure: no fs/network/process/clock. Every lifecycle event and the
 * `PartialOrderResult` ordering it is checked against are caller-supplied
 * — this module never re-derives ordering evidence, only asks
 * `partial-order.ts`'s own `happensBefore`/`concurrent` primitives.
 */
import type { PartialOrderResult } from "./partial-order.js";

export const LIFECYCLE_EVENT_KINDS = [
	"created",
	"trigger_fired",
	"started",
	"retry_scheduled",
	"retry_fired",
	"webhook_delivered",
	"subscription_fired",
	"expired",
	"cancel_requested",
	"completed",
] as const;
export type LifecycleEventKind = (typeof LIFECYCLE_EVENT_KINDS)[number];

/** Delivery-like kinds: each is capable of independently re-executing a task's side effect. */
const DELIVERY_KINDS = ["retry_fired", "webhook_delivered", "subscription_fired"] as const;
type DeliveryKind = (typeof DELIVERY_KINDS)[number];

const DELIVERY_RACE_KIND: Record<
	DeliveryKind,
	"retry_duplication" | "webhook_duplicate_delivery" | "subscription_duplicate_fire"
> = {
	retry_fired: "retry_duplication",
	webhook_delivered: "webhook_duplicate_delivery",
	subscription_fired: "subscription_duplicate_fire",
};

/** Boundary kinds: signals whose whole purpose is to PREVENT the task's effect from running. */
const BOUNDARY_KINDS = ["cancel_requested", "expired"] as const;
type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

const BOUNDARY_RACE_KIND: Record<BoundaryKind, "cancellation_race" | "expiry_race"> = {
	cancel_requested: "cancellation_race",
	expired: "expiry_race",
};

export type LifecycleEvent = {
	id: string;
	task_id: string;
	kind: LifecycleEventKind;
	/** Whether HANDLING this event actually executed the task's side effect (vs. a no-op, e.g. a retry that found the task already completed and skipped). */
	effect_applied: boolean;
};

export const RACE_KINDS = [
	"retry_duplication",
	"webhook_duplicate_delivery",
	"subscription_duplicate_fire",
	"cancellation_race",
	"expiry_race",
] as const;
export type RaceKind = (typeof RACE_KINDS)[number];

export type RaceFinding = {
	task_id: string;
	kind: RaceKind;
	/** The two event ids whose order is genuinely undetermined (`order.concurrent` is true for this pair). */
	legs: [string, string];
	/** `true` iff BOTH legs independently executed the task's side effect. */
	effect_duplicated: boolean;
	detail: string;
};

function pairKey(a: string, b: string): string {
	return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Duplicate-delivery races: same task, same delivery-like kind, two events
 * whose order `order.concurrent` reports as genuinely undetermined.
 */
export function detectDuplicateDeliveryRaces(
	events: LifecycleEvent[],
	order: PartialOrderResult,
): RaceFinding[] {
	const findings: RaceFinding[] = [];
	const seenPairs = new Set<string>();

	const byTaskAndKind = new Map<string, LifecycleEvent[]>();
	for (const event of events) {
		if (!(DELIVERY_KINDS as readonly string[]).includes(event.kind)) continue;
		const key = `${event.task_id}\u0000${event.kind}`;
		const group = byTaskAndKind.get(key);
		if (group) group.push(event);
		else byTaskAndKind.set(key, [event]);
	}

	for (const group of byTaskAndKind.values()) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i];
				const b = group[j];
				if (!order.concurrent(a.id, b.id)) continue;
				const pk = pairKey(a.id, b.id);
				if (seenPairs.has(pk)) continue;
				seenPairs.add(pk);
				findings.push({
					task_id: a.task_id,
					kind: DELIVERY_RACE_KIND[a.kind as DeliveryKind],
					legs: [a.id, b.id],
					effect_duplicated: a.effect_applied && b.effect_applied,
					detail: `'${a.id}' and '${b.id}' are both '${a.kind}' deliveries for task '${a.task_id}' with a genuinely undetermined order${a.effect_applied && b.effect_applied ? "; both independently executed the task's side effect" : "; only one side's effect actually ran"}`,
				});
			}
		}
	}

	return findings;
}

/**
 * Boundary races: a `cancel_requested`/`expired` signal for a task,
 * concurrent with ANY OTHER event for the same task.
 */
export function detectBoundaryRaces(
	events: LifecycleEvent[],
	order: PartialOrderResult,
): RaceFinding[] {
	const findings: RaceFinding[] = [];
	const seenPairs = new Set<string>();

	const byTask = new Map<string, LifecycleEvent[]>();
	for (const event of events) {
		const group = byTask.get(event.task_id);
		if (group) group.push(event);
		else byTask.set(event.task_id, [event]);
	}

	for (const group of byTask.values()) {
		const boundaries = group.filter((e) => (BOUNDARY_KINDS as readonly string[]).includes(e.kind));
		for (const boundary of boundaries) {
			for (const other of group) {
				if (other.id === boundary.id) continue;
				if (!order.concurrent(boundary.id, other.id)) continue;
				const pk = pairKey(boundary.id, other.id);
				if (seenPairs.has(pk)) continue;
				seenPairs.add(pk);
				findings.push({
					task_id: boundary.task_id,
					kind: BOUNDARY_RACE_KIND[boundary.kind as BoundaryKind],
					legs: [boundary.id, other.id],
					effect_duplicated: boundary.effect_applied && other.effect_applied,
					detail: `'${boundary.id}' (${boundary.kind}) and '${other.id}' (${other.kind}) for task '${boundary.task_id}' have a genuinely undetermined order; the ${boundary.kind === "cancel_requested" ? "cancellation" : "expiry"} signal raced the task's own progress${other.effect_applied ? ", which executed its side effect" : ""}`,
				});
			}
		}
	}

	return findings;
}

export type AsyncLifecycleRaceReport = {
	findings: RaceFinding[];
	/** `task_id`s with at least one finding where `effect_duplicated` is true, in encounter order. */
	duplicated_task_ids: string[];
};

/** Diagnose all races (duplicate-delivery and boundary) across every task present in `events`. */
export function diagnoseAsyncLifecycleRaces(
	events: LifecycleEvent[],
	order: PartialOrderResult,
): AsyncLifecycleRaceReport {
	const findings = [
		...detectDuplicateDeliveryRaces(events, order),
		...detectBoundaryRaces(events, order),
	];
	const duplicated_task_ids: string[] = [];
	for (const f of findings) {
		if (f.effect_duplicated && !duplicated_task_ids.includes(f.task_id)) {
			duplicated_task_ids.push(f.task_id);
		}
	}
	return { findings, duplicated_task_ids };
}

export type TaskSchedule = {
	task_id: string;
	/** A single valid linear extension of the partial order (stable sort by `happensBefore`). */
	order: string[];
	/** Every pair in `order` whose relative position was NOT determined by the partial order (both are `concurrent`). */
	undetermined_pairs: [string, string][];
};

/**
 * Reconstruct one deterministic (but not necessarily unique) linear
 * schedule for a single task's events, honest about every tie it had to
 * break arbitrarily.
 */
export function reconstructTaskSchedule(
	events: LifecycleEvent[],
	order: PartialOrderResult,
): TaskSchedule {
	if (events.length === 0) {
		throw new RangeError("reconstructTaskSchedule requires at least one event");
	}
	const taskId = events[0].task_id;

	// A stable sort by `happensBefore` is a valid linear extension of the
	// partial order whenever the comparator ever returns non-zero for a
	// pair; ties (comparator returns 0, i.e. neither orders the other) keep
	// their original relative position, which is why ties are reported
	// separately rather than hidden inside the sort's own tiebreak.
	const sorted = [...events].sort((a, b) => {
		if (order.happensBefore(a.id, b.id)) return -1;
		if (order.happensBefore(b.id, a.id)) return 1;
		return 0;
	});

	const undetermined_pairs: [string, string][] = [];
	const seenPairs = new Set<string>();
	for (let i = 0; i < events.length; i++) {
		for (let j = i + 1; j < events.length; j++) {
			const a = events[i];
			const b = events[j];
			if (!order.concurrent(a.id, b.id)) continue;
			const pk = pairKey(a.id, b.id);
			if (seenPairs.has(pk)) continue;
			seenPairs.add(pk);
			undetermined_pairs.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
		}
	}

	return { task_id: taskId, order: sorted.map((e) => e.id), undetermined_pairs };
}

/** Render a human-readable summary of an async-lifecycle-race report. */
export function renderAsyncLifecycleRaceReport(report: AsyncLifecycleRaceReport): string {
	const lines: string[] = ["# Asynchronous Lifecycle Race Report", ""];
	if (report.findings.length === 0) {
		lines.push("No races found.");
	}
	for (const f of report.findings) {
		lines.push(
			`- [${f.kind}] task '${f.task_id}': ${f.legs[0]} <-> ${f.legs[1]}${f.effect_duplicated ? " (EFFECT DUPLICATED)" : ""} — ${f.detail}`,
		);
	}
	lines.push("");
	lines.push(`Tasks with a confirmed effect duplication: ${report.duplicated_task_ids.length}`);
	for (const id of report.duplicated_task_ids) lines.push(`- ${id}`);
	return lines.join("\n");
}
