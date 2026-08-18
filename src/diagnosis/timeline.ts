/**
 * Clock-aware cross-artifact causal timeline (item 47).
 *
 * Causal ranking already exists for spans (`causal-graph.ts`), but a real
 * failure leaves evidence in six places — command output, test results, traces,
 * configuration changes, git diffs, and debugger observations — each stamped by
 * a different clock, at a different precision, sometimes twice, sometimes with
 * the interesting part redacted. Sorting those timestamps naively produces a
 * confident and wrong story.
 *
 * This module normalizes first and ranks second:
 *
 * - **Skew.** Each event declares the clock domain that stamped it. Skew is
 *   estimated from anchor pairs (the same real event seen by two clocks) using
 *   a median offset, which does not move when one anchor is wildly wrong.
 * - **Precision.** An event stamped to the second and an event stamped to the
 *   millisecond are not comparable to the millisecond. Every normalized event
 *   carries an uncertainty interval that is the sum of its own precision and
 *   the residual error in its clock's skew estimate.
 * - **Duplicates.** The same event routinely appears in two artifacts (a test
 *   failure in both output and the test report). Duplicates are collapsed with
 *   a count and a record of every source that saw them, rather than being left
 *   to inflate a blast radius.
 * - **Uncertain ordering.** Events whose uncertainty intervals overlap are
 *   placed in the same *concurrency group*: the timeline reports that their
 *   order is undetermined instead of inventing one.
 * - **Redaction.** Labels and attributes are redacted at ingest, before any
 *   fingerprinting or storage, so a secret cannot enter the timeline at all.
 *
 * Ranking then reuses the existing causal graph, with edges drawn only where
 * the ordering is actually determined.
 */
import { redactSecrets } from "../security/redaction.js";
import {
	type CausalEdge,
	type CausalNode,
	type CausalRanking,
	buildCausalGraph,
	rankRootCauses,
} from "./causal-graph.js";

