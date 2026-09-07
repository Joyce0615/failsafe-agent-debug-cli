import { describe, expect, test } from "bun:test";
import {
	BASIS_CONFIDENCE,
	BOUNDARY_BASES,
	DEFAULT_MIN_EVENTS,
	type PhaseEvent,
	classifyPhase,
	iterationAt,
	reconstruct,
	summarizePhases,
} from "../../src/trace/phases.js";

function ev(overrides: Partial<PhaseEvent> & { id: string; ts_ms: number }): PhaseEvent {
	return { kind: "tool", label: "read_file", duration_ms: 100, ...overrides };
}

/** A three-iteration loop: llm → tool → llm → tool → llm → tool. */
function loop(): PhaseEvent[] {
	const events: PhaseEvent[] = [];
	for (let i = 0; i < 3; i++) {
		events.push(ev({ id: `llm${i}`, ts_ms: i * 1000, kind: "llm", label: "chat" }));
		events.push(ev({ id: `tool${i}`, ts_ms: i * 1000 + 200, kind: "tool", label: "read_file" }));
	}
	return events;
}

describe("refusal on sparse telemetry", () => {
	test("no events is a refusal, not an empty success", () => {
		const result = reconstruct([]);
		expect(result.iterations).toEqual([]);
		expect(result.refused_reason).toContain("no events");
	});

	test("too few events refuses rather than inventing one iteration", () => {
		const result = reconstruct([ev({ id: "a", ts_ms: 0 }), ev({ id: "b", ts_ms: 100 })]);
		expect(result.iterations).toEqual([]);
		expect(result.refused_reason).toContain(String(DEFAULT_MIN_EVENTS));
	});

	test("events spread too thinly over time refuse on density", () => {
		const sparse = Array.from({ length: 5 }, (_, i) =>
			ev({ id: `e${i}`, ts_ms: i * 60 * 60_000 }),
		);
		const result = reconstruct(sparse);
		expect(result.iterations).toEqual([]);
		expect(result.refused_reason).toContain("density");
	});

	test("a refusal still reports which producers were seen", () => {
		const result = reconstruct([ev({ id: "a", ts_ms: 0, source: "collector-1" })]);
		expect(result.sources).toEqual(["collector-1"]);
	});

	test("the density floor is configurable", () => {
		const sparse = Array.from({ length: 5 }, (_, i) => ev({ id: `e${i}`, ts_ms: i * 60_000 }));
		expect(reconstruct(sparse, { min_density_per_minute: 100 }).iterations).toEqual([]);
		expect(reconstruct(sparse, { min_density_per_minute: 0 }).iterations.length).toBeGreaterThan(0);
	});
});

describe("declared iterations win outright", () => {
	const declared: PhaseEvent[] = [
		ev({ id: "a", ts_ms: 0, declared_iteration: 0, kind: "llm", label: "chat" }),
		ev({ id: "b", ts_ms: 100, declared_iteration: 0 }),
		ev({ id: "c", ts_ms: 200, declared_iteration: 1, kind: "llm", label: "chat" }),
		ev({ id: "d", ts_ms: 300, declared_iteration: 1 }),
		ev({ id: "e", ts_ms: 400, declared_iteration: 2 }),
	];

	test("the producer's indices define the segmentation", () => {
		const result = reconstruct(declared);
		expect(result.iterations).toHaveLength(3);
		expect(result.iterations[0].events.map((e) => e.id)).toEqual(["a", "b"]);
	});

	test("every boundary is recorded as declared, not inferred", () => {
		const result = reconstruct(declared);
		for (const iteration of result.iterations.slice(1)) {
			expect(iteration.opened_by?.basis).toBe("declared");
			expect(iteration.opened_by?.confidence).toBe(BASIS_CONFIDENCE.declared);
		}
	});

	test("no inference caveat is raised when the producer declared", () => {
		expect(reconstruct(declared).caveats.some((c) => c.includes("every boundary here is inferred"))).toBe(
			false,
		);
	});

	test("an unlabelled event joins the current iteration rather than starting a phantom one", () => {
		const mixed = [...declared, ev({ id: "f", ts_ms: 450 })];
		const result = reconstruct(mixed);
		expect(result.iterations).toHaveLength(3);
		expect(result.iterations[2].events.map((e) => e.id)).toEqual(["e", "f"]);
	});
});

