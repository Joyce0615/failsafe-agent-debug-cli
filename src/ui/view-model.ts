/**
 * Interactive view model for the timeline, causal graph, evidence, and
 * hypothesis panes (item 91).
 *
 * The interactive part of an interactive UI is navigation and expansion, and
 * that is a pure state machine. Keeping it separate from any rendering backend
 * means it can be tested exhaustively, driven by an agent as easily as by a
 * keyboard, and reasoned about without a terminal.
 *
 * Three properties matter more than the layout:
 *
 * 1. **Elision is reported.** A pane that truncates two hundred events to forty
 *    lines and shows no indicator is lying about what happened. Every render
 *    returns what it hid and why, and the count is part of the output rather
 *    than a footer somebody may scroll past.
 *
 * 2. **Selection survives data changes, and its loss is announced.** When new
 *    events arrive the selected row must remain selected if it still exists.
 *    Silently moving the cursor to whatever now occupies that index is how
 *    somebody acts on the wrong row, and it happens in every list UI that
 *    tracks position instead of identity.
 *
 * 3. **The graph pane terminates.** Causal graphs contain cycles — item 59
 *    removes them from its output but a user can be looking at a graph that
 *    still has one — and deep chains exceed any sensible indent. Traversal is
 *    depth-bounded and cycle-aware, and marks *where* it stopped rather than
 *    quietly producing a truncated tree that reads as complete.
 *
 * Pure: no I/O, no terminal, no escape codes.
 */

export const PANES = ["timeline", "graph", "evidence", "hypotheses"] as const;
export type Pane = (typeof PANES)[number];

export type TimelineRow = {
	id: string;
	ts_ms: number;
	label: string;
	/** Uncertainty, rendered so a precise-looking timestamp is not trusted blindly. */
	uncertainty_ms?: number;
	source: string;
};

export type GraphNode = {
	id: string;
	label: string;
	children: string[];
	/** Strength of the edge that reached this node, when it has one. */
	edge_strength?: number;
	speculative?: boolean;
};

export type EvidenceRow = {
	id: string;
	summary: string;
	/** Hypotheses citing this evidence. */
	cited_by: string[];
};

export type HypothesisRow = {
	id: string;
	statement: string;
	confidence: number;
	/** Evidence ids this hypothesis cites. */
	cites: string[];
	status: "open" | "confirmed" | "abandoned";
};

export type ViewData = {
	timeline: TimelineRow[];
	graph: { roots: string[]; nodes: Record<string, GraphNode> };
	evidence: EvidenceRow[];
	hypotheses: HypothesisRow[];
};

export type Viewport = { rows: number; columns: number };

export type ViewState = {
	focus: Pane;
	/** Selected row id per pane. `null` when nothing is selected. */
	selection: Record<Pane, string | null>;
	/** Expanded node ids in the graph pane. */
	expanded: Set<string>;
	/** First visible index per pane, for scrolling. */
	scroll: Record<Pane, number>;
	viewport: Viewport;
	/**
	 * Set when a selection was lost because the item disappeared. Cleared on the
	 * next explicit selection, never silently.
	 */
	lost_selection?: { pane: Pane; id: string };
};

export const DEFAULT_VIEWPORT: Viewport = { rows: 24, columns: 100 };

export function initialState(viewport: Viewport = DEFAULT_VIEWPORT): ViewState {
	return {
		focus: "timeline",
		selection: { timeline: null, graph: null, evidence: null, hypotheses: null },
		expanded: new Set(),
		scroll: { timeline: 0, graph: 0, evidence: 0, hypotheses: 0 },
		viewport,
	};
}

/** Ids currently addressable in a pane, in display order. */
export function paneIds(data: ViewData, pane: Pane, state: ViewState): string[] {
	switch (pane) {
		case "timeline":
			return data.timeline.map((row) => row.id);
		case "evidence":
			return data.evidence.map((row) => row.id);
		case "hypotheses":
			return data.hypotheses.map((row) => row.id);
		case "graph":
			return flattenGraph(data, state).map((row) => row.node.id);
	}
}

export type GraphLine = {
	node: GraphNode;
	depth: number;
	/** Why traversal stopped here, when it did. */
	stopped?: "cycle" | "depth_limit" | "collapsed";
};

/** Deepest nesting the graph pane will render before saying it stopped. */
export const MAX_GRAPH_DEPTH = 12;

/**
 * Flatten the graph into display order.
 *
 * Cycle-aware and depth-bounded, and — the part that matters — it *marks* where
 * it stopped. A truncated tree with no marker reads as a complete one, and the
 * reader concludes the chain ends where the renderer gave up.
 */
