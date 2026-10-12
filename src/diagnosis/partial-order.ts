/**
 * Reconstruct a partial order across clock-skewed, multi-domain events
 * (item 8).
 *
 * Item 47's `timeline.ts` already estimates clock skew and groups events
 * whose uncertainty intervals overlap into "concurrency groups" -- but a
 * concurrency group is built by walking the SORTED list and chaining
 * overlaps (`concurrencyGroups`), which is a *total pre-order* over groups,
 * not a true partial order: it has no way to use a definite fact (a request
 * really did happen before its response; two log lines really were emitted
 * by the same single-threaded process in that order) to resolve an ambiguity
 * that clock skew alone cannot. And it has no way to even notice when a
 * clock-derived guess CONTRADICTS such a fact.
 *
 * This module adds the two kinds of hard evidence a wall clock cannot
 * provide, and combines them with clock evidence under one hard rule: a
 * causal link is a fact; a clock-derived ordering is a *guess, however
 * well-calibrated*, and a guess that contradicts a fact is wrong, not
 * dominant. Never let an uncertain clock comparison override, or quietly
 * coexist with, a known-true causal fact -- doing so would create a cycle in
 * what is supposed to be an order relation (A before B and B before A), i.e.
 * exactly "inventing an unsupported total order" that this item's goal
 * forbids.
 *
 * Evidence combined, strongest first:
 * 1. **Causal links** (`CausalLink`): explicit happens-before facts --
 *    request/response, parent/child span, same single-threaded monotonic
 *    sequence. Always accepted, unless two causal links directly contradict
 *    each other (a genuine data-integrity error), in which case BOTH are
 *    rejected and reported rather than one arbitrarily winning.
 * 2. **Clock evidence**: from `timeline.ts`'s skew-corrected,
 *    uncertainty-annotated `NormalizedEvent`s. A clock-derived edge is
 *    accepted only when it does not create a cycle with the causal facts (or
 *    with clock edges already accepted); otherwise it is rejected and the
 *    rejection is recorded as an uncertainty, not silently dropped.
 *
 * The result is queried by reachability (`happensBefore`/`concurrent`), not
 * read off a flattened list, so "determined" genuinely means "there is a
 * path of evidence", not "happened to be grouped together".
 *
 * Pure: no fs/network/process; `NormalizedEvent`s and their uncertainty are
 * supplied by the caller (typically `timeline.ts`'s `normalizeTimeline`).
 */
import type { NormalizedEvent } from "./timeline.js";

/** An explicit happens-before fact, independent of any clock. */
export type CausalLink = {
	before: string;
	after: string;
	/** e.g. "request/response", "parent/child span", "same monotonic sequence". */
	reason: string;
};

export type OrderEdge = {
	before: string;
	after: string;
	basis: "causal_link" | "clock";
	reason: string;
};

export type PartialOrderResult = {
	/** Edges actually accepted into the order relation. */
	edges: OrderEdge[];
	/** Clock-derived edges rejected because they would contradict accepted evidence. */
	rejected_clock_edges: OrderEdge[];
	/** Pairs of causal links that directly contradicted each other (both rejected). */
	contradictions: string[];
	/** `true` iff `a` is known to happen before `b` (direct or transitive). */
	happensBefore(a: string, b: string): boolean;
	/** `true` iff neither orders the other -- order is genuinely undetermined. */
	concurrent(a: string, b: string): boolean;
	uncertainty: string[];
};

