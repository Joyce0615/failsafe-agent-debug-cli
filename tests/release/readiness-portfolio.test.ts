import { describe, expect, test } from "bun:test";
import {
	type ReadinessInputs,
	publishReleaseReadinessPortfolio,
	renderReadinessPortfolio,
	verifyReadinessSignature,
} from "../../src/release/readiness-portfolio.js";

function baseInputs(): ReadinessInputs {
	return {
		project: "failsafe-agent-debug-cli",
		version: "1.2.3",
		built_at_ms: 1000,
		telemetry_fidelity: {
			spans_examined: 100,
			findings: [],
			by_category: {},
			confirmed_absence_count: 0,
			unknown_evidence_count: 0,
		},
		attribution: { refused_reason: "only 5 observations; at least 20 are needed" } as never,
		reproducer_quality: {
			verdict: "causal",
			repeats: 3,
			arms: [],
			mutation_safety: { safe: true, reasons: [] },
			summary: "ok",
		},
		recovery_safety: {
			baseline_runs: [],
			canary_runs: [],
			baseline_pass_rate: 1,
			canary_pass_rate: 1,
			metric_comparisons: [],
			verdict: "promote",
			reasons: ["canary matched baseline"],
		},
		privacy_budget: { epsilon_total: 1, epsilon_spent: 0.2 },
		advisory_exposure: {
			assessments: [],
			attribution: { attributed: false, reason: "no evidence" },
			recoveries: [],
		},
		drift: { by_dimension: {} as never, regressed_dimensions: [] },
	};
}

describe("publishReleaseReadinessPortfolio", () => {
	test("promotes when every dimension is clean", () => {
		const result = publishReleaseReadinessPortfolio(baseInputs(), "signing-key");
		expect(result.verdict).toBe("promote");
		expect(result.portfolio.signature.length).toBeGreaterThan(0);
	});

	test("holds when telemetry has unexplained gaps, never silently promoting", () => {
		const inputs = baseInputs();
		inputs.telemetry_fidelity = {
			spans_examined: 10,
			findings: [
				{ category: "missing_span", detail: "span never arrived", evidence: "unknown_evidence" },
			],
			by_category: { missing_span: 1 },
			confirmed_absence_count: 0,
			unknown_evidence_count: 1,
		};
		const result = publishReleaseReadinessPortfolio(inputs, "signing-key");
		expect(result.verdict).toBe("hold");
		expect(result.reasons.some((r) => r.includes("telemetry"))).toBe(true);
	});

	test("rolls back when the recovery-safety canary itself says rollback", () => {
		const inputs = baseInputs();
		inputs.recovery_safety = {
			...inputs.recovery_safety,
			verdict: "rollback",
			reasons: ["canary pass rate worse than baseline"],
		};
		const result = publishReleaseReadinessPortfolio(inputs, "signing-key");
		expect(result.verdict).toBe("rollback");
	});

	test("rollback outranks hold: a rollback-worthy canary is never downgraded to a hold by an unrelated gap", () => {
		const inputs = baseInputs();
		inputs.recovery_safety = {
			...inputs.recovery_safety,
			verdict: "rollback",
			reasons: ["canary pass rate worse than baseline"],
		};
		inputs.telemetry_fidelity = {
			spans_examined: 10,
			findings: [
				{ category: "missing_span", detail: "span never arrived", evidence: "unknown_evidence" },
			],
			by_category: { missing_span: 1 },
			confirmed_absence_count: 0,
			unknown_evidence_count: 1,
		};
		const result = publishReleaseReadinessPortfolio(inputs, "signing-key");
		expect(result.verdict).toBe("rollback");
	});

	test("holds when any advisory is exploitable, never promoting a known-exploitable release", () => {
		const inputs = baseInputs();
		inputs.advisory_exposure = {
			assessments: [
				{
					advisory: {
						id: "ADV-1",
						package: "left-pad",
						affected_versions: ["1.2.0"],
						patched_version: "1.3.0",
						attack_vector: "network",
						summary: "left-pad has a bug",
					},
					status: "exploitable",
					matched_components: [],
					rationale: "reachable over the network",
				},
			],
			attribution: { attributed: false, reason: "no evidence" },
			recoveries: [],
		};
		const result = publishReleaseReadinessPortfolio(inputs, "signing-key");
		expect(result.verdict).toBe("hold");
		expect(result.reasons.some((r) => r.includes("advisor"))).toBe(true);
	});

	test("holds when a drift dimension regressed", () => {
		const inputs = baseInputs();
		inputs.drift = {
			by_dimension: {} as never,
			regressed_dimensions: ["cost"],
		};
		const result = publishReleaseReadinessPortfolio(inputs, "signing-key");
		expect(result.verdict).toBe("hold");
		expect(result.reasons.some((r) => r.includes("drift"))).toBe(true);
	});

	test("the published portfolio's signature verifies against the same key, and fails against a different one", () => {
		const result = publishReleaseReadinessPortfolio(baseInputs(), "signing-key");
		expect(verifyReadinessSignature(result.portfolio, "signing-key")).toBe(true);
		expect(verifyReadinessSignature(result.portfolio, "wrong-key")).toBe(false);
	});
});

describe("renderReadinessPortfolio", () => {
	test("renders the verdict and every reason", () => {
		const result = publishReleaseReadinessPortfolio(baseInputs(), "signing-key");
		const rendered = renderReadinessPortfolio(result);
		expect(rendered).toContain("promote");
		for (const reason of result.reasons) {
			expect(rendered).toContain(reason);
		}
	});
});