export function flattenGraph(data: ViewData, state: ViewState): GraphLine[] {
	const lines: GraphLine[] = [];

	const walk = (id: string, depth: number, ancestors: Set<string>): void => {
		const node = data.graph.nodes[id];
		if (!node) return;

		if (ancestors.has(id)) {
			lines.push({ node, depth, stopped: "cycle" });
			return;
		}
		if (depth >= MAX_GRAPH_DEPTH) {
			lines.push({ node, depth, stopped: "depth_limit" });
			return;
		}
		if (node.children.length > 0 && !state.expanded.has(id)) {
			lines.push({ node, depth, stopped: "collapsed" });
			return;
		}

		lines.push({ node, depth });
		const nextAncestors = new Set(ancestors).add(id);
		for (const child of node.children) walk(child, depth + 1, nextAncestors);
	};

	for (const root of data.graph.roots) walk(root, 0, new Set());
	return lines;
}

export type SelectionChange = {
	state: ViewState;
	/** True when the requested id does not exist in that pane. */
	rejected: boolean;
	reason?: string;
};

/**
 * Select a row by identity.
 *
 * Rejects an id that is not present rather than clamping to the nearest one.
 * Clamping is convenient and is how a selection silently lands on a different
 * record than the caller asked for.
 */
export function select(state: ViewState, data: ViewData, pane: Pane, id: string): SelectionChange {
	const ids = paneIds(data, pane, state);
	if (!ids.includes(id)) {
		return {
			state,
			rejected: true,
			reason: `'${id}' is not present in the ${pane} pane; the selection is unchanged rather than moved to a neighbour`,
		};
	}
	const next: ViewState = {
		...state,
		focus: pane,
		selection: { ...state.selection, [pane]: id },
	};
	// An explicit selection resolves any previously announced loss.
	// biome-ignore lint/performance/noDelete: the field's absence is the signal.
	delete next.lost_selection;
	return { state: next, rejected: false };
}

/**
 * Reconcile state against new data.
 *
 * The selected id is kept if it still exists. If it does not, the selection is
 * cleared and `lost_selection` records what vanished — the alternative, moving
 * the cursor to whatever now occupies that index, is how somebody acts on the
 * wrong row.
 */
export function reconcile(state: ViewState, data: ViewData): ViewState {
	let lost: ViewState["lost_selection"];
	const selection = { ...state.selection };

	for (const pane of PANES) {
		const current = selection[pane];
		if (current === null) continue;
		if (!paneIds(data, pane, state).includes(current)) {
			selection[pane] = null;
			lost ??= { pane, id: current };
		}
	}

	const scroll = { ...state.scroll };
	for (const pane of PANES) {
		const size = paneIds(data, pane, state).length;
		scroll[pane] = Math.max(0, Math.min(scroll[pane], Math.max(0, size - 1)));
	}

	return { ...state, selection, scroll, ...(lost ? { lost_selection: lost } : {}) };
}

/** Expand or collapse a graph node. Returns a new state. */
export function toggleExpanded(state: ViewState, id: string): ViewState {
	const expanded = new Set(state.expanded);
	if (expanded.has(id)) expanded.delete(id);
	else expanded.add(id);
	return { ...state, expanded };
}

export type RenderedPane = {
	pane: Pane;
	lines: string[];
	/** Rows the viewport could not show. */
	elided_rows: number;
	/** Characters trimmed from the widest line, when any were. */
	elided_columns: number;
	/** Stated whenever anything was hidden. Empty when nothing was. */
	elision_notes: string[];
	focused: boolean;
};

function truncate(text: string, columns: number): { text: string; trimmed: number } {
	if (text.length <= columns) return { text, trimmed: 0 };
	return { text: `${text.slice(0, Math.max(0, columns - 1))}…`, trimmed: text.length - columns };
}

/**
 * Render one pane.
 *
 * Every truncation — vertical and horizontal — is counted and explained. A
 * label cut at the right margin is the most common way a UI hides the part of
 * an error message that mattered, and reporting the column trim is the only way
 * a reader knows to widen the window.
 */
