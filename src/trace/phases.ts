/**
 * Reconstruction of agent iterations and phases from imperfect heterogeneous
 * telemetry (item 68).
 *
 * An agent run has a shape — think, act, observe, repeat — and understanding a
 * failure usually means knowing which iteration it happened in and what the
 * agent was trying to do at the time. Almost no telemetry records that
 * directly. What arrives is a mixture of LLM spans, tool spans, and log lines
 * from several producers, some of which declare an iteration index and most of
 * which do not.
 *
 * Reconstruction from that is inference, and the failure mode is producing
 * something that *looks* like a clean loop. A confident, wrong segmentation is
 * worse than none: it makes "the bug appeared in iteration 4" a citable fact
 * when iteration 4 never existed. Three rules keep it honest:
 *
 * 1. **Every boundary records the evidence that produced it**, on a ranked
 *    ladder: a declared iteration index is a fact, an LLM call is a strong
 *    convention, a tool-usage pattern is a guess, and a temporal gap is barely
 *    that. `Boundary.basis` is never omitted and never averaged away.
 *
 * 2. **Sparse telemetry produces a refusal, not a reconstruction.** Below a
 *    minimum event density `reconstruct` returns zero iterations with a stated
 *    reason. There is a real temptation to emit one iteration covering
 *    everything and call it a result; that number then travels.
 *
 * 3. **Coverage is reported.** If the reconstructed iterations account for 40%
 *    of the run's wall time, then 60% of it happened somewhere the telemetry
 *    did not see, and every per-phase duration derived from it is wrong by an
 *    unknown amount. The number is computed and surfaced rather than left for
 *    someone to notice.
 *
 * Pure: no I/O.
 */

export const EVENT_KINDS = ["llm", "tool", "log", "decision", "observation"] as const;
export type PhaseEventKind = (typeof EVENT_KINDS)[number];

export type PhaseEvent = {
	id: string;
	kind: PhaseEventKind;
	ts_ms: number;
	duration_ms?: number;
	/** Tool name for `tool` events; free text otherwise. */
	label: string;
	/** Iteration index when the producer actually recorded one. */
	declared_iteration?: number;
	/** Producer, so a missing source can be named. */
	source?: string;
};

/** Evidence that produced an iteration boundary, strongest first. */
export const BOUNDARY_BASES = ["declared", "llm_call", "tool_pattern", "temporal_gap"] as const;
export type BoundaryBasis = (typeof BOUNDARY_BASES)[number];

/** How much each basis is worth as evidence that a boundary is real. */
export const BASIS_CONFIDENCE: Record<BoundaryBasis, number> = {
	declared: 0.95,
	llm_call: 0.7,
	tool_pattern: 0.45,
	temporal_gap: 0.25,
};

export type Boundary = {
	/** Index of the first event of the new iteration. */
	at_event: string;
	basis: BoundaryBasis;
	confidence: number;
	detail: string;
};

