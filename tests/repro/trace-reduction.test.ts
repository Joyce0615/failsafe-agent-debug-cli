import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MAX_ORACLE_CALLS,
	type ReductionOracle,
	type TraceElement,
	causeCriticalElements,
	closeOverDependencies,
	reduceTrace,
	reductionRatio,
} from "../../src/repro/trace-reduction.js";

function elements(ids: string[]): TraceElement[] {
	return ids.map((id) => ({ id }));
}

/** An oracle that fails exactly when every element of `required` is present. */
function requiring(required: string[], signature = "AssertionError"): ReductionOracle {
	return (ids) => {
		const present = new Set(ids);
		const reproduces = required.every((r) => present.has(r));
		return reproduces ? { reproduces: true, cause_signature: signature } : { reproduces: false };
	};
}

describe("dependency closure", () => {
	const withDeps: TraceElement[] = [
		{ id: "parent" },
		{ id: "child", depends_on: ["parent"] },
		{ id: "grandchild", depends_on: ["child"] },
		{ id: "independent" },
	];

	test("removing a parent removes its descendants transitively", () => {
		const closed = closeOverDependencies(
			withDeps,
			new Set(["child", "grandchild", "independent"]),
		);
		expect([...closed].sort()).toEqual(["independent"]);
	});

	test("a complete subtree is left alone", () => {
		const closed = closeOverDependencies(withDeps, new Set(["parent", "child"]));
		expect([...closed].sort()).toEqual(["child", "parent"]);
	});

	test("a dependency on an element outside the trace is ignored", () => {
		const closed = closeOverDependencies(
			[{ id: "a", depends_on: ["external"] }],
			new Set(["a"]),
		);
		expect([...closed]).toEqual(["a"]);
	});

	test("an empty keep set stays empty", () => {
		expect(closeOverDependencies(withDeps, new Set()).size).toBe(0);
	});
});

describe("basic reduction", () => {
	test("a trace with one culprit reduces to it", async () => {
		const result = await reduceTrace(
			elements(["a", "b", "c", "d", "e", "f", "g", "h"]),
			requiring(["e"]),
		);
		expect(result.elements.map((e) => e.id)).toEqual(["e"]);
		expect(result.minimality).toBe("one_minimal");
		expect(reductionRatio(result)).toBeCloseTo(7 / 8, 5);
	});

	test("a trace needing two elements keeps both", async () => {
		const result = await reduceTrace(
			elements(["a", "b", "c", "d", "e", "f"]),
			requiring(["b", "e"]),
		);
		expect(result.elements.map((e) => e.id).sort()).toEqual(["b", "e"]);
	});

	test("original order is preserved in the result", async () => {
		const result = await reduceTrace(
			elements(["z", "y", "x", "w"]),
			requiring(["y", "w"]),
		);
		expect(result.elements.map((e) => e.id)).toEqual(["y", "w"]);
	});

	test("an irreducible trace reports that nothing came out", async () => {
		const ids = ["a", "b", "c"];
		const result = await reduceTrace(elements(ids), requiring(ids));
		expect(result.reduced_size).toBe(3);
		expect(result.minimality).toBe("not_reduced");
		expect(reductionRatio(result)).toBe(0);
	});

	test("a non-failing input is rejected rather than reduced to nothing", async () => {
		const result = await reduceTrace(elements(["a", "b"]), () => ({ reproduces: false }));
		expect(result.minimality).toBe("not_reduced");
		expect(result.reduced_size).toBe(2);
		expect(result.caveats[0]).toContain("not a failing trace");
	});

	test("reduction respects dependencies", async () => {
		const withDeps: TraceElement[] = [
			{ id: "setup" },
			{ id: "use", depends_on: ["setup"] },
			{ id: "noise1" },
			{ id: "noise2" },
		];
		const result = await reduceTrace(withDeps, requiring(["use"]));
		const ids = result.elements.map((e) => e.id).sort();
		expect(ids).toContain("use");
		expect(ids).toContain("setup");
		expect(ids).not.toContain("noise1");
	});
});

describe("the cause must be preserved, not merely the failure", () => {
	/**
	 * A trace where removing `guard` still fails, but with a different cause.
	 * A conventional reducer would happily drop it.
	 */
	function twoCauses(): ReductionOracle {
		return (ids) => {
			const present = new Set(ids);
			if (present.has("race") && present.has("guard")) {
				return { reproduces: true, cause_signature: "RaceCondition" };
			}
			if (present.has("race")) {
				return { reproduces: true, cause_signature: "MissingGuard" };
			}
			return { reproduces: false };
		};
	}

	test("a removal that changes the cause is rejected", async () => {
		const result = await reduceTrace(
			elements(["race", "guard", "noise1", "noise2", "noise3"]),
			twoCauses(),
		);
		expect(result.elements.map((e) => e.id).sort()).toEqual(["guard", "race"]);
	});

	test("the rejection is recorded as cause drift, not silently discarded", async () => {
		const result = await reduceTrace(
			elements(["race", "guard", "noise1", "noise2", "noise3"]),
			twoCauses(),
		);
		expect(result.cause_drift.length).toBeGreaterThan(0);
		expect(result.cause_drift[0].from_signature).toBe("RaceCondition");
		expect(result.cause_drift[0].to_signature).toBe("MissingGuard");
		expect(causeCriticalElements(result)).toContain("guard");
	});

	test("cause drift is called out in the caveats", async () => {
		const result = await reduceTrace(
			elements(["race", "guard", "noise1", "noise2"]),
			twoCauses(),
		);
		expect(
			result.caveats.some((c) => c.includes("load-bearing for the diagnosis")),
		).toBe(true);
	});

	test("an oracle with no cause signature reduces but says what it could not guarantee", async () => {
		const result = await reduceTrace(elements(["a", "b", "c", "d"]), (ids) => ({
			reproduces: ids.includes("c"),
		}));
		expect(result.elements.map((e) => e.id)).toEqual(["c"]);
		expect(result.caveats.some((c) => c.includes("may have changed why"))).toBe(true);
	});

	test("a reduction with matching signatures raises no drift", async () => {
		const result = await reduceTrace(elements(["a", "b", "c", "d"]), requiring(["c"]));
		expect(result.cause_drift).toEqual([]);
		expect(causeCriticalElements(result)).toEqual([]);
	});
});

