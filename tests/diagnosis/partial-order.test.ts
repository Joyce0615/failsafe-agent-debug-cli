/**
 * Item 8 -- reconstruct a partial order under clock skew.
 *
 * The central claim under test: a causal fact (explicit happens-before link)
 * must never be overridden by a clock-derived guess, even a well-calibrated
 * one -- and the combined relation must never claim BOTH `a` before `b` AND
 * `b` before `a` (that would be inventing a total order where the evidence
 * doesn't support one, exactly what this item forbids).
 */
import { describe, expect, test } from "bun:test";
import { normalizeTimeline, type RawEvent } from "../../src/diagnosis/timeline.js";
import { reconstructPartialOrder, type CausalLink } from "../../src/diagnosis/partial-order.js";

function event(id: string, ts_ms: number, clock = "local", precision_ms = 1): RawEvent {
	return { id, source: "trace", clock, ts_ms, precision_ms, label: id };
}

describe("partial order resolves clock-vs-causal conflicts without inventing a total order (Item 8)", () => {
	test("a causal link wins over a contradicting clock guess, in both directions", () => {
		// Skewed clock makes the RESPONSE look like it happened before the
		// REQUEST (ts: response=100±2ms, request=120±2ms, no overlap -> clock
		// alone would confidently say response before request). A causal link
		// (the actual request/response pairing) says the opposite and must win.
		const raw: RawEvent[] = [event("response", 100), event("request", 120)];
		const timeline = normalizeTimeline(raw);
		const links: CausalLink[] = [
			{ before: "request", after: "response", reason: "request/response pairing" },
		];
		const result = reconstructPartialOrder(timeline.events, links);

		expect(result.happensBefore("request", "response")).toBe(true);
		expect(result.happensBefore("response", "request")).toBe(false); // never both directions
		expect(result.rejected_clock_edges).toHaveLength(1);
		expect(result.rejected_clock_edges[0]).toMatchObject({ before: "response", after: "request" });
		expect(result.uncertainty.join(" ")).toMatch(/clock evidence.*rejected/);
	});

	test("never reports happensBefore true in both directions for ANY pair, across many random clock-skewed events with one causal link", () => {
		const raw: RawEvent[] = Array.from({ length: 15 }, (_, i) =>
			event(`e${i}`, (i * 37) % 200, "flaky-clock", 3),
		);
		const timeline = normalizeTimeline(raw);
		const links: CausalLink[] = [{ before: "e14", after: "e0", reason: "forced-contradiction" }];
		const result = reconstructPartialOrder(timeline.events, links);
		const ids = raw.map((e) => e.id);
		for (const a of ids) {
			for (const b of ids) {
				if (a === b) continue;
				const bothWays = result.happensBefore(a, b) && result.happensBefore(b, a);
				expect(bothWays).toBe(false);
			}
		}
	});

	test("agreeing clock and causal evidence compose transitively", () => {
		const raw: RawEvent[] = [event("a", 0), event("b", 50), event("c", 100)];
		const timeline = normalizeTimeline(raw);
		const links: CausalLink[] = [{ before: "a", after: "b", reason: "span parent/child" }];
		const result = reconstructPartialOrder(timeline.events, links);
		expect(result.happensBefore("a", "b")).toBe(true);
		expect(result.happensBefore("b", "c")).toBe(true);
		expect(result.happensBefore("a", "c")).toBe(true); // transitive
	});

	test("events whose uncertainty intervals overlap are reported as concurrent, not ordered", () => {
		const raw: RawEvent[] = [event("a", 100, "local", 10), event("b", 102, "local", 10)];
		const timeline = normalizeTimeline(raw);
		const result = reconstructPartialOrder(timeline.events, []);
		expect(result.concurrent("a", "b")).toBe(true);
		expect(result.happensBefore("a", "b")).toBe(false);
		expect(result.happensBefore("b", "a")).toBe(false);
	});

	test("two directly contradicting causal links are both rejected, not arbitrarily resolved", () => {
		const raw: RawEvent[] = [event("x", 0), event("y", 1000)];
		const timeline = normalizeTimeline(raw);
		const links: CausalLink[] = [
			{ before: "x", after: "y", reason: "claim 1" },
			{ before: "y", after: "x", reason: "claim 2 (contradicts claim 1)" },
		];
		const result = reconstructPartialOrder(timeline.events, links);
		expect(result.contradictions).toHaveLength(1);
		// Neither direction should be asserted as a fact from the contradicting pair.
		const edgeBases = result.edges.filter(
			(e) => (e.before === "x" && e.after === "y") || (e.before === "y" && e.after === "x"),
		);
		expect(edgeBases.every((e) => e.basis === "clock")).toBe(true);
	});
});
