/**
 * Cross-agent causal incident graphs (item 22).
 *
 * `causal-graph.ts` (item 38) ranks root causes given a graph of typed edges.
 * `timeline.ts` (item 47) and `partial-order.ts` (item 8) already solve
 * "what order did these clock-skewed events actually happen in, without
 * inventing an order the evidence doesn't support". This module is the piece
 * that was missing: turning a flat stream of per-agent events — spanning
 * MULTIPLE traces, because a delegation or a shared resource is exactly the
 * place one trace ends and another begins — into the typed edges item 38
 * already knows how to rank over, while still obeying item 8's rule.
 *
 * Five edge kinds, in two very different epistemic categories:
 *
 * 1. **Explicit relations** (`delegates_to`, `sends_message_to`): the event
 *    itself names its target agent. These are causal FACTS, exactly like
 *    `partial-order.ts`'s `CausalLink` — accepted unconditionally, the same
 *    way a request/response pairing is.
 * 2. **Shared-resource relations** (`shares_memory_with`, `shares_tool_with`,
 *    `shares_environment_with`): two agents each touched the same named
 *    resource (a memory key, a tool, an environment variable). There is no
 *    explicit "A told B" here — only a clock to order them by, and clocks
 *    across agents/traces are exactly the unreliable kind `partial-order.ts`
 *    exists to guard against. So these edges are drawn ONLY when
 *    `reconstructPartialOrder` reports the earlier access `happensBefore` the
 *    later one; when the two are `concurrent` (uncertainty intervals
 *    overlap — the common case for cross-trace events with no shared clock
 *    anchor), NO edge is invented in either direction, and the ambiguity is
 *    recorded as an uncertainty, not silently dropped.
 *
 * Root-cause ranking is then delegated entirely to item 38's
 * `rankRootCauses` — this module does not re-rank. The single change that
 * makes that reuse correct is `first_propagating_fault`: item 38's top root
 * cause IS the first propagating fault definitionally (earliest failed node
 * with no failed cause, read off the SAME graph that carries delegation,
 * message, and shared-resource edges) — so this module just names that
 * result rather than recomputing it.
 *
 * Pure: no fs/network/process. Composes `timeline.ts`, `partial-order.ts`,
 * and `causal-graph.ts` rather than remodeling any of their evidence rules.
 */
import {
	type CausalEdge,
	type CausalNode,
	type RootCause,
	buildCausalGraph,
	rankRootCauses,
} from "./causal-graph.js";
import { type CausalLink, reconstructPartialOrder } from "./partial-order.js";
import { type RawEvent, normalizeTimeline } from "./timeline.js";