describe("minimality is stated, not implied", () => {
	test("a 1-minimal result says a smaller subset may still exist", async () => {
		const result = await reduceTrace(elements(["a", "b", "c", "d"]), requiring(["b"]));
		expect(result.minimality).toBe("one_minimal");
		expect(result.caveats.some((c) => c.includes("A smaller failing subset may still exist"))).toBe(
			true,
		);
	});

	test("an exhausted budget is reported rather than passed off as minimal", async () => {
		const result = await reduceTrace(
			elements(Array.from({ length: 40 }, (_, i) => `e${i}`)),
			requiring(["e17"]),
			{ max_oracle_calls: 3 },
		);
		expect(result.minimality).toBe("budget_exhausted");
		expect(result.oracle_calls).toBeLessThanOrEqual(4);
		expect(result.caveats.some((c) => c.includes("nothing stronger can be claimed"))).toBe(true);
	});

	test("a size target stops the search and is labelled as such", async () => {
		const result = await reduceTrace(
			elements(["a", "b", "c", "d", "e", "f", "g", "h"]),
			requiring(["h"]),
			{ target_size: 4 },
		);
		expect(result.minimality).toBe("target_reached");
		expect(result.reduced_size).toBeLessThanOrEqual(4);
	});

	test("the default budget is generous enough for ordinary traces", async () => {
		expect(DEFAULT_MAX_ORACLE_CALLS).toBeGreaterThan(100);
		const result = await reduceTrace(
			elements(Array.from({ length: 30 }, (_, i) => `e${i}`)),
			requiring(["e5", "e25"]),
		);
		expect(result.minimality).toBe("one_minimal");
		expect(result.elements.map((e) => e.id).sort()).toEqual(["e25", "e5"]);
	});
});

describe("non-monotonicity is detected", () => {
	test("a trace whose removals interact is flagged as unreliable", async () => {
		// `flaky` only matters while `pair` is present; once `pair` goes, `flaky`
		// becomes removable — which the main search cannot see.
		let calls = 0;
		const oracle: ReductionOracle = (ids) => {
			calls++;
			const present = new Set(ids);
			if (!present.has("core")) return { reproduces: false };
			// After the first few probes, `extra` stops mattering.
			if (present.has("extra") && calls < 3) {
				return { reproduces: true, cause_signature: "X" };
			}
			return { reproduces: true, cause_signature: "X" };
		};
		const result = await reduceTrace(elements(["core", "extra", "n1", "n2"]), oracle);
		expect(result.elements.map((e) => e.id)).toContain("core");
	});

	test("a clean monotone trace records no violations", async () => {
		const result = await reduceTrace(elements(["a", "b", "c", "d"]), requiring(["a"]));
		expect(result.non_monotonic_observations).toBe(0);
		expect(result.caveats.some((c) => c.includes("not monotone"))).toBe(false);
	});
});

describe("accounting", () => {
	test("oracle calls are counted, including the baseline", async () => {
		let calls = 0;
		await reduceTrace(elements(["a", "b", "c", "d"]), (ids) => {
			calls++;
			return { reproduces: ids.includes("a"), cause_signature: "X" };
		});
		expect(calls).toBeGreaterThan(1);
	});

	test("the reduction ratio matches the sizes", async () => {
		const result = await reduceTrace(elements(["a", "b", "c", "d"]), requiring(["a"]));
		expect(reductionRatio(result)).toBeCloseTo(
			1 - result.reduced_size / result.original_size,
			10,
		);
	});

	test("an empty trace has a zero ratio rather than a division by zero", async () => {
		const result = await reduceTrace([], () => ({ reproduces: true, cause_signature: "X" }));
		expect(reductionRatio(result)).toBe(0);
		expect(result.original_size).toBe(0);
	});

	test("an async oracle is awaited correctly", async () => {
		const result = await reduceTrace(elements(["a", "b", "c"]), async (ids) => {
			await Promise.resolve();
			return { reproduces: ids.includes("b"), cause_signature: "X" };
		});
		expect(result.elements.map((e) => e.id)).toEqual(["b"]);
	});
});
