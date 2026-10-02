import { describe, expect, test } from "bun:test";
import {
	DEFAULT_GATES,
	GATE_METRICS,
	GATE_RESULTS,
	WORSE_DIRECTION,
	evaluateGate,
	exitCodeFor,
	runGates,
} from "../../src/ci/regression-gates.js";

/** A stable series around `centre` with small deterministic jitter. */
function stable(centre: number, n = 10, jitter = 0.01): number[] {
	return Array.from({ length: n }, (_, i) => centre * (1 + ((i % 3) - 1) * jitter));
}

/** A noisy series around `centre`. */
function noisy(centre: number, n = 10, spread = 0.4): number[] {
	return Array.from({ length: n }, (_, i) => centre * (1 + ((i % 5) - 2) * spread));
}

describe("direction is per metric", () => {
	test("accuracy regresses downwards while everything else regresses upwards", () => {
		expect(WORSE_DIRECTION.diagnosis_accuracy).toBe("lower");
		expect(WORSE_DIRECTION.latency_ms).toBe("higher");
		expect(WORSE_DIRECTION.query_cost).toBe("higher");
	});

	test("a drop in accuracy is a regression, not an improvement", () => {
		const result = evaluateGate("diagnosis_accuracy", stable(0.9, 30), stable(0.75, 30));
		expect(result.result).toBe("regression");
		expect(result.blocking).toBe(true);
	});

	test("a rise in accuracy is an improvement", () => {
		expect(evaluateGate("diagnosis_accuracy", stable(0.75, 30), stable(0.9, 30)).result).toBe(
			"improvement",
		);
	});

	test("a drop in latency is an improvement", () => {
		expect(evaluateGate("latency_ms", stable(1000), stable(500)).result).toBe("improvement");
	});

	test("quality gates block and performance gates warn", () => {
		expect(DEFAULT_GATES.diagnosis_accuracy.severity).toBe("blocking");
		expect(DEFAULT_GATES.latency_ms.severity).toBe("warning");
	});
});

describe("a single run is not a measurement", () => {
	test("too few samples yields insufficient_samples, not a pass", () => {
		const result = evaluateGate("latency_ms", [1000], [3000]);
		expect(result.result).toBe("insufficient_samples");
		expect(result.samples_needed).toBe(DEFAULT_GATES.latency_ms.min_samples);
		expect(result.blocking).toBe(false);
	});

	test("the requirement applies to the candidate side too", () => {
		expect(evaluateGate("latency_ms", stable(1000), [3000]).result).toBe("insufficient_samples");
	});

	test("quality gates demand more samples than performance gates", () => {
		expect(DEFAULT_GATES.diagnosis_accuracy.min_samples).toBeGreaterThan(
			DEFAULT_GATES.latency_ms.min_samples,
		);
	});
});

describe("noise is distinguished from change", () => {
	test("a large move against a stable baseline is a regression", () => {
		const result = evaluateGate("latency_ms", stable(1000), stable(1500));
		expect(result.result).toBe("regression");
		expect(result.sigma_change).not.toBeNull();
		expect(result.detail).toContain("clearing both");
	});

	test("the same move against a noisy baseline is within_noise, not a pass", () => {
		const result = evaluateGate("latency_ms", noisy(1000), noisy(1150));
		expect(result.result).toBe("within_noise");
		expect(result.detail).toContain("cannot tell a real change from noise");
	});

	test("within_noise says how many samples would settle it", () => {
		const result = evaluateGate("latency_ms", noisy(1000), noisy(1150));
		expect(result.samples_needed).toBeGreaterThan(DEFAULT_GATES.latency_ms.min_samples);
	});

	test("a statistically clear but trivially small move passes", () => {
		// Extremely stable baseline; a 1% move is many sigma and does not matter.
		const result = evaluateGate("latency_ms", stable(1000, 10, 0.0001), stable(1010, 10, 0.0001));
		expect(result.result).toBe("pass");
		expect(result.detail).toContain("below the");
	});

	test("an unchanged metric passes", () => {
		const result = evaluateGate("latency_ms", stable(1000), stable(1000));
		expect(result.result).toBe("pass");
		expect(Math.abs(result.relative_change)).toBeLessThan(0.01);
	});

	test("a perfectly flat baseline falls back to the relative threshold", () => {
		const flat = Array.from({ length: 10 }, () => 1000);
		const result = evaluateGate("latency_ms", flat, Array.from({ length: 10 }, () => 1500));
		expect(result.baseline_stddev).toBe(0);
		expect(result.sigma_change).toBeNull();
		expect(result.result).toBe("regression");
	});

	test("every result is a declared member of the vocabulary", () => {
		for (const metric of GATE_METRICS) {
			expect(GATE_RESULTS).toContain(evaluateGate(metric, stable(1), stable(1)).result);
		}
	});
});