function canReach(adj: Map<string, Set<string>>, from: string, to: string): boolean {
	if (from === to) return true;
	const seen = new Set<string>([from]);
	const stack = [from];
	while (stack.length > 0) {
		const node = stack.pop() as string;
		for (const next of adj.get(node) ?? []) {
			if (next === to) return true;
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return false;
}

function addEdge(adj: Map<string, Set<string>>, before: string, after: string): void {
	const set = adj.get(before);
	if (set) set.add(after);
	else adj.set(before, new Set([after]));
}

/**
 * Combine causal links and skew-corrected clock evidence into a partial
 * order. Causal links are accepted first (as facts); clock-derived edges are
 * accepted only when they introduce no cycle with what is already accepted,
 * so a clock guess can never override a causal fact.
 */
export function reconstructPartialOrder(
	events: NormalizedEvent[],
	links: CausalLink[] = [],
): PartialOrderResult {
	const ids = new Set(events.map((e) => e.id));
	const adj = new Map<string, Set<string>>();
	const edges: OrderEdge[] = [];
	const contradictions: string[] = [];
	const uncertainty: string[] = [];

	// A direct contradiction -- two links claiming opposite order for the SAME
	// pair -- is a data-integrity error, not a tiebreak: both are rejected
	// rather than letting whichever was listed first win arbitrarily.
	const banned = new Set<number>();
	for (let i = 0; i < links.length; i++) {
		for (let j = i + 1; j < links.length; j++) {
			if (links[i].before === links[j].after && links[i].after === links[j].before) {
				banned.add(i);
				banned.add(j);
				contradictions.push(
					`causal link '${links[i].before}' before '${links[i].after}' (${links[i].reason}) directly contradicts '${links[j].before}' before '${links[j].after}' (${links[j].reason}); both rejected.`,
				);
			}
		}
	}

	for (let i = 0; i < links.length; i++) {
		const link = links[i];
		if (banned.has(i)) continue;
		if (!ids.has(link.before) || !ids.has(link.after)) continue;
		// A link contradicted transitively by already-accepted evidence (after
		// already happens-before before) is also a data-integrity error: reject
		// it rather than let it win arbitrarily.
		if (canReach(adj, link.after, link.before)) {
			contradictions.push(
				`causal link '${link.before}' before '${link.after}' (${link.reason}) contradicts already-accepted evidence that '${link.after}' happens before '${link.before}'; rejected.`,
			);
			continue;
		}
		addEdge(adj, link.before, link.after);
		edges.push({
			before: link.before,
			after: link.after,
			basis: "causal_link",
			reason: link.reason,
		});
	}

	const sorted = [...events].sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));
	const rejected_clock_edges: OrderEdge[] = [];
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			const earlier = sorted[i];
			const later = sorted[j];
			const gap = later.ts_ms - earlier.ts_ms;
			const overlap = gap <= earlier.uncertainty_ms + later.uncertainty_ms;
			if (overlap) continue; // genuinely ambiguous by clock evidence alone
			const candidate: OrderEdge = {
				before: earlier.id,
				after: later.id,
				basis: "clock",
				reason: `clock: ${earlier.ts_ms}±${earlier.uncertainty_ms}ms before ${later.ts_ms}±${later.uncertainty_ms}ms`,
			};
			// Accepting earlier -> later would create a cycle iff `later` already
			// happens-before `earlier` via accepted (causal or clock) evidence --
			// i.e. a causal fact (or an already-accepted clock edge) disagrees
			// with this clock guess. A guess never overrides a fact.
			if (canReach(adj, later.id, earlier.id)) {
				rejected_clock_edges.push(candidate);
				uncertainty.push(
					`clock evidence suggests '${earlier.id}' before '${later.id}', but accepted causal evidence already orders them the other way; clock evidence rejected for this pair.`,
				);
				continue;
			}
			addEdge(adj, earlier.id, later.id);
			edges.push(candidate);
		}
	}

	if (contradictions.length > 0) {
		uncertainty.push(
			`${contradictions.length} causal link(s) directly contradicted other evidence and were rejected; see contradictions.`,
		);
	}

	return {
		edges,
		rejected_clock_edges,
		contradictions,
		happensBefore: (a, b) => ids.has(a) && ids.has(b) && canReach(adj, a, b),
		concurrent: (a, b) =>
			ids.has(a) && ids.has(b) && a !== b && !canReach(adj, a, b) && !canReach(adj, b, a),
		uncertainty,
	};
}
