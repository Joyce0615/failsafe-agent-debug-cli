import { describe, expect, test } from "bun:test";
import {
	MAX_GRAPH_DEPTH,
	PANES,
	type ViewData,
	crossLinks,
	flattenGraph,
	initialState,
	paneIds,
	reconcile,
	renderPane,
	renderScreen,
	select,
	toggleExpanded,
} from "../../src/ui/view-model.js";

function data(overrides: Partial<ViewData> = {}): ViewData {
	return {
		timeline: [
			{ id: "t1", ts_ms: 1000, label: "run started", source: "output", uncertainty_ms: 5 },
			{ id: "t2", ts_ms: 2000, label: "KeyError: 'email'", source: "e1" },
		],
		graph: {
			roots: ["n1"],
			nodes: {
				n1: { id: "n1", label: "api", children: ["n2"] },
				n2: { id: "n2", label: "db", children: [] },
			},
		},
		evidence: [
			{ id: "e1", summary: "traceback", cited_by: ["h1"] },
			{ id: "e2", summary: "config dump", cited_by: [] },
		],
		hypotheses: [
			{ id: "h1", statement: "payload lacks email", confidence: 0.8, cites: ["e1"], status: "open" },
		],
		...overrides,
	};
}

describe("elision is reported", () => {
	test("rows outside the viewport are counted and explained", () => {
		const many = data({
			timeline: Array.from({ length: 200 }, (_, i) => ({
				id: `t${i}`,
				ts_ms: i,
				label: `event ${i}`,
				source: "output",
			})),
		});
		const rendered = renderPane(many, initialState(), "timeline", { body_rows: 10 });
		expect(rendered.lines).toHaveLength(10);
		expect(rendered.elided_rows).toBe(190);
		expect(rendered.elision_notes[0]).toContain("190 of 200");
	});

	test("horizontal truncation is reported, because the end of the line is the message", () => {
		const wide = data({
			timeline: [
				{
					id: "t1",
					ts_ms: 0,
					label: "x".repeat(300),
					source: "output",
				},
			],
		});
		const state = { ...initialState(), viewport: { rows: 24, columns: 40 } };
		const rendered = renderPane(wide, state, "timeline");
		expect(rendered.elided_columns).toBeGreaterThan(0);
		expect(rendered.elision_notes.some((n) => n.includes("where an error message usually says"))).toBe(
			true,
		);
	});

	test("nothing hidden means no notes at all", () => {
		const rendered = renderPane(data(), initialState(), "timeline");
		expect(rendered.elided_rows).toBe(0);
		expect(rendered.elision_notes).toEqual([]);
	});

	test("the screen collects elisions from every pane", () => {
		const many = data({
			timeline: Array.from({ length: 100 }, (_, i) => ({
				id: `t${i}`,
				ts_ms: i,
				label: `e${i}`,
				source: "output",
			})),
			evidence: Array.from({ length: 100 }, (_, i) => ({
				id: `e${i}`,
				summary: `s${i}`,
				cited_by: [],
			})),
		});
		const screen = renderScreen(many, initialState());
		expect(screen.elisions.some((e) => e.startsWith("timeline:"))).toBe(true);
		expect(screen.elisions.some((e) => e.startsWith("evidence:"))).toBe(true);
	});

	test("the timeline shows uncertainty so a precise timestamp is not trusted blindly", () => {
		const rendered = renderPane(data(), initialState(), "timeline");
		expect(rendered.lines[0]).toContain("±5");
	});
});

describe("selection is by identity", () => {
	test("selecting an existing row focuses its pane", () => {
		const result = select(initialState(), data(), "timeline", "t2");
		expect(result.rejected).toBe(false);
		expect(result.state.selection.timeline).toBe("t2");
		expect(result.state.focus).toBe("timeline");
	});

	test("selecting a missing row is rejected rather than clamped to a neighbour", () => {
		const result = select(initialState(), data(), "timeline", "nope");
		expect(result.rejected).toBe(true);
		expect(result.reason).toContain("rather than moved to a neighbour");
		expect(result.state.selection.timeline).toBeNull();
	});

	test("a selection that survives new data stays put", () => {
		const state = select(initialState(), data(), "timeline", "t2").state;
		const grown = data({
			timeline: [
				{ id: "t0", ts_ms: 0, label: "new earlier event", source: "output" },
				...data().timeline,
			],
		});
		const next = reconcile(state, grown);
		expect(next.selection.timeline).toBe("t2");
		expect(next.lost_selection).toBeUndefined();
	});

	test("a vanished selection is cleared and announced, not moved", () => {
		const state = select(initialState(), data(), "timeline", "t2").state;
		const shrunk = data({ timeline: [data().timeline[0]] });
		const next = reconcile(state, shrunk);
		expect(next.selection.timeline).toBeNull();
		expect(next.lost_selection).toEqual({ pane: "timeline", id: "t2" });
		expect(renderScreen(shrunk, next).selection_warning).toContain("cleared rather than moved");
	});

	test("an explicit selection resolves the loss warning", () => {
		const state = select(initialState(), data(), "timeline", "t2").state;
		const shrunk = data({ timeline: [data().timeline[0]] });
		const afterLoss = reconcile(state, shrunk);
		const afterSelect = select(afterLoss, shrunk, "timeline", "t1").state;
		expect(afterSelect.lost_selection).toBeUndefined();
	});

	test("scroll is clamped when a pane shrinks", () => {
		const state = { ...initialState(), scroll: { ...initialState().scroll, timeline: 50 } };
		const next = reconcile(state, data());
		expect(next.scroll.timeline).toBeLessThanOrEqual(1);
	});

	test("every pane exposes its ids in display order", () => {
		for (const pane of PANES) {
			expect(paneIds(data(), pane, initialState()).length).toBeGreaterThan(0);
		}
	});
});