/** The artifacts a timeline can draw from. */
export const EVENT_SOURCES = ["output", "test", "trace", "config", "diff", "debugger"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export type RawEvent = {
	id: string;
	source: EventSource;
	/** Clock domain that produced `ts_ms`, e.g. `local`, `ci-runner`, `collector`. */
	clock: string;
	ts_ms: number;
	/**
	 * Resolution of `ts_ms` in milliseconds. A log line stamped to the second
	 * has `precision_ms: 1000`. Defaults to 1 (millisecond-accurate).
	 */
	precision_ms?: number;
	label: string;
	/** Whether this event represents a failure, for causal ranking. */
	failed?: boolean;
	/** Component/service the event belongs to. */
	component?: string;
	attributes?: Record<string, string>;
};

export type NormalizedEvent = {
	id: string;
	source: EventSource;
	clock: string;
	/** Original stamp, kept so a normalization can be audited. */
	raw_ts_ms: number;
	/** Stamp translated into the reference clock. */
	ts_ms: number;
	/** Half-width of the interval `ts_ms` is known to within. */
	uncertainty_ms: number;
	label: string;
	failed: boolean;
	component?: string;
	attributes: Record<string, string>;
	/** True when redaction removed something from the label or attributes. */
	redacted: boolean;
	/** Number of raw events collapsed into this one. */
	occurrences: number;
	/** Every source that reported this event. */
	sources: EventSource[];
};

/** Two clocks observing the same real event. */
export type ClockAnchor = {
	clock: string;
	/** The event's stamp on `clock`. */
	ts_ms: number;
	/** The same event's stamp on the reference clock. */
	reference_ts_ms: number;
};

export type ClockModel = {
	reference: string;
	/** Per-clock offset to add to a stamp to reach the reference clock. */
	offsets: Record<string, number>;
	/**
	 * Residual spread of the anchors behind each offset, used as the clock's
	 * contribution to an event's uncertainty. A clock with one anchor gets the
	 * default penalty rather than a falsely precise zero.
	 */
	residuals: Record<string, number>;
	/** Clocks observed in the data with no anchor at all. */
	unanchored: string[];
};

/**
 * Uncertainty charged to a clock that has no anchor, or only one.
 *
 * A single anchor pins the offset but says nothing about its stability, so it
 * is not treated as exact. One second is the scale at which log timestamps and
 * container clocks realistically disagree.
 */
export const UNANCHORED_UNCERTAINTY_MS = 1000;

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Estimate per-clock offsets from anchor pairs.
 *
 * The median rather than the mean: one badly mismatched anchor — the wrong log
 * line paired with the right span — would drag a mean offset by seconds and
 * silently reorder the whole timeline.
 */
export function estimateSkew(
	anchors: ClockAnchor[],
	reference: string,
	observedClocks: string[] = [],
): ClockModel {
	const byClock = new Map<string, number[]>();
	for (const anchor of anchors) {
		const delta = anchor.reference_ts_ms - anchor.ts_ms;
		const existing = byClock.get(anchor.clock);
		if (existing) existing.push(delta);
		else byClock.set(anchor.clock, [delta]);
	}

	const offsets: Record<string, number> = { [reference]: 0 };
	const residuals: Record<string, number> = { [reference]: 0 };
	for (const [clock, deltas] of byClock) {
		if (clock === reference) continue;
		const offset = median(deltas);
		offsets[clock] = offset;
		residuals[clock] =
			deltas.length > 1
				? median(deltas.map((d) => Math.abs(d - offset)))
				: UNANCHORED_UNCERTAINTY_MS;
	}

	const unanchored = [...new Set(observedClocks)]
		.filter((c) => c !== reference && offsets[c] === undefined)
		.sort();
	for (const clock of unanchored) {
		// No anchor: assume no offset, but say loudly that it is a guess.
		offsets[clock] = 0;
		residuals[clock] = UNANCHORED_UNCERTAINTY_MS;
	}

	return { reference, offsets, residuals, unanchored };
}

function redactMap(attributes: Record<string, string>): {
	out: Record<string, string>;
	redacted: boolean;
} {
	const out: Record<string, string> = {};
	let redacted = false;
	for (const [key, value] of Object.entries(attributes)) {
		const result = redactSecrets(value);
		if (result.matched.length > 0) redacted = true;
		out[key] = result.redacted;
	}
	return { out, redacted };
}

/**
 * Fingerprint used to recognize the same real event reported by two artifacts.
 *
 * Deliberately excludes the source and the exact timestamp: the whole point is
 * to match a test failure seen in stdout against the same failure in the test
 * report, which agree on nothing else.
 */
function fingerprint(event: NormalizedEvent, bucketMs: number): string {
	const bucket = bucketMs > 0 ? Math.round(event.ts_ms / bucketMs) : event.ts_ms;
	return `${event.component ?? ""}::${event.label}::${bucket}`;
}

export type NormalizeOptions = {
	/** Clock all events are translated into. Defaults to the first clock seen. */
	reference?: string;
	anchors?: ClockAnchor[];
	/** Window within which identical labels are treated as one event. */
	dedupe_window_ms?: number;
};

export const DEFAULT_DEDUPE_WINDOW_MS = 250;

export type NormalizedTimeline = {
	events: NormalizedEvent[];
	clocks: ClockModel;
	/** How many raw events were collapsed as duplicates. */
	duplicates_collapsed: number;
	/** Events whose label or attributes had a secret removed. */
	redacted_events: number;
	/** Sets of event ids whose relative order could not be determined. */
	concurrency_groups: string[][];
	/** Human-readable caveats about the timeline's reliability. */
	uncertainty: string[];
};

/**
 * Normalize raw cross-artifact events into one comparable, deduplicated,
 * uncertainty-annotated timeline.
 */
export function normalizeTimeline(
	raw: RawEvent[],
	opts: NormalizeOptions = {},
): NormalizedTimeline {
	const clocksSeen = raw.map((e) => e.clock);
	const reference = opts.reference ?? clocksSeen[0] ?? "local";
	const clocks = estimateSkew(opts.anchors ?? [], reference, clocksSeen);

	const normalized: NormalizedEvent[] = raw.map((event) => {
		const offset = clocks.offsets[event.clock] ?? 0;
		const residual = clocks.residuals[event.clock] ?? UNANCHORED_UNCERTAINTY_MS;
		const precision = Math.max(1, event.precision_ms ?? 1);
		const labelResult = redactSecrets(event.label);
		const attrResult = redactMap(event.attributes ?? {});
		return {
			id: event.id,
			source: event.source,
			clock: event.clock,
			raw_ts_ms: event.ts_ms,
			ts_ms: event.ts_ms + offset,
			// Precision is a full-width resolution; half of it bounds the error
			// either side, and the clock's residual adds to that.
			uncertainty_ms: precision / 2 + residual,
			label: labelResult.redacted,
			failed: event.failed === true,
			...(event.component ? { component: event.component } : {}),
			attributes: attrResult.out,
			redacted: labelResult.matched.length > 0 || attrResult.redacted,
			occurrences: 1,
			sources: [event.source],
		};
	});

	normalized.sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));

	const window = opts.dedupe_window_ms ?? DEFAULT_DEDUPE_WINDOW_MS;
	const merged: NormalizedEvent[] = [];
	const byFingerprint = new Map<string, NormalizedEvent>();
	let duplicates = 0;
	for (const event of normalized) {
		const key = fingerprint(event, window);
		const existing = byFingerprint.get(key);
		if (existing && Math.abs(existing.ts_ms - event.ts_ms) <= window) {
			existing.occurrences++;
			if (!existing.sources.includes(event.source)) existing.sources.push(event.source);
			// A duplicate seen by a second clock widens, never narrows, what we
			// know: keep the earliest stamp but the larger uncertainty.
			existing.ts_ms = Math.min(existing.ts_ms, event.ts_ms);
			existing.uncertainty_ms = Math.max(existing.uncertainty_ms, event.uncertainty_ms);
			existing.failed = existing.failed || event.failed;
			duplicates++;
			continue;
		}
		byFingerprint.set(key, event);
		merged.push(event);
	}
	merged.sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));

	const groups = concurrencyGroups(merged);
	const uncertainty: string[] = [];
	if (clocks.unanchored.length > 0) {
		uncertainty.push(
			`No clock anchor for ${clocks.unanchored.join(", ")}; those stamps are assumed unskewed with ±${UNANCHORED_UNCERTAINTY_MS}ms uncertainty.`,
		);
	}
	if (duplicates > 0) {
		uncertainty.push(
			`${duplicates} duplicate event(s) collapsed; blast-radius counts reflect distinct events, not report counts.`,
		);
	}
	const ambiguous = groups.filter((g) => g.length > 1);
	if (ambiguous.length > 0) {
		uncertainty.push(
			`${ambiguous.length} group(s) of events have overlapping uncertainty intervals; their relative order is undetermined.`,
		);
	}
	const redactedCount = merged.filter((e) => e.redacted).length;
	if (redactedCount > 0) {
		uncertainty.push(
			`${redactedCount} event(s) had content redacted; matching on those labels is coarser than it appears.`,
		);
	}

	return {
		events: merged,
		clocks,
		duplicates_collapsed: duplicates,
		redacted_events: redactedCount,
		concurrency_groups: groups,
		uncertainty,
	};
}

