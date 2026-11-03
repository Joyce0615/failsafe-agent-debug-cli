import { describe, expect, test } from "bun:test";
import {
	type CanaryRun,
	type CanaryRunner,
	type MetricTolerance,
	MIN_CANARY_REPEATS,
	requestCanaryPromotion,
	runCanaryTrial,
} from "../../src/remediation/canary.js";
import type { ApprovalGrant, RemediationAction } from "../../src/remediation/approval.js";
import { APPROVAL_KEY_ENV, grantApproval } from "../../src/remediation/approval.js";

function scripted(
	baselineOutcomes: Array<CanaryRun["outcome"]>,
	canaryOutcomes: Array<CanaryRun["outcome"]>,
	metrics: { baseline?: Record<string, number>[]; canary?: Record<string, number>[] } = {},
): CanaryRunner {
	return (arm, attempt) => {
		const outcomes = arm === "baseline" ? baselineOutcomes : canaryOutcomes;
		const metricList = arm === "baseline" ? metrics.baseline : metrics.canary;
		return {
			outcome: outcomes[attempt - 1] ?? "error",
			metrics: metricList?.[attempt - 1],
		};
	};
}

describe("runCanaryTrial", () => {
	test("fewer than MIN_CANARY_REPEATS repeats holds rather than verdicts", async () => {
		const runner = scripted(["pass", "pass"], ["pass", "pass"]);
		const report = await runCanaryTrial(runner, [], 2);
		expect(report.verdict).toBe("hold");
		expect(report.reasons.some((r) => r.includes("repeat"))).toBe(true);
	});

	test("a harness error in either arm holds rather than guessing a verdict", async () => {
		const runner = scripted(["pass", "pass", "pass"], ["pass", "error", "pass"]);
		const report = await runCanaryTrial(runner, [], MIN_CANARY_REPEATS);
		expect(report.verdict).toBe("hold");
		expect(report.reasons.some((r) => r.includes("error"))).toBe(true);
	});

	test("a canary pass rate equal to baseline, with all metrics in tolerance, promotes", async () => {
		const runner = scripted(
			["pass", "pass", "pass"],
			["pass", "pass", "pass"],
			{
				baseline: [{ latency_ms: 100 }, { latency_ms: 100 }, { latency_ms: 100 }],
				canary: [{ latency_ms: 105 }, { latency_ms: 105 }, { latency_ms: 105 }],
			},
		);
		const tolerances: MetricTolerance[] = [
			{ name: "latency_ms", direction: "lower_is_better", max_regression: 0.1 },
		];
		const report = await runCanaryTrial(runner, tolerances, MIN_CANARY_REPEATS);
		expect(report.verdict).toBe("promote");
	});

	test("a canary pass rate worse than baseline rolls back", async () => {
		const runner = scripted(["pass", "pass", "pass"], ["pass", "fail", "fail"]);
		const report = await runCanaryTrial(runner, [], MIN_CANARY_REPEATS);
		expect(report.verdict).toBe("rollback");
		expect(report.reasons.some((r) => r.includes("pass rate"))).toBe(true);
	});

	test("a side-effect metric regressing beyond tolerance rolls back even with an equal pass rate", async () => {
		const runner = scripted(
			["pass", "pass", "pass"],
			["pass", "pass", "pass"],
			{
				baseline: [{ latency_ms: 100 }, { latency_ms: 100 }, { latency_ms: 100 }],
				canary: [{ latency_ms: 200 }, { latency_ms: 200 }, { latency_ms: 200 }],
			},
		);
		const tolerances: MetricTolerance[] = [
			{ name: "latency_ms", direction: "lower_is_better", max_regression: 0.1 },
		];
		const report = await runCanaryTrial(runner, tolerances, MIN_CANARY_REPEATS);
		expect(report.verdict).toBe("rollback");
		expect(report.metric_comparisons[0].within_tolerance).toBe(false);
	});
});

describe("requestCanaryPromotion", () => {
	const action: RemediationAction = {
		mode: "promote_canary_fix",
		target: "svc-a",
		parameters: {},
		reversible: true,
		blast_radius: 0.1,
		requested_by: "alice",
	};

	test("refuses outright when the verdict is not 'promote', without even consulting the approval gate", async () => {
		const runner = scripted(["pass", "pass", "pass"], ["pass", "fail", "fail"]);
		const report = await runCanaryTrial(runner, [], MIN_CANARY_REPEATS);
		const result = requestCanaryPromotion(report, action, undefined);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("verdict");
	});

	test("a 'promote' verdict still requires passing the item-77 approval gate", async () => {
		process.env[APPROVAL_KEY_ENV] = "test-canary-key";
		const runner = scripted(["pass", "pass", "pass"], ["pass", "pass", "pass"]);
		const report = await runCanaryTrial(runner, [], MIN_CANARY_REPEATS);
		expect(report.verdict).toBe("promote");

		// No grant at all: refused by the approval gate, not silently allowed.
		const noGrant = requestCanaryPromotion(report, action, undefined);
		expect(noGrant.ok).toBe(false);

		const grantResult = grantApproval(action, "bob", { now_ms: 1000 });
		expect(grantResult.ok).toBe(true);
		const grant = (grantResult as { ok: true; grant: ApprovalGrant }).grant;
		const approved = requestCanaryPromotion(report, action, grant, { now_ms: 1000 });
		expect(approved.ok).toBe(true);
		delete process.env[APPROVAL_KEY_ENV];
	});
});