/** Phases an iteration can be in, from the tools it used. */
export const PHASES = ["explore", "hypothesize", "edit", "verify", "unknown"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Tool-name fragments that indicate a phase.
 *
 * Fragments rather than exact names because tool naming is not standardized and
 * never will be; `read_file`, `readFile`, and `fs.read` all mean the same
 * thing. Ambiguous mixes resolve to `unknown` rather than to whichever entry
 * happened to be checked first.
 */
const PHASE_SIGNALS: Record<Exclude<Phase, "unknown">, string[]> = {
	explore: ["read", "search", "grep", "list", "find", "glob", "cat", "view"],
	hypothesize: ["think", "plan", "reason", "analyze", "analyse", "hypoth"],
	edit: ["write", "edit", "patch", "apply", "replace", "create", "delete"],
	verify: ["test", "run", "build", "lint", "typecheck", "verify", "check", "compile"],
};

export type Iteration = {
	index: number;
	events: PhaseEvent[];
	start_ms: number;
	end_ms: number;
	phase: Phase;
	/** Confidence in the phase label, distinct from confidence in the boundary. */
	phase_confidence: number;
	/** Evidence for the boundary that opened this iteration. */
	opened_by: Boundary | null;
	/** Phases the tool mix is also consistent with. */
	alternative_phases: Phase[];
};

/**
 * Classify an iteration's phase from its events.
 *
 * Returns the leading phase, a confidence equal to its share of the matched
 * signals, and every other phase that also matched. A mix with no clear leader
 * is `unknown`: an iteration that read three files and ran two tests is
 * genuinely both, and picking one would make a phase-duration chart fiction.
 */
export function classifyPhase(events: PhaseEvent[]): {
	phase: Phase;
	confidence: number;
	alternatives: Phase[];
} {
	const scores: Record<string, number> = {};
	for (const event of events) {
		const text = `${event.label} ${event.kind}`.toLowerCase();
		for (const [phase, signals] of Object.entries(PHASE_SIGNALS)) {
			if (signals.some((s) => text.includes(s))) scores[phase] = (scores[phase] ?? 0) + 1;
		}
	}

	const entries = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	if (entries.length === 0) return { phase: "unknown", confidence: 0, alternatives: [] };

	const total = entries.reduce((sum, [, n]) => sum + n, 0);
	const [leader, leaderScore] = entries[0];
	const share = leaderScore / total;
	const alternatives = entries.slice(1).map(([p]) => p as Phase);

	// A leader that does not clear half the signals is not a leader.
	if (share <= 0.5 && entries.length > 1) {
		return { phase: "unknown", confidence: share, alternatives: entries.map(([p]) => p as Phase) };
	}
	return { phase: leader as Phase, confidence: share, alternatives };
}

export type ReconstructionOptions = {
	/** Gap after which a new iteration is assumed, absent better evidence. */
	gap_ms?: number;
	/** Events below this make reconstruction unsupportable. */
	min_events?: number;
	/** Events per second below this make reconstruction unsupportable. */
	min_density_per_minute?: number;
};

export const DEFAULT_GAP_MS = 30_000;
export const DEFAULT_MIN_EVENTS = 4;
export const DEFAULT_MIN_DENSITY = 1;

export type Reconstruction = {
	iterations: Iteration[];
	/** Set when reconstruction was refused. */
	refused_reason?: string;
	/** Fraction of the run's wall time covered by reconstructed iterations. */
	coverage: number;
	/** Gaps longer than `gap_ms` that no iteration accounts for. */
	unaccounted_gaps: Array<{ from_ms: number; to_ms: number; duration_ms: number }>;
	/** Distinct producers seen, so a missing one can be noticed. */
	sources: string[];
	/** Overall confidence: the weakest boundary in the chain. */
	weakest_boundary: Boundary | null;
	caveats: string[];
};

/**
 * Reconstruct iterations and phases.
 *
 * Boundary detection runs the ladder in order and takes the strongest basis
 * available for each candidate: if any event declares an iteration index, the
 * declared indices win outright and no inference happens at all. Mixing a
 * declared boundary with an inferred one would produce a segmentation that is
 * neither what the producer said nor what the heuristic found.
 */
export function reconstruct(
	events: PhaseEvent[],
	options: ReconstructionOptions = {},
): Reconstruction {
	const gap = options.gap_ms ?? DEFAULT_GAP_MS;
	const minEvents = options.min_events ?? DEFAULT_MIN_EVENTS;
	const minDensity = options.min_density_per_minute ?? DEFAULT_MIN_DENSITY;

	const ordered = [...events].sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));
	const sources = [...new Set(ordered.map((e) => e.source).filter((s): s is string => !!s))].sort();

	const empty = (reason: string): Reconstruction => ({
		iterations: [],
		refused_reason: reason,
		coverage: 0,
		unaccounted_gaps: [],
		sources,
		weakest_boundary: null,
		caveats: [reason],
	});

	if (ordered.length === 0) return empty("no events supplied");
	if (ordered.length < minEvents) {
		return empty(
			`only ${ordered.length} event(s); at least ${minEvents} are needed before a loop structure can be claimed`,
		);
	}

	const spanMs = endOf(ordered[ordered.length - 1]) - ordered[0].ts_ms;
	const minutes = Math.max(spanMs / 60_000, 1 / 60);
	const density = ordered.length / minutes;
	if (density < minDensity) {
		return empty(
			`event density is ${density.toFixed(2)}/minute over ${Math.round(spanMs / 1000)}s, below the ${minDensity}/minute needed to distinguish iterations from silence`,
		);
	}

	const declared = ordered.some((e) => e.declared_iteration !== undefined);
	const groups: PhaseEvent[][] = [];
	const boundaries: Array<Boundary | null> = [];

	if (declared) {
		// The producer told us. Anything the producer did not label goes with the
		// most recent labelled iteration rather than starting a phantom one.
		let current: number | undefined;
		for (const event of ordered) {
			const index = event.declared_iteration;
			if (index !== undefined && index !== current) {
				current = index;
				groups.push([event]);
				boundaries.push({
					at_event: event.id,
					basis: "declared",
					confidence: BASIS_CONFIDENCE.declared,
					detail: `producer declared iteration ${index}`,
				});
			} else if (groups.length === 0) {
				groups.push([event]);
				boundaries.push(null);
			} else {
				groups[groups.length - 1].push(event);
			}
		}
	} else {
		let previous: PhaseEvent | undefined;
		let seenToolInGroup = false;
		for (const event of ordered) {
			const basis = previous ? inferBasis(previous, event, gap, seenToolInGroup) : null;
			if (!previous || basis) {
				groups.push([event]);
				boundaries.push(
					basis
						? {
								at_event: event.id,
								basis,
								confidence: BASIS_CONFIDENCE[basis],
								detail: basisDetail(basis, previous!, event, gap),
							}
						: null,
				);
				seenToolInGroup = event.kind === "tool";
			} else {
				groups[groups.length - 1].push(event);
				if (event.kind === "tool") seenToolInGroup = true;
			}
			previous = event;
		}
	}

	const iterations: Iteration[] = groups.map((group, i) => {
		const { phase, confidence, alternatives } = classifyPhase(group);
		return {
			index: i,
			events: group,
			start_ms: group[0].ts_ms,
			end_ms: Math.max(...group.map(endOf)),
			phase,
			phase_confidence: confidence,
			opened_by: boundaries[i],
			alternative_phases: alternatives,
		};
	});

	const covered = iterations.reduce((sum, it) => sum + (it.end_ms - it.start_ms), 0);
	const coverage = spanMs > 0 ? Math.min(1, covered / spanMs) : 1;

	const unaccounted: Reconstruction["unaccounted_gaps"] = [];
	for (let i = 1; i < iterations.length; i++) {
		const from = iterations[i - 1].end_ms;
		const to = iterations[i].start_ms;
		if (to - from > gap) unaccounted.push({ from_ms: from, to_ms: to, duration_ms: to - from });
	}

	const realBoundaries = boundaries.filter((b): b is Boundary => b !== null);
	const weakest = realBoundaries.reduce<Boundary | null>(
		(min, b) => (min === null || b.confidence < min.confidence ? b : min),
		null,
	);

	const caveats: string[] = [];
	if (coverage < 0.8) {
		caveats.push(
			`reconstructed iterations account for only ${Math.round(coverage * 100)}% of the run's wall time; per-phase durations derived from this are wrong by an unknown amount`,
		);
	}
	if (!declared) {
		caveats.push(
			"no producer declared an iteration index; every boundary here is inferred and the segmentation may not match what the agent actually did",
		);
	}
	if (unaccounted.length > 0) {
		caveats.push(
			`${unaccounted.length} gap(s) longer than ${gap}ms fall between iterations and are unexplained`,
		);
	}
	const unknownPhases = iterations.filter((it) => it.phase === "unknown").length;
	if (unknownPhases > 0) {
		caveats.push(
			`${unknownPhases} of ${iterations.length} iteration(s) have no clear phase; their tool mix is genuinely ambiguous`,
		);
	}

	return {
		iterations,
		coverage,
		unaccounted_gaps: unaccounted,
		sources,
		weakest_boundary: weakest,
		caveats,
	};
}

