import { describe, expect, test } from "bun:test";
import {
	type Ablation,
	type ReplayOutcome,
	type ReplayRunner,
	type TraceEvent,
	applyAblation,
	localizeFault,
	removalAblations,
	renderFaultLocalizationReport,
} from "../../src/diagnosis/fault-localization.js";

function trace(ids: string[]): TraceEvent[] {
	return ids.map((id) => ({ id, kind: "tool_call", payload: { id } }));
}

/** A runner driven by a lookup of eventId -> outcome when that event is ablated. */
function scripted(
	baseline: ReplayOutcome,
	byEvent: Record<string, ReplayOutcome>,
	fallback: ReplayOutcome = "failed",
): ReplayRunner {
	return (events) => {
		const ids = new Set(events.map((e) => e.id));
		// Determine which single original event is "missing" from this replay, if any.
		const allIds = Object.keys(byEvent);
		const missing = allIds.find((id) => !ids.has(id));
		if (missing === undefined) return baseline;
		return byEvent[missing] ?? fallback;
	};
}

describe("applyAblation", () => {
	test("removed drops exactly the named event, immutably", () => {
		const events = trace(["a", "b", "c"]);
		const ablated = applyAblation(events, { eventId: "b", mode: "removed" });
		expect(ablated.map((e) => e.id)).toEqual(["a", "c"]);
		expect(events.map((e) => e.id)).toEqual(["a", "b", "c"]); // original untouched
	});

	test("replaced swaps only the named event's payload", () => {
		const events = trace(["a", "b"]);
		const ablated = applyAblation(events, {
			eventId: "a",
			mode: "replaced",
			replacement: { stub: true },
		});
		expect(ablated).toEqual([
			{ id: "a", kind: "tool_call", payload: { stub: true } },
			{ id: "b", kind: "tool_call", payload: { id: "b" } },
		]);
	});
});

describe("removalAblations", () => {
	test("one removal ablation per event, in trace order", () => {
		const events = trace(["x", "y", "z"]);
		expect(removalAblations(events)).toEqual([
			{ eventId: "x", mode: "removed" },
			{ eventId: "y", mode: "removed" },
			{ eventId: "z", mode: "removed" },
		]);
	});
});

describe("localizeFault: ranking the causal event", () => {
	test("the ablation that flips failed->passed is ranked; ablations that stay failed are not", async () => {
		const events = trace(["a", "b", "c"]);
		// Removing "b" is the one ablation that fixes the run; removing "a" or "c"
		// leaves it failing.
		const runner = scripted("failed", { a: "failed", b: "passed", c: "failed" });
		const report = await localizeFault(events, removalAblations(events), runner);

		expect(report.baselineOutcome).toBe("failed");
		expect(report.ranking).toEqual([{ eventId: "b", mode: "removed", effect: 1 }]);
		expect(report.inconclusive).toEqual([]);
	});

	test("ties break on the trace's original event order", async () => {
		const events = trace(["a", "b", "c"]);
		// Removing either "a" or "c" fixes it; "b" does not.
		const runner = scripted("failed", { a: "passed", b: "failed", c: "passed" });
		const report = await localizeFault(events, removalAblations(events), runner);
		expect(report.ranking.map((r) => r.eventId)).toEqual(["a", "c"]);
	});

	test("replace ablations are ranked the same way as removals", async () => {
		const events = trace(["a", "b"]);
		const runner: ReplayRunner = (replayed) => {
			const b = replayed.find((e) => e.id === "b");
			if (b?.payload && (b.payload as { stub?: boolean }).stub) return "passed";
			return "failed";
		};
		const ablations: Ablation[] = [
			{ eventId: "a", mode: "replaced", replacement: { stub: true } },
			{ eventId: "b", mode: "replaced", replacement: { stub: true } },
		];
		const report = await localizeFault(events, ablations, runner);
		expect(report.ranking).toEqual([{ eventId: "b", mode: "replaced", effect: 1 }]);
	});
});

describe("localizeFault: a harness error is not a flip (the real bug this item fixes)", () => {
	test("an ablation that errors the harness is reported inconclusive, never ranked as causal", async () => {
		const events = trace(["a", "b", "c"]);
		// Removing "a" leaves the run genuinely failing (no fix).
		// Removing "b" crashes the harness itself (e.g. downstream code
		// unconditionally dereferences the removed tool result) -- this is
		// NOT evidence that "b" caused the original failure, it is evidence
		// the harness cannot tolerate "b" being missing.
		// Removing "c" is the actual fix.
		const runner = scripted("failed", { a: "failed", b: "error", c: "passed" });
		const report = await localizeFault(events, removalAblations(events), runner);

		// The real fix: "c" alone is ranked causal.
		expect(report.ranking).toEqual([{ eventId: "c", mode: "removed", effect: 1 }]);
		// "b" must be reported as inconclusive, not folded into the ranking as
		// if an error were as good as a pass.
		expect(report.inconclusive.map((r) => r.eventId)).toEqual(["b"]);
		expect(report.results.find((r) => r.eventId === "b")?.flipped).toBe(false);
	});

	test("every ablation erroring yields an empty ranking, not a false-positive top suspect", async () => {
		const events = trace(["a", "b"]);
		const runner = scripted("failed", { a: "error", b: "error" });
		const report = await localizeFault(events, removalAblations(events), runner);
		expect(report.ranking).toEqual([]);
		expect(report.inconclusive).toHaveLength(2);
	});
});

describe("renderFaultLocalizationReport", () => {
	test("names the ranked event and separately names inconclusive ablations", async () => {
		const events = trace(["a", "b"]);
		const runner = scripted("failed", { a: "error", b: "passed" });
		const report = await localizeFault(events, removalAblations(events), runner);
		const rendered = renderFaultLocalizationReport(report);
		expect(rendered).toContain("ranking (highest effect first):");
		expect(rendered).toContain("b (removed): effect 1");
		expect(rendered).toContain("inconclusive (1): a (removed)");
	});

	test("reports explicitly when nothing flipped", async () => {
		const events = trace(["a"]);
		const runner = scripted("failed", { a: "failed" });
		const report = await localizeFault(events, removalAblations(events), runner);
		expect(renderFaultLocalizationReport(report)).toContain("no ablation flipped the outcome");
	});
});
