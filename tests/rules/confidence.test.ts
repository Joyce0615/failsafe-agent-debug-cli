import { describe, expect, test } from "bun:test";
import {
	LEARNED_FULL_WEIGHT_SAMPLES,
	calibrateConfidence,
	confidenceBand,
} from "../../src/rules/confidence.js";

describe("confidenceBand", () => {
	test("maps to high/medium/low at the documented thresholds", () => {
		expect(confidenceBand(0.95)).toBe("high");
		expect(confidenceBand(0.85)).toBe("high");
		expect(confidenceBand(0.84)).toBe("medium");
		expect(confidenceBand(0.6)).toBe("medium");
		expect(confidenceBand(0.59)).toBe("low");
		expect(confidenceBand(0)).toBe("low");
	});
});

describe("calibrateConfidence", () => {
	test("clamps raw values into [0,1] before applying ceilings", () => {
		expect(calibrateConfidence("declared", -1)).toBe(0);
		expect(calibrateConfidence("declared", 2)).toBe(0.98);
	});

	test("treats non-finite raw values as zero", () => {
		expect(calibrateConfidence("declared", Number.NaN)).toBe(0);
		expect(calibrateConfidence("builtin", Number.POSITIVE_INFINITY)).toBe(0);
	});

	test("applies per-tier ceilings reflecting evidence strength", () => {
		// A perfectly confident raw value is still capped at the tier ceiling.
		expect(calibrateConfidence("declared", 1)).toBe(0.98);
		expect(calibrateConfidence("builtin", 1)).toBe(0.95);
		// Learned at full sample weight is capped at its (lower) ceiling.
		expect(
			calibrateConfidence("learned", 1, { occurrenceCount: LEARNED_FULL_WEIGHT_SAMPLES }),
		).toBe(0.9);
	});

	test("declared/builtin pass through raw values below their ceilings", () => {
		expect(calibrateConfidence("declared", 0.7)).toBeCloseTo(0.7, 10);
		expect(calibrateConfidence("builtin", 0.5)).toBeCloseTo(0.5, 10);
	});

	test("learned rules are weighted by sample size", () => {
		// One observation gets 1/5 of its raw confidence.
		expect(calibrateConfidence("learned", 0.8, { occurrenceCount: 1 })).toBeCloseTo(0.16, 10);
		// Reaches full weight at LEARNED_FULL_WEIGHT_SAMPLES occurrences.
		expect(calibrateConfidence("learned", 0.8, { occurrenceCount: 5 })).toBeCloseTo(0.8, 10);
		// More occurrences do not exceed full weight.
		expect(calibrateConfidence("learned", 0.8, { occurrenceCount: 50 })).toBeCloseTo(0.8, 10);
	});

	test("learned defaults to a single sample when occurrence count is absent", () => {
		expect(calibrateConfidence("learned", 0.8)).toBeCloseTo(0.16, 10);
	});

	test("learned weighting never produces a value above the learned ceiling", () => {
		expect(calibrateConfidence("learned", 1, { occurrenceCount: 1000 })).toBe(0.9);
	});
});
