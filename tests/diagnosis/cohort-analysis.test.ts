import { describe, expect, test } from "bun:test";
import {
	COHORT_DIMENSIONS,
	type CohortSample,
	MIN_CELL_SIZE,
	analyzeCohorts,
	stratify,
	suspectedConfounders,
	twoProportionP,
} from "../../src/diagnosis/cohort-analysis.js";

let counter = 0;
function samples(
	labels: CohortSample["labels"],
	total: number,
	failures: number,
): CohortSample[] {
	return Array.from({ length: total }, (_, i) => ({
		id: `s${counter++}`,
		failed: i < failures,
		labels,
	}));
}

describe("the two-proportion test", () => {
	test("a large clear difference is highly significant", () => {
		const p = twoProportionP(90, 100, 10, 100);
		expect(p).not.toBeNull();
		expect(p!).toBeLessThan(0.001);
	});

	test("identical rates give a p-value near one", () => {
		const p = twoProportionP(50, 100, 50, 100);
		expect(p!).toBeGreaterThan(0.9);
	});

	test("too few expected events returns null rather than an invalid number", () => {
		expect(twoProportionP(1, 10, 0, 10)).toBeNull();
		expect(twoProportionP(0, 5, 0, 5)).toBeNull();
	});

	test("an empty arm returns null", () => {
		expect(twoProportionP(0, 0, 5, 100)).toBeNull();
	});

	test("the test is symmetric in its arms", () => {
		expect(twoProportionP(80, 200, 40, 200)).toBeCloseTo(
			twoProportionP(40, 200, 80, 200)!,
			10,
		);
	});
});

describe("small cells are refused, not guessed at", () => {
	test("a tiny cohort is reported as untested with a reason", () => {
		const population = [
			...samples({ tenant: "big" }, 500, 25),
			...samples({ tenant: "tiny" }, 3, 2),
		];
		const report = analyzeCohorts(population);
		const untested = report.untested.find((u) => u.value === "tiny")!;
		expect(untested.reason).toContain(String(MIN_CELL_SIZE));
		expect(report.findings.some((f) => f.value === "tiny")).toBe(false);
	});

	test("the report distinguishes not-looked-at from nothing-wrong", () => {
		const population = [
			...samples({ tenant: "big" }, 500, 25),
			...samples({ tenant: "tiny" }, 3, 2),
		];
		expect(
			analyzeCohorts(population).caveats.some((c) => c.includes("not looked at")),
		).toBe(true);
	});

	test("the minimum cell size is configurable", () => {
		const population = [
			...samples({ region: "a" }, 40, 20),
			...samples({ region: "b" }, 40, 4),
		];
		expect(analyzeCohorts(population, { min_cell: 100 }).findings).toEqual([]);
		expect(analyzeCohorts(population, { min_cell: 10 }).findings.length).toBeGreaterThan(0);
	});
});

describe("multiple comparisons are controlled", () => {
	test("a healthy system with many cohorts yields no significant finding", () => {
		// Fifty tenants, all at the same 10% rate.
		const population = Array.from({ length: 50 }, (_, i) =>
			samples({ tenant: `t${i}` }, 100, 10),
		).flat();
		const report = analyzeCohorts(population);
		expect(report.comparisons).toBe(50);
		expect(report.findings.filter((f) => f.significant)).toEqual([]);
	});

	test("a genuinely broken cohort is still found among many", () => {
		const population = [
			...Array.from({ length: 30 }, (_, i) => samples({ tenant: `t${i}` }, 200, 20)).flat(),
			...samples({ tenant: "broken" }, 200, 160),
		];
		const report = analyzeCohorts(population);
		const broken = report.findings.find((f) => f.value === "broken")!;
		expect(broken.significant).toBe(true);
		expect(broken.risk_difference).toBeGreaterThan(0.5);
	});

	test("the number of comparisons and the procedure used are stated", () => {
		const population = Array.from({ length: 10 }, (_, i) =>
			samples({ tenant: `t${i}` }, 100, 10),
		).flat();
		const report = analyzeCohorts(population);
		expect(report.caveats.some((c) => c.includes("Benjamini–Hochberg"))).toBe(true);
		expect(report.comparisons).toBe(10);
	});

	test("significant findings are listed before non-significant ones", () => {
		const population = [
			...samples({ region: "healthy" }, 400, 40),
			...samples({ region: "broken" }, 400, 300),
		];
		const report = analyzeCohorts(population);
		expect(report.findings[0].significant).toBe(true);
	});
});

describe("effect size travels with significance", () => {
	test("a tiny but significant effect is called out as tiny", () => {
		const population = [
			...samples({ region: "a" }, 200_000, 20_000),
			...samples({ region: "b" }, 200_000, 21_000),
		];
		const report = analyzeCohorts(population);
		const finding = report.findings.find((f) => f.value === "b")!;
		expect(finding.significant).toBe(true);
		expect(Math.abs(finding.risk_difference)).toBeLessThan(0.01);
		expect(report.caveats.some((c) => c.includes("significance is cheap"))).toBe(true);
	});

	test("a protective cohort is a real, signed result", () => {
		const population = [
			...samples({ feature_flag: "off" }, 500, 250),
			...samples({ feature_flag: "on" }, 500, 50),
		];
		const finding = analyzeCohorts(population).findings.find((f) => f.value === "on")!;
		expect(finding.risk_difference).toBeLessThan(0);
		expect(finding.risk_ratio!).toBeLessThan(1);
	});

	test("a zero comparison rate yields a null ratio rather than infinity", () => {
		const population = [
			...samples({ region: "clean" }, 200, 0),
			...samples({ region: "dirty" }, 200, 100),
		];
		const clean = analyzeCohorts(population).findings.find((f) => f.value === "clean")!;
		expect(clean.risk_ratio).toBe(0);
		const dirty = analyzeCohorts(population).findings.find((f) => f.value === "dirty")!;
		expect(dirty.risk_ratio).toBeNull();
	});
});