describe("a missing baseline is not a pass", () => {
	test("no baseline yields its own result with an explanation", () => {
		const result = evaluateGate("latency_ms", [], stable(1000));
		expect(result.result).toBe("no_baseline");
		expect(result.detail).toContain("stays green indefinitely");
		expect(result.blocking).toBe(false);
	});

	test("no baseline does not count as clean in the report", () => {
		const report = runGates({}, { latency_ms: stable(1000) });
		expect(report.clean).toBe(false);
		expect(report.unjudged[0].result).toBe("no_baseline");
	});
});

describe("the report", () => {
	test("blocking and warning regressions are separated", () => {
		const report = runGates(
			{ latency_ms: stable(1000), diagnosis_accuracy: stable(0.9, 30) },
			{ latency_ms: stable(1500), diagnosis_accuracy: stable(0.7, 30) },
		);
		expect(report.blocking_regressions).toEqual(["diagnosis_accuracy"]);
		expect(report.warning_regressions).toEqual(["latency_ms"]);
		expect(report.clean).toBe(false);
	});

	test("improvements are listed and do not spoil cleanliness", () => {
		const report = runGates({ latency_ms: stable(1000) }, { latency_ms: stable(500) });
		expect(report.improvements).toEqual(["latency_ms"]);
		expect(report.clean).toBe(true);
	});

	test("metrics with no samples at all are named as ungated", () => {
		const report = runGates({ latency_ms: stable(1000) }, { latency_ms: stable(1000) });
		expect(report.caveats.some((c) => c.includes("would not have been noticed"))).toBe(true);
	});

	test("a run with unjudged metrics is not clean, whatever the passing ones say", () => {
		const report = runGates(
			{ latency_ms: stable(1000), query_cost: [] },
			{ latency_ms: stable(1000), query_cost: stable(5) },
		);
		expect(report.evaluations.some((e) => e.result === "pass")).toBe(true);
		expect(report.clean).toBe(false);
		expect(report.caveats.some((c) => c.includes("is not a clean run"))).toBe(true);
	});

	test("a within_noise result is called out in the caveats", () => {
		const report = runGates({ latency_ms: noisy(1000) }, { latency_ms: noisy(1150) });
		expect(report.caveats.some((c) => c.includes("may well be real"))).toBe(true);
	});

	test("a fully clean run has no unjudged metrics and no caveats about them", () => {
		const samples = Object.fromEntries(
			GATE_METRICS.map((m) => [m, stable(m === "diagnosis_accuracy" ? 0.9 : 100, 30)]),
		);
		const report = runGates(samples, samples);
		expect(report.clean).toBe(true);
		expect(report.unjudged).toEqual([]);
	});

	test("custom configs override the defaults", () => {
		const strict = runGates(
			{ latency_ms: stable(1000) },
			{ latency_ms: stable(1030) },
			{
				latency_ms: {
					...DEFAULT_GATES.latency_ms,
					min_relative_change: 0.01,
					sigma_threshold: 1,
					severity: "blocking",
				},
			},
		);
		expect(strict.blocking_regressions).toEqual(["latency_ms"]);
	});
});

describe("exit codes distinguish 'did not regress' from 'cannot tell'", () => {
	test("a clean run exits zero", () => {
		expect(exitCodeFor(runGates({ latency_ms: stable(1000) }, { latency_ms: stable(1000) }))).toBe(
			0,
		);
	});

	test("a blocking regression exits one", () => {
		expect(
			exitCodeFor(
				runGates({ diagnosis_accuracy: stable(0.9, 30) }, { diagnosis_accuracy: stable(0.7, 30) }),
			),
		).toBe(1);
	});

	test("an unjudged run exits two, not zero", () => {
		expect(exitCodeFor(runGates({}, { latency_ms: stable(1000) }))).toBe(2);
	});

	test("a blocking regression outranks an unjudged metric", () => {
		const report = runGates(
			{ diagnosis_accuracy: stable(0.9, 30) },
			{ diagnosis_accuracy: stable(0.7, 30), latency_ms: stable(1000) },
		);
		expect(exitCodeFor(report)).toBe(1);
	});
});