/** The five kinds of cross-agent event this module draws edges from. */
export const AGENT_EVENT_KINDS = [
	"delegation",
	"message",
	"memory_access",
	"tool_call",
	"environment_access",
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

const RESOURCE_KIND: Record<
	"memory_access" | "tool_call" | "environment_access",
	"shares_memory_with" | "shares_tool_with" | "shares_environment_with"
> = {
	memory_access: "shares_memory_with",
	tool_call: "shares_tool_with",
	environment_access: "shares_environment_with",
};

/**
 * One observed agent action, possibly spanning a trace boundary.
 *
 * `target_agent_id` carries the explicit relation for `delegation`/`message`
 * events. `resource_key` carries the shared-resource identity for
 * `memory_access`/`tool_call`/`environment_access` events — the SAME key on
 * two events from different agents is what nominates a `shares_*_with` edge.
 */
export type AgentEvent = {
	id: string;
	trace_id: string;
	agent_id: string;
	kind: AgentEventKind;
	ts_ms: number;
	/** Clock domain, like `timeline.ts`'s `RawEvent.clock`. Defaults to `trace_id`: cross-trace events are not assumed to share a clock. */
	clock?: string;
	precision_ms?: number;
	failed?: boolean;
	message?: string;
	/** Explicit target for `delegation`/`message` events. */
	target_agent_id?: string;
	/** Shared-resource identity for `memory_access`/`tool_call`/`environment_access` events. */
	resource_key?: string;
};

export type IncidentGraphResult = {
	nodes: CausalNode[];
	edges: CausalEdge[];
	/** The item-38 ranking, unmodified -- this module adds edges, not a second ranker. */
	root_causes: RootCause[];
	/** `root_causes[0]`, named for what it is in a multi-agent incident. */
	first_propagating_fault: RootCause | undefined;
	uncertainty: string[];
};

function nodeKindFor(kind: AgentEventKind): CausalNode["kind"] {
	if (kind === "delegation" || kind === "message") return "agent";
	if (kind === "tool_call") return "tool";
	return "service"; // memory_access, environment_access: shared infrastructure, not a single agent's own step
}

/**
 * Build the cross-agent incident graph.
 *
 * Explicit relations become `CausalLink`s (facts, per item 8) feeding
 * `reconstructPartialOrder`. Shared-resource accesses are grouped by
 * `resource_key` and ordered pairwise ONLY through `happensBefore`, so a
 * clock-ambiguous pair (the common cross-trace case) gets no edge and an
 * explicit uncertainty note instead of a guessed direction.
 */
export function buildIncidentGraph(events: AgentEvent[]): IncidentGraphResult {
	const uncertainty: string[] = [];

	// --- timeline normalization: one clock-aware model across all agents/traces ---
	// Events with no declared clock are assumed to be on their OWN trace's
	// clock -- two different traces are not assumed to share a clock just
	// because nothing says otherwise.
	const raw: RawEvent[] = events.map((e) => ({
		id: e.id,
		source: "trace",
		clock: e.clock ?? e.trace_id,
		ts_ms: e.ts_ms,
		precision_ms: e.precision_ms,
		label: e.message ?? e.id,
		failed: e.failed === true,
		component: e.agent_id,
	}));
	const timeline = normalizeTimeline(raw);
	uncertainty.push(...timeline.uncertainty);

	// --- explicit relations: facts, exactly like a request/response pairing ---
	const links: CausalLink[] = [];
	for (const e of events) {
		if ((e.kind === "delegation" || e.kind === "message") && e.target_agent_id) {
			// The target agent's OWN next event is what the delegation/message
			// actually causes; a target_agent_id with no event recorded for that
			// agent nominates nothing, rather than inventing a placeholder node.
			const recipientEvents = events
				.filter((other) => other.agent_id === e.target_agent_id && other.ts_ms >= e.ts_ms)
				.sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));
			const recipient = recipientEvents[0];
			if (recipient) {
				links.push({
					before: e.id,
					after: recipient.id,
					reason: `${e.kind === "delegation" ? "delegation" : "message"} from ${e.agent_id} to ${e.target_agent_id}`,
				});
			}
		}
	}

	const order = reconstructPartialOrder(timeline.events, links);
	uncertainty.push(...order.uncertainty);

	const edges: CausalEdge[] = [];
	for (const e of events) {
		if ((e.kind === "delegation" || e.kind === "message") && e.target_agent_id) {
			const recipientEvents = events
				.filter((other) => other.agent_id === e.target_agent_id && other.ts_ms >= e.ts_ms)
				.sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));
			const recipient = recipientEvents[0];
			if (recipient && order.happensBefore(e.id, recipient.id)) {
				edges.push({
					from: e.id,
					to: recipient.id,
					type: e.kind === "delegation" ? "delegates_to" : "sends_message_to",
				});
			}
		}
	}

	// --- shared-resource relations: ordered ONLY by determined partial order ---
	const byResource = new Map<string, AgentEvent[]>();
	for (const e of events) {
		if (e.kind === "memory_access" || e.kind === "tool_call" || e.kind === "environment_access") {
			if (!e.resource_key) continue;
			const list = byResource.get(e.resource_key);
			if (list) list.push(e);
			else byResource.set(e.resource_key, [e]);
		}
	}
	for (const [resourceKey, accesses] of byResource) {
		if (accesses.length < 2) continue;
		// Cross-agent only: two accesses by the SAME agent to the same resource
		// are that agent's own sequencing, not a cross-agent incident edge.
		const distinctAgents = new Set(accesses.map((a) => a.agent_id));
		if (distinctAgents.size < 2) continue;

		let anyDetermined = false;
		for (let i = 0; i < accesses.length; i++) {
			for (let j = i + 1; j < accesses.length; j++) {
				const a = accesses[i];
				const b = accesses[j];
				if (a.agent_id === b.agent_id) continue;
				const edgeType =
					RESOURCE_KIND[a.kind as "memory_access" | "tool_call" | "environment_access"];
				if (order.happensBefore(a.id, b.id)) {
					edges.push({ from: a.id, to: b.id, type: edgeType });
					anyDetermined = true;
				} else if (order.happensBefore(b.id, a.id)) {
					edges.push({ from: b.id, to: a.id, type: edgeType });
					anyDetermined = true;
				}
				// concurrent (or either id unknown): no edge invented either way.
			}
		}
		if (!anyDetermined) {
			uncertainty.push(
				`shared resource '${resourceKey}' was accessed by ${distinctAgents.size} agents, but their relative order could not be determined; no causal edge was drawn.`,
			);
		}
	}

	const nodes: CausalNode[] = events.map((e) => ({
		id: e.id,
		kind: nodeKindFor(e.kind),
		status: e.failed ? "failed" : "ok",
		ts: e.ts_ms,
		message: e.message,
		service: e.agent_id,
	}));

	const graph = buildCausalGraph(nodes, edges);
	const ranking = rankRootCauses(graph);
	uncertainty.push(...ranking.uncertainty);

	return {
		nodes,
		edges,
		root_causes: ranking.root_causes,
		first_propagating_fault: ranking.root_causes[0],
		uncertainty,
	};
}