describe("Simpson's paradox", () => {
	/**
	 * A flag rolled out first in an already-unhealthy region. The flag looks
	 * harmful overall and is harmless — in fact slightly protective — within
	 * each region.
	 */
	function stagedRollout(): CohortSample[] {
		return [
			// Unhealthy region: mostly flagged.
			...samples({ feature_flag: "on", region: "eu" }, 400, 200),
			...samples({ feature_flag: "off", region: "eu" }, 100, 52),
			// Healthy region: mostly unflagged.
			...samples({ feature_flag: "on", region: "us" }, 100, 8),
			...samples({ feature_flag: "off", region: "us" }, 400, 36),
		];
	}

	test("the crude comparison finds the flag harmful", () => {
		const report = analyzeCohorts(stagedRollout());
		const flagOn = report.findings.find(
			(f) => f.dimension === "feature_flag" && f.value === "on",
		)!;
		expect(flagOn.risk_difference).toBeGreaterThan(0);
	});

	test("stratifying by region reverses or removes the effect", () => {
		const result = stratify(stagedRollout(), "feature_flag", "on", "region");
		expect(["reversed", "explained_away"]).toContain(result.verdict);
		expect(Math.abs(result.adjusted_risk_difference)).toBeLessThan(
			Math.abs(result.crude_risk_difference),
		);
	});

	test("the detail names the confounder as the source of the association", () => {
		const result = stratify(stagedRollout(), "feature_flag", "on", "region");
		expect(result.detail).toContain("region");
	});

	test("a genuine effect survives stratification", () => {
		const population = [
			...samples({ feature_flag: "on", region: "eu" }, 300, 150),
			...samples({ feature_flag: "off", region: "eu" }, 300, 30),
			...samples({ feature_flag: "on", region: "us" }, 300, 150),
			...samples({ feature_flag: "off", region: "us" }, 300, 30),
		];
		const result = stratify(population, "feature_flag", "on", "region");
		expect(result.verdict).toBe("confirmed");
		expect(result.detail).toContain("survives stratification");
	});

	test("strata too small to test yield an untestable verdict, not a false all-clear", () => {
		const population = [
			...samples({ feature_flag: "on", region: "eu" }, 5, 3),
		];
		const result = stratify(population, "feature_flag", "on", "region");
		expect(result.verdict).toBe("untestable");
		expect(result.detail).toContain("cannot be ruled out or confirmed");
	});

	test("each stratum reports whether it was tested", () => {
		const result = stratify(stagedRollout(), "feature_flag", "on", "region");
		expect(result.strata.every((s) => typeof s.tested === "boolean")).toBe(true);
		expect(result.strata.map((s) => s.level).sort()).toEqual(["eu", "us"]);
	});
});

describe("suspected confounders", () => {
	test("a staged rollout produces a strong association with its cohort", () => {
		const population = [
			...samples({ feature_flag: "on", region: "eu" }, 400, 100),
			...samples({ feature_flag: "off", region: "us" }, 400, 100),
		];
		const suspects = suspectedConfounders(population, "feature_flag", "on");
		expect(suspects[0].confounder).toBe("region");
		expect(suspects[0].association).toBeGreaterThan(0.9);
	});

	test("an evenly distributed dimension is not flagged", () => {
		const population = [
			...samples({ feature_flag: "on", region: "eu" }, 200, 20),
			...samples({ feature_flag: "on", region: "us" }, 200, 20),
			...samples({ feature_flag: "off", region: "eu" }, 200, 20),
			...samples({ feature_flag: "off", region: "us" }, 200, 20),
		];
		expect(suspectedConfounders(population, "feature_flag", "on")).toEqual([]);
	});

	test("a dimension with one level cannot confound anything", () => {
		const population = [
			...samples({ feature_flag: "on", region: "eu" }, 200, 20),
			...samples({ feature_flag: "off", region: "eu" }, 200, 20),
		];
		expect(suspectedConfounders(population, "feature_flag", "on")).toEqual([]);
	});

	test("the dimension under test is never its own confounder", () => {
		const population = [
			...samples({ feature_flag: "on", region: "eu" }, 200, 20),
			...samples({ feature_flag: "off", region: "us" }, 200, 20),
		];
		expect(
			suspectedConfounders(population, "feature_flag", "on").some(
				(s) => s.confounder === "feature_flag",
			),
		).toBe(false);
	});
});

describe("report shape", () => {
	test("an empty population reports zeros without dividing by zero", () => {
		const report = analyzeCohorts([]);
		expect(report.samples).toBe(0);
		expect(report.overall_rate).toBe(0);
		expect(report.findings).toEqual([]);
		expect(report.comparisons).toBe(0);
	});

	test("unlabelled dimensions are skipped entirely", () => {
		const report = analyzeCohorts(samples({ region: "a" }, 100, 10));
		expect(report.findings.every((f) => f.dimension === "region")).toBe(true);
		expect(COHORT_DIMENSIONS.length).toBeGreaterThan(1);
	});

	test("the overall rate is reported for context", () => {
		const report = analyzeCohorts([
			...samples({ region: "a" }, 100, 10),
			...samples({ region: "b" }, 100, 30),
		]);
		expect(report.overall_rate).toBeCloseTo(0.2, 5);
	});
});