export function renderPane(
	data: ViewData,
	state: ViewState,
	pane: Pane,
	options: { body_rows?: number } = {},
): RenderedPane {
	const bodyRows = options.body_rows ?? Math.max(1, state.viewport.rows - 4);
	const columns = state.viewport.columns;
	const selected = state.selection[pane];

	const rows: string[] = (() => {
		switch (pane) {
			case "timeline":
				return data.timeline.map(
					(row) =>
						`${row.ts_ms}${row.uncertainty_ms ? ` ±${row.uncertainty_ms}` : ""} [${row.source}] ${row.label}`,
				);
			case "evidence":
				return data.evidence.map(
					(row) =>
						`${row.summary}${row.cited_by.length > 0 ? ` (cited by ${row.cited_by.length})` : " (uncited)"}`,
				);
			case "hypotheses":
				return data.hypotheses.map(
					(row) => `${row.confidence.toFixed(2)} [${row.status}] ${row.statement}`,
				);
			case "graph":
				return flattenGraph(data, state).map((line) => {
					const indent = "  ".repeat(line.depth);
					const marker =
						line.stopped === "cycle"
							? " ⟲ cycle: traversal stopped here, the chain continues"
							: line.stopped === "depth_limit"
								? ` ⋯ depth limit ${MAX_GRAPH_DEPTH} reached, deeper nodes are not shown`
								: line.stopped === "collapsed"
									? ` ▸ ${line.node.children.length} hidden`
									: "";
					const speculative = line.node.speculative ? " (speculative)" : "";
					return `${indent}${line.node.label}${speculative}${marker}`;
				});
		}
	})();

	const ids = paneIds(data, pane, state);
	const start = Math.max(0, Math.min(state.scroll[pane], Math.max(0, rows.length - bodyRows)));
	const visible = rows.slice(start, start + bodyRows);

	let trimmed = 0;
	const lines = visible.map((text, index) => {
		const id = ids[start + index];
		const prefix = id === selected ? "> " : "  ";
		const result = truncate(prefix + text, columns);
		trimmed = Math.max(trimmed, result.trimmed);
		return result.text;
	});

	const elidedRows = rows.length - visible.length;
	const notes: string[] = [];
	if (elidedRows > 0) {
		notes.push(
			`${elidedRows} of ${rows.length} row(s) are outside the viewport; this pane is showing ${visible.length}`,
		);
	}
	if (trimmed > 0) {
		notes.push(
			`the longest line was cut by ${trimmed} character(s) at ${columns} columns; the hidden part is the end of the line, which is where an error message usually says what went wrong`,
		);
	}
	const stopped = pane === "graph" ? flattenGraph(data, state).filter((l) => l.stopped) : [];
	if (stopped.length > 0) {
		notes.push(
			`${stopped.length} branch(es) were not fully traversed (${[...new Set(stopped.map((s) => s.stopped))].join(", ")})`,
		);
	}

	return {
		pane,
		lines,
		elided_rows: elidedRows,
		elided_columns: trimmed,
		elision_notes: notes,
		focused: state.focus === pane,
	};
}

export type CrossLinks = {
	/** Evidence ids the selected hypothesis cites. */
	evidence: string[];
	/** Timeline rows whose source matches a cited evidence id. */
	timeline: string[];
	/** Cited evidence ids that do not exist. */
	dangling: string[];
	/** Evidence present but cited by nothing. */
	uncited_evidence: string[];
};

/**
 * Links from the selected hypothesis to the other panes.
 *
 * `dangling` and `uncited_evidence` are the interesting outputs. A citation to
 * evidence that is not in the set is a broken link the UI must show rather than
 * skip, and evidence nobody cites is either irrelevant or overlooked — both
 * worth surfacing, and neither visible from a highlight alone.
 */
export function crossLinks(data: ViewData, state: ViewState): CrossLinks {
	const selected = state.selection.hypotheses;
	const hypothesis = data.hypotheses.find((h) => h.id === selected);
	const evidenceIds = new Set(data.evidence.map((e) => e.id));
	const cites = hypothesis?.cites ?? [];

	return {
		evidence: cites.filter((id) => evidenceIds.has(id)),
		timeline: data.timeline
			.filter((row) => cites.some((id) => row.source === id || row.id === id))
			.map((row) => row.id),
		dangling: cites.filter((id) => !evidenceIds.has(id)),
		uncited_evidence: data.evidence.filter((e) => e.cited_by.length === 0).map((e) => e.id),
	};
}

export type ScreenRender = {
	panes: RenderedPane[];
	/** Every elision note across the screen, so nothing is hidden in one pane. */
	elisions: string[];
	/** Present when a selection was lost during the last reconcile. */
	selection_warning?: string;
};

/** Render the whole screen. */
export function renderScreen(data: ViewData, state: ViewState): ScreenRender {
	const perPane = Math.max(1, Math.floor((state.viewport.rows - 4) / PANES.length));
	const panes = PANES.map((pane) => renderPane(data, state, pane, { body_rows: perPane }));

	return {
		panes,
		elisions: panes.flatMap((p) => p.elision_notes.map((note) => `${p.pane}: ${note}`)),
		...(state.lost_selection
			? {
					selection_warning: `the ${state.lost_selection.pane} selection '${state.lost_selection.id}' no longer exists and was cleared rather than moved to whatever now occupies that position`,
				}
			: {}),
	};
}
