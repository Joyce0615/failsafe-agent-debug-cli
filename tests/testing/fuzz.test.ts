import { describe, expect, test } from "bun:test";
import { breakCycles, findCycle } from "../../src/diagnosis/causal-construction.js";
import { detectAndParse } from "../../src/parsers/index.js";
import {
	BUNDLE_MUTATIONS,
	type FuzzEdge,
	type FuzzEvent,
	type Property,
	garbledOutput,
	hostileEvents,
	hostileGraph,
	hostileLocation,
	hostileMutation,
	runProperties,
	runProperty,
	shrinkArray,
	shrinkString,
} from "../../src/testing/fuzz.js";
import { normalizeTimeline } from "../../src/diagnosis/timeline.js";
import { mulberry32 } from "../../src/utils/random.js";

describe("the harness itself", () => {
	test("a holding property passes over the full run count", () => {
		const result = runProperty(
			{
				name: "strings are strings",
				generator: garbledOutput,
				check: (value) => (typeof value === "string" ? null : "not a string"),
			},
			{ runs: 50 },
		);
		expect(result.passed).toBe(true);
		expect(result.runs).toBe(50);
	});

	test("a violated property reports the claim, not merely that something failed", () => {
		const result = runProperty(
			{
				name: "no newlines",
				generator: garbledOutput,
				check: (value) => (value.includes("\n") ? "output contained a newline" : null),
			},
			{ runs: 50 },
		);
		expect(result.passed).toBe(false);
		expect(result.failure?.message).toBe("output contained a newline");
	});

	test("a failure is reproducible from its seed", () => {
		const property: Property<string> = {
			name: "no letter a",
			generator: garbledOutput,
			check: (value) => (value.includes("a") ? "contained 'a'" : null),
		};
		const first = runProperty(property, { runs: 100, seed: 5 });
		expect(first.passed).toBe(false);
		const reproduced = property.generator(mulberry32(first.failure!.seed));
		expect(property.check(reproduced)).not.toBeNull();
	});

	test("shrinking reduces the counterexample and counts its steps", () => {
		const result = runProperty(
			{
				name: "short strings",
				generator: (rand) => "x".repeat(20 + Math.floor(rand() * 40)),
				check: (value) => (value.length > 3 ? "too long" : null),
				shrink: shrinkString,
			},
			{ runs: 5 },
		);
		expect(result.failure!.input.length).toBeLessThan(result.failure!.original.length);
		expect(result.failure!.shrink_steps).toBeGreaterThan(0);
	});

	test("a property with no shrinker reports the original unchanged", () => {
		const result = runProperty(
			{
				name: "no shrinker",
				generator: () => "aaaaaaaaaa",
				check: () => "always fails",
			},
			{ runs: 1 },
		);
		expect(result.failure!.input).toBe(result.failure!.original);
		expect(result.failure!.shrink_steps).toBe(0);
	});

	test("array shrinking produces strictly smaller candidates", () => {
		for (const candidate of shrinkArray([1, 2, 3, 4, 5])) {
			expect(candidate.length).toBeLessThan(5);
		}
		expect(shrinkArray([])).toEqual([]);
	});

	test("string shrinking never returns the input unchanged", () => {
		expect(shrinkString("abcd").every((c) => c !== "abcd")).toBe(true);
		expect(shrinkString("")).toEqual([]);
	});

	test("running several properties summarizes and keeps every seed", () => {
		const summary = runProperties(
			[
				{ name: "always holds", generator: () => 1, check: () => null },
				{ name: "never holds", generator: () => 1, check: () => "nope" },
			] as Array<Property<unknown>>,
			{ runs: 10 },
		);
		expect(summary.properties).toBe(2);
		expect(summary.passed).toBe(1);
		expect(summary.failed[0].name).toBe("never holds");
		expect(typeof summary.failed[0].seed).toBe("number");
	});
});

describe("the generators produce structurally plausible garbage", () => {
	test("garbled output frequently carries a real tool prefix", () => {
		const samples = Array.from({ length: 60 }, (_, i) => garbledOutput(mulberry32(i)));
		const withPrefix = samples.filter((s) =>
			/Traceback|File "|\s+at |FAILED|error\[E|--- FAIL|%Error|UVM_ERROR/.test(s),
		);
		expect(withPrefix.length).toBeGreaterThan(20);
	});

	test("hostile locations include the line numbers that actually appear in the wild", () => {
		const samples = Array.from({ length: 80 }, (_, i) => hostileLocation(mulberry32(i)));
		expect(samples.some((s) => s.endsWith(":-1"))).toBe(true);
		expect(samples.some((s) => s.endsWith(":0"))).toBe(true);
		expect(samples.some((s) => s.endsWith(":NaN"))).toBe(true);
	});

	test("hostile events include duplicates, self-parents, and dangling parents", () => {
		const batches = Array.from({ length: 40 }, (_, i) => hostileEvents(mulberry32(i)));
		const flat = batches.flat();
		expect(flat.some((e) => e.parent === e.id)).toBe(true);
		expect(flat.some((e) => e.parent === "ghost")).toBe(true);
		expect(batches.some((b) => new Set(b.map((e) => e.id)).size < b.length)).toBe(true);
	});

	test("hostile graphs frequently contain cycles, which is the path worth testing", () => {
		const withCycles = Array.from({ length: 60 }, (_, i) => {
			const { edges } = hostileGraph(mulberry32(i));
			return findCycle(
				edges.map((e: FuzzEdge) => ({
					from: e.from,
					to: e.to,
					type: "causes" as const,
					strength: 0.5,
					justifications: [],
					speculative: false,
				})),
			);
		}).filter(Boolean);
		expect(withCycles.length).toBeGreaterThan(10);
	});

	test("every declared bundle mutation is reachable from the generator", () => {
		const seen = new Set(
			Array.from({ length: 200 }, (_, i) => hostileMutation(mulberry32(i))),
		);
		expect(seen.size).toBe(BUNDLE_MUTATIONS.length);
	});
});