describe("the graph pane terminates and says where", () => {
	test("a cycle stops traversal and is marked", () => {
		const cyclic = data({
			graph: {
				roots: ["a"],
				nodes: {
					a: { id: "a", label: "a", children: ["b"] },
					b: { id: "b", label: "b", children: ["a"] },
				},
			},
		});
		const state = toggleExpanded(toggleExpanded(initialState(), "a"), "b");
		const lines = flattenGraph(cyclic, state);
		expect(lines.some((l) => l.stopped === "cycle")).toBe(true);
		expect(renderPane(cyclic, state, "graph").lines.join("\n")).toContain("the chain continues");
	});

	test("a deep chain stops at the depth limit and says so", () => {
		const nodes: ViewData["graph"]["nodes"] = {};
		for (let i = 0; i < MAX_GRAPH_DEPTH + 5; i++) {
			nodes[`n${i}`] = {
				id: `n${i}`,
				label: `n${i}`,
				children: i < MAX_GRAPH_DEPTH + 4 ? [`n${i + 1}`] : [],
			};
		}
		const deep = data({ graph: { roots: ["n0"], nodes } });
		let state = initialState();
		for (const id of Object.keys(nodes)) state = toggleExpanded(state, id);
		const lines = flattenGraph(deep, state);
		expect(lines.some((l) => l.stopped === "depth_limit")).toBe(true);
		expect(lines.length).toBeLessThanOrEqual(MAX_GRAPH_DEPTH + 1);
	});

	test("a collapsed node reports how many children are hidden", () => {
		const rendered = renderPane(data(), initialState(), "graph");
		expect(rendered.lines[0]).toContain("1 hidden");
	});

	test("expanding reveals the children", () => {
		const state = toggleExpanded(initialState(), "n1");
		const rendered = renderPane(data(), state, "graph");
		expect(rendered.lines.join("\n")).toContain("db");
	});

	test("toggling twice returns to the collapsed state", () => {
		const state = toggleExpanded(toggleExpanded(initialState(), "n1"), "n1");
		expect(state.expanded.has("n1")).toBe(false);
	});

	test("incomplete traversal is noted on the pane", () => {
		const rendered = renderPane(data(), initialState(), "graph");
		expect(rendered.elision_notes.some((n) => n.includes("not fully traversed"))).toBe(true);
	});

	test("a speculative edge is marked in the label", () => {
		const speculative = data({
			graph: {
				roots: ["s"],
				nodes: { s: { id: "s", label: "guess", children: [], speculative: true } },
			},
		});
		expect(renderPane(speculative, initialState(), "graph").lines[0]).toContain("(speculative)");
	});

	test("a root referring to a missing node produces no line rather than throwing", () => {
		const broken = data({ graph: { roots: ["ghost"], nodes: {} } });
		expect(flattenGraph(broken, initialState())).toEqual([]);
	});
});

describe("cross-pane links", () => {
	test("selecting a hypothesis links its evidence and timeline rows", () => {
		const state = select(initialState(), data(), "hypotheses", "h1").state;
		const links = crossLinks(data(), state);
		expect(links.evidence).toEqual(["e1"]);
		expect(links.timeline).toEqual(["t2"]);
	});

	test("a citation to evidence that does not exist is shown as dangling", () => {
		const broken = data({
			hypotheses: [
				{ id: "h1", statement: "x", confidence: 0.5, cites: ["e1", "ghost"], status: "open" },
			],
		});
		const state = select(initialState(), broken, "hypotheses", "h1").state;
		expect(crossLinks(broken, state).dangling).toEqual(["ghost"]);
	});

	test("evidence nobody cites is surfaced", () => {
		const state = select(initialState(), data(), "hypotheses", "h1").state;
		expect(crossLinks(data(), state).uncited_evidence).toEqual(["e2"]);
	});

	test("uncited evidence is visible in the evidence pane itself", () => {
		const rendered = renderPane(data(), initialState(), "evidence");
		expect(rendered.lines.join("\n")).toContain("(uncited)");
	});

	test("with no hypothesis selected the links are empty but the audit still runs", () => {
		const links = crossLinks(data(), initialState());
		expect(links.evidence).toEqual([]);
		expect(links.uncited_evidence).toEqual(["e2"]);
	});
});

describe("the screen", () => {
	test("all four panes are rendered and exactly one is focused", () => {
		const screen = renderScreen(data(), initialState());
		expect(screen.panes.map((p) => p.pane)).toEqual([...PANES]);
		expect(screen.panes.filter((p) => p.focused)).toHaveLength(1);
	});

	test("focus follows the last successful selection", () => {
		const state = select(initialState(), data(), "hypotheses", "h1").state;
		const screen = renderScreen(data(), state);
		expect(screen.panes.find((p) => p.focused)?.pane).toBe("hypotheses");
	});

	test("a selected row is marked in its pane", () => {
		const state = select(initialState(), data(), "timeline", "t2").state;
		const rendered = renderPane(data(), state, "timeline");
		expect(rendered.lines.some((l) => l.startsWith("> "))).toBe(true);
	});

	test("an empty data set renders empty panes rather than failing", () => {
		const empty: ViewData = {
			timeline: [],
			graph: { roots: [], nodes: {} },
			evidence: [],
			hypotheses: [],
		};
		const screen = renderScreen(empty, initialState());
		expect(screen.panes.every((p) => p.lines.length === 0)).toBe(true);
		expect(screen.elisions).toEqual([]);
	});
});