function endOf(event: PhaseEvent): number {
	return event.ts_ms + (event.duration_ms ?? 0);
}

/**
 * Strongest inferred basis for a boundary between two adjacent events.
 *
 * An LLM call after at least one tool call is the classic loop restart: the
 * agent has observed a result and is deciding what to do next. An LLM call with
 * no intervening tool call is a continuation, not a new iteration.
 */
function inferBasis(
	previous: PhaseEvent,
	event: PhaseEvent,
	gap: number,
	seenToolInGroup: boolean,
): BoundaryBasis | null {
	if (event.kind === "llm" && seenToolInGroup) return "llm_call";
	if (event.kind === "tool" && previous.kind === "observation") return "tool_pattern";
	if (event.ts_ms - endOf(previous) > gap) return "temporal_gap";
	return null;
}

function basisDetail(
	basis: BoundaryBasis,
	previous: PhaseEvent,
	event: PhaseEvent,
	gap: number,
): string {
	switch (basis) {
		case "llm_call":
			return "an LLM call following at least one tool call: the agent observed a result and is deciding again";
		case "tool_pattern":
			return `a tool call ('${event.label}') directly after an observation`;
		case "temporal_gap":
			return `${event.ts_ms - endOf(previous)}ms of silence, longer than the ${gap}ms threshold`;
		case "declared":
			return "producer declared an iteration index";
	}
}

export type PhaseSummary = {
	phase: Phase;
	iterations: number;
	total_ms: number;
	/** Mean confidence in the phase label across those iterations. */
	mean_confidence: number;
};

/**
 * Time spent per phase.
 *
 * Returned with the reconstruction's coverage in mind: these totals are only
 * meaningful when coverage is high, which is why `reconstruct` computes and
 * surfaces it rather than leaving the caller to divide by a number nobody
 * checked.
 */
export function summarizePhases(iterations: Iteration[]): PhaseSummary[] {
	const groups = new Map<Phase, Iteration[]>();
	for (const iteration of iterations) {
		const list = groups.get(iteration.phase);
		if (list) list.push(iteration);
		else groups.set(iteration.phase, [iteration]);
	}

	return [...groups.entries()]
		.map(([phase, group]) => ({
			phase,
			iterations: group.length,
			total_ms: group.reduce((sum, it) => sum + (it.end_ms - it.start_ms), 0),
			mean_confidence:
				group.reduce((sum, it) => sum + it.phase_confidence, 0) / Math.max(1, group.length),
		}))
		.sort((a, b) => b.total_ms - a.total_ms || a.phase.localeCompare(b.phase));
}

/** Which iteration contains a moment in time, or `null` if none does. */
export function iterationAt(iterations: Iteration[], tsMs: number): Iteration | null {
	return iterations.find((it) => tsMs >= it.start_ms && tsMs <= it.end_ms) ?? null;
}