describe("inferred boundaries record their basis", () => {
	test("an LLM call after a tool call opens a new iteration", () => {
		const result = reconstruct(loop());
		expect(result.iterations).toHaveLength(3);
		expect(result.iterations[1].opened_by?.basis).toBe("llm_call");
		expect(result.iterations[1].opened_by?.detail).toContain("observed a result");
	});

	test("an LLM call with no intervening tool call is a continuation", () => {
		const events = [
			ev({ id: "l1", ts_ms: 0, kind: "llm", label: "chat" }),
			ev({ id: "l2", ts_ms: 100, kind: "llm", label: "chat" }),
			ev({ id: "l3", ts_ms: 200, kind: "llm", label: "chat" }),
			ev({ id: "l4", ts_ms: 300, kind: "llm", label: "chat" }),
		];
		expect(reconstruct(events).iterations).toHaveLength(1);
	});

	test("a long silence opens an iteration on the weakest basis", () => {
		const events = [
			ev({ id: "a", ts_ms: 0 }),
			ev({ id: "b", ts_ms: 100 }),
			ev({ id: "c", ts_ms: 200 }),
			ev({ id: "d", ts_ms: 200_000 }),
		];
		const result = reconstruct(events, { gap_ms: 1000, min_density_per_minute: 0 });
		expect(result.iterations).toHaveLength(2);
		expect(result.iterations[1].opened_by?.basis).toBe("temporal_gap");
		expect(result.iterations[1].opened_by?.confidence).toBe(BASIS_CONFIDENCE.temporal_gap);
	});

	test("the ladder is ordered strongest to weakest", () => {
		expect(BOUNDARY_BASES).toEqual(["declared", "llm_call", "tool_pattern", "temporal_gap"]);
		for (let i = 1; i < BOUNDARY_BASES.length; i++) {
			expect(BASIS_CONFIDENCE[BOUNDARY_BASES[i]]).toBeLessThan(
				BASIS_CONFIDENCE[BOUNDARY_BASES[i - 1]],
			);
		}
	});

	test("the weakest boundary in the chain is surfaced", () => {
		const events = [
			...loop(),
			ev({ id: "late", ts_ms: 500_000, kind: "tool", label: "read_file" }),
		];
		const result = reconstruct(events, { gap_ms: 1000, min_density_per_minute: 0 });
		expect(result.weakest_boundary?.basis).toBe("temporal_gap");
	});

	test("an inference caveat is always raised when nothing was declared", () => {
		expect(
			reconstruct(loop()).caveats.some((c) => c.includes("every boundary here is inferred")),
		).toBe(true);
	});

	test("the first iteration has no opening boundary", () => {
		expect(reconstruct(loop()).iterations[0].opened_by).toBeNull();
	});
});

describe("phase classification", () => {
	test("a read-heavy iteration is exploration", () => {
		const result = classifyPhase([
			ev({ id: "a", ts_ms: 0, label: "read_file" }),
			ev({ id: "b", ts_ms: 1, label: "search_repo" }),
			ev({ id: "c", ts_ms: 2, label: "glob" }),
		]);
		expect(result.phase).toBe("explore");
		expect(result.confidence).toBe(1);
	});

	test("an edit-heavy iteration is editing", () => {
		expect(
			classifyPhase([
				ev({ id: "a", ts_ms: 0, label: "apply_patch" }),
				ev({ id: "b", ts_ms: 1, label: "write_file" }),
			]).phase,
		).toBe("edit");
	});

	test("a test run is verification", () => {
		expect(classifyPhase([ev({ id: "a", ts_ms: 0, label: "run_tests" })]).phase).toBe("verify");
	});

	test("naming conventions are matched by fragment, not exact string", () => {
		expect(classifyPhase([ev({ id: "a", ts_ms: 0, label: "fs.readFileSync" })]).phase).toBe(
			"explore",
		);
	});

	test("an evenly mixed iteration is unknown, not arbitrarily assigned", () => {
		const result = classifyPhase([
			ev({ id: "a", ts_ms: 0, label: "read_file" }),
			ev({ id: "b", ts_ms: 1, label: "run_tests" }),
		]);
		expect(result.phase).toBe("unknown");
		expect(result.alternatives.sort()).toEqual(["explore", "verify"]);
	});

	test("a clear majority still wins over a minority signal", () => {
		const result = classifyPhase([
			ev({ id: "a", ts_ms: 0, label: "read_file" }),
			ev({ id: "b", ts_ms: 1, label: "search_repo" }),
			ev({ id: "c", ts_ms: 2, label: "grep" }),
			ev({ id: "d", ts_ms: 3, label: "run_tests" }),
		]);
		expect(result.phase).toBe("explore");
		expect(result.alternatives).toEqual(["verify"]);
		expect(result.confidence).toBeGreaterThan(0.5);
	});

	test("an iteration with no recognizable signal is unknown with zero confidence", () => {
		const result = classifyPhase([ev({ id: "a", ts_ms: 0, kind: "log", label: "zzz" })]);
		expect(result.phase).toBe("unknown");
		expect(result.confidence).toBe(0);
		expect(result.alternatives).toEqual([]);
	});

	test("ambiguous phases are reported as a caveat on the reconstruction", () => {
		const events = [
			ev({ id: "l0", ts_ms: 0, kind: "llm", label: "chat" }),
			ev({ id: "t0", ts_ms: 100, label: "read_file" }),
			ev({ id: "t1", ts_ms: 200, label: "run_tests" }),
			ev({ id: "l1", ts_ms: 300, kind: "llm", label: "chat" }),
			ev({ id: "t2", ts_ms: 400, label: "read_file" }),
			ev({ id: "t3", ts_ms: 500, label: "run_tests" }),
		];
		const result = reconstruct(events);
		expect(result.caveats.some((c) => c.includes("no clear phase"))).toBe(true);
	});
});