/**
 * Partition a time-sorted timeline into groups whose order is undetermined.
 *
 * Two events are non-orderable when their uncertainty intervals overlap.
 * Overlap is transitive here by construction (the groups are built by walking
 * the sorted list), which is the conservative reading: if A cannot be ordered
 * against B and B cannot be ordered against C, claiming A before C would be
 * asserting more than the clocks support.
 */
export function concurrencyGroups(events: NormalizedEvent[]): string[][] {
	const groups: string[][] = [];
	let current: NormalizedEvent[] = [];
	for (const event of events) {
		if (current.length === 0) {
			current = [event];
			continue;
		}
		const overlapsAny = current.some(
			(other) => Math.abs(other.ts_ms - event.ts_ms) <= other.uncertainty_ms + event.uncertainty_ms,
		);
		if (overlapsAny) current.push(event);
		else {
			groups.push(current.map((e) => e.id));
			current = [event];
		}
	}
	if (current.length > 0) groups.push(current.map((e) => e.id));
	return groups;
}

/** Which artifact kinds can plausibly cause which. Used to draw causal edges. */
const SOURCE_KIND: Record<EventSource, CausalNode["kind"]> = {
	config: "service",
	diff: "service",
	trace: "service",
	output: "tool",
	test: "tool",
	debugger: "agent",
};

export type TimelineCausalResult = {
	timeline: NormalizedTimeline;
	ranking: CausalRanking;
	/** Edges the timeline was confident enough to draw. */
	edges: CausalEdge[];
};

/**
 * Rank causes over a normalized timeline.
 *
 * An edge is drawn from an earlier failure to a later one **only when their
 * order is determined** — that is, when they are in different concurrency
 * groups. Two failures whose stamps cannot be separated get no edge in either
 * direction, so the ranking degrades to "these are independent" rather than
 * inventing a causal direction out of clock noise.
 */
export function rankTimelineCauses(
	raw: RawEvent[],
	opts: NormalizeOptions = {},
): TimelineCausalResult {
	const timeline = normalizeTimeline(raw, opts);
	const failures = timeline.events.filter((e) => e.failed);

	const groupIndex = new Map<string, number>();
	timeline.concurrency_groups.forEach((group, i) => {
		for (const id of group) groupIndex.set(id, i);
	});

	const nodes: CausalNode[] = failures.map((e) => ({
		id: e.id,
		kind: SOURCE_KIND[e.source],
		status: "failed",
		ts: e.ts_ms,
		message: e.label,
		...(e.component ? { service: e.component } : {}),
	}));

	const edges: CausalEdge[] = [];
	for (let i = 0; i < failures.length; i++) {
		for (let j = i + 1; j < failures.length; j++) {
			const from = failures[i];
			const to = failures[j];
			const fromGroup = groupIndex.get(from.id);
			const toGroup = groupIndex.get(to.id);
			// Same concurrency group => order undetermined => no edge.
			if (fromGroup === undefined || toGroup === undefined || fromGroup === toGroup) continue;
			// Only link the immediately preceding group, so a long timeline does
			// not turn into a dense graph where everything causes everything.
			if (toGroup !== fromGroup + 1) continue;
			edges.push({ from: from.id, to: to.id, type: "causes" });
		}
	}

	const ranking = rankRootCauses(buildCausalGraph(nodes, edges));
	return {
		timeline,
		ranking: {
			root_causes: ranking.root_causes,
			uncertainty: [...ranking.uncertainty, ...timeline.uncertainty],
		},
		edges,
	};
}