describe("parser properties", () => {
	test("no parser ever emits a location with a line below 1", () => {
		const result = runProperty(
			{
				name: "parser locations are 1-based",
				generator: (rand) => `${garbledOutput(rand)}\n${hostileLocation(rand)}: error`,
				check: (output) => {
					for (const parsed of detectAndParse(output, "", "make", { mineTemplates: true })) {
						for (const error of parsed.errors) {
							const line = error.location?.line;
							if (line !== undefined && (!Number.isFinite(line) || line < 1)) {
								return `${parsed.parser} emitted line ${line}`;
							}
							for (const frame of error.stack_frames ?? []) {
								if (!Number.isFinite(frame.line) || frame.line < 1) {
									return `${parsed.parser} emitted frame line ${frame.line}`;
								}
							}
						}
					}
					return null;
				},
				shrink: shrinkString,
			},
			{ runs: 300 },
		);
		expect(result.failure?.message ?? null).toBeNull();
		expect(result.passed).toBe(true);
	});

	test("no parser ever emits an empty error message", () => {
		const result = runProperty(
			{
				name: "messages are non-empty",
				generator: garbledOutput,
				check: (output) => {
					for (const parsed of detectAndParse(output, "", "make", { mineTemplates: true })) {
						for (const error of parsed.errors) {
							if (error.message.trim().length === 0) return `${parsed.parser} emitted an empty message`;
						}
					}
					return null;
				},
				shrink: shrinkString,
			},
			{ runs: 300 },
		);
		expect(result.passed).toBe(true);
	});

	test("parsing is deterministic for identical input", () => {
		const result = runProperty(
			{
				name: "parsing is a function",
				generator: garbledOutput,
				check: (output) => {
					const a = JSON.stringify(detectAndParse(output, "", "make", { mineTemplates: true }));
					const b = JSON.stringify(detectAndParse(output, "", "make", { mineTemplates: true }));
					return a === b ? null : "two parses of the same input differed";
				},
			},
			{ runs: 100 },
		);
		expect(result.passed).toBe(true);
	});
});

describe("timeline properties", () => {
	test("normalization never invents events", () => {
		const result = runProperty(
			{
				name: "timeline never grows",
				generator: hostileEvents,
				check: (events: FuzzEvent[]) => {
					const normalized = normalizeTimeline(
						events.map((e, i) => ({
							id: e.id,
							source: "output" as const,
							clock: "local",
							ts_ms: Number.isFinite(e.ts_ms) ? e.ts_ms : i,
							label: e.label,
						})),
					);
					return normalized.events.length <= events.length
						? null
						: `${events.length} events in, ${normalized.events.length} out`;
				},
				shrink: shrinkArray,
			},
			{ runs: 200 },
		);
		expect(result.passed).toBe(true);
	});

	test("normalized events are ordered and carry non-negative uncertainty", () => {
		const result = runProperty(
			{
				name: "timeline invariants",
				generator: hostileEvents,
				check: (events: FuzzEvent[]) => {
					const normalized = normalizeTimeline(
						events.map((e, i) => ({
							id: e.id,
							source: "output" as const,
							clock: "local",
							ts_ms: Number.isFinite(e.ts_ms) ? e.ts_ms : i,
							label: e.label,
						})),
					);
					for (let i = 1; i < normalized.events.length; i++) {
						if (normalized.events[i].ts_ms < normalized.events[i - 1].ts_ms) {
							return "events are not in ascending time order";
						}
					}
					for (const event of normalized.events) {
						if (event.uncertainty_ms < 0) return `negative uncertainty ${event.uncertainty_ms}`;
					}
					return null;
				},
				shrink: shrinkArray,
			},
			{ runs: 200 },
		);
		expect(result.passed).toBe(true);
	});
});

describe("causal graph properties", () => {
	test("cycle breaking always terminates with an acyclic graph", () => {
		const result = runProperty(
			{
				name: "breakCycles produces a DAG",
				generator: hostileGraph,
				check: ({ edges }) => {
					const constructed = edges.map((e: FuzzEdge) => ({
						from: e.from,
						to: e.to,
						type: "causes" as const,
						strength: 0.5,
						justifications: [],
						speculative: false,
					}));
					const { kept } = breakCycles(constructed);
					return findCycle(kept) === null ? null : "a cycle survived breakCycles";
				},
			},
			{ runs: 300 },
		);
		expect(result.passed).toBe(true);
	});

	test("cycle breaking never adds an edge", () => {
		const result = runProperty(
			{
				name: "breakCycles only removes",
				generator: hostileGraph,
				check: ({ edges }) => {
					const constructed = edges.map((e: FuzzEdge) => ({
						from: e.from,
						to: e.to,
						type: "causes" as const,
						strength: 0.5,
						justifications: [],
						speculative: false,
					}));
					const { kept, removed } = breakCycles(constructed);
					return kept.length + removed.length === constructed.length
						? null
						: `${constructed.length} in, ${kept.length} kept and ${removed.length} removed`;
				},
			},
			{ runs: 300 },
		);
		expect(result.passed).toBe(true);
	});
});