describe("coverage is computed and surfaced", () => {
	test("a dense run has high coverage and no coverage caveat", () => {
		const events = [
			ev({ id: "a", ts_ms: 0, duration_ms: 500, kind: "llm", label: "chat" }),
			ev({ id: "b", ts_ms: 500, duration_ms: 500 }),
			ev({ id: "c", ts_ms: 1000, duration_ms: 500, kind: "llm", label: "chat" }),
			ev({ id: "d", ts_ms: 1500, duration_ms: 500 }),
		];
		const result = reconstruct(events);
		expect(result.coverage).toBeGreaterThan(0.8);
		expect(result.caveats.some((c) => c.includes("wall time"))).toBe(false);
	});

	test("a run with a huge hole reports low coverage and says the durations are unreliable", () => {
		const events = [
			ev({ id: "a", ts_ms: 0, duration_ms: 10, kind: "llm", label: "chat" }),
			ev({ id: "b", ts_ms: 20, duration_ms: 10 }),
			ev({ id: "c", ts_ms: 100_000, duration_ms: 10, kind: "llm", label: "chat" }),
			ev({ id: "d", ts_ms: 100_020, duration_ms: 10 }),
		];
		const result = reconstruct(events, { gap_ms: 1000, min_density_per_minute: 0 });
		expect(result.coverage).toBeLessThan(0.1);
		expect(result.caveats.some((c) => c.includes("wrong by an unknown amount"))).toBe(true);
	});

	test("unaccounted gaps between iterations are enumerated", () => {
		const events = [
			ev({ id: "a", ts_ms: 0, duration_ms: 10, kind: "llm", label: "chat" }),
			ev({ id: "b", ts_ms: 20, duration_ms: 10 }),
			ev({ id: "c", ts_ms: 100_000, duration_ms: 10, kind: "llm", label: "chat" }),
			ev({ id: "d", ts_ms: 100_020, duration_ms: 10 }),
		];
		const result = reconstruct(events, { gap_ms: 1000, min_density_per_minute: 0 });
		expect(result.unaccounted_gaps).toHaveLength(1);
		expect(result.unaccounted_gaps[0].duration_ms).toBeGreaterThan(99_000);
	});
});

describe("summaries and lookup", () => {
	test("phase totals aggregate iterations of the same phase", () => {
		const result = reconstruct(loop());
		const summary = summarizePhases(result.iterations);
		expect(summary.reduce((sum, s) => sum + s.iterations, 0)).toBe(result.iterations.length);
	});

	test("summaries are ordered by time spent", () => {
		const summary = summarizePhases(reconstruct(loop()).iterations);
		for (let i = 1; i < summary.length; i++) {
			expect(summary[i - 1].total_ms).toBeGreaterThanOrEqual(summary[i].total_ms);
		}
	});

	test("an empty iteration list summarizes to nothing", () => {
		expect(summarizePhases([])).toEqual([]);
	});

	test("a moment inside an iteration is found; one outside is not", () => {
		const iterations = reconstruct(loop()).iterations;
		expect(iterationAt(iterations, iterations[1].start_ms)?.index).toBe(1);
		expect(iterationAt(iterations, -1)).toBeNull();
	});

	test("events are ordered by time regardless of input order", () => {
		const shuffled = [...loop()].reverse();
		const a = reconstruct(loop()).iterations.map((i) => i.events.map((e) => e.id));
		const b = reconstruct(shuffled).iterations.map((i) => i.events.map((e) => e.id));
		expect(a).toEqual(b);
	});
});
