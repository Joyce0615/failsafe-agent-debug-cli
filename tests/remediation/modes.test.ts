import { describe, expect, test } from "bun:test";
import {
	CONTRAINDICATIONS,
	REMEDIATION_MODES,
	type RemediationContext,
	evaluateMode,
	recommend,
	renderRecommendation,
} from "../../src/remediation/modes.js";

function context(overrides: Partial<RemediationContext> = {}): RemediationContext {
	return {
		cause: "regression",
		previous_version: "1.2.3",
		previous_version_deployable: true,
		gating_flag: "new_checkout",
		flag_covers_failure: true,
		failure_is_transient: false,
		failure_is_localized: true,
		spare_capacity_fraction: 2,
		...overrides,
	};
}

describe("preconditions are verified, not assumed", () => {
	test("a rollback with no deployable previous version is refused", () => {
		const result = evaluateMode(
			"rollback",
			context({ previous_version_deployable: false }),
		);
		expect(result.applicable).toBe(false);
		expect(result.unmet).toContain("previous_version_deployable");
		expect(result.preconditions[1].detail).toContain("a longer outage, not a shorter one");
	});

	test("a rollback with no recorded previous version is refused", () => {
		const result = evaluateMode("rollback", context({ previous_version: undefined }));
		expect(result.unmet).toContain("previous_version_exists");
	});

	test("a flag that does not gate the failing path is refused", () => {
		const result = evaluateMode("feature_disable", context({ flag_covers_failure: false }));
		expect(result.applicable).toBe(false);
		expect(result.preconditions[1].detail).toContain("look like a remediation and change nothing");
	});

	test("a missing flag is refused", () => {
		expect(
			evaluateMode("feature_disable", context({ gating_flag: undefined })).unmet,
		).toContain("gating_flag_exists");
	});

	test("a retry against a non-transient failure is refused", () => {
		const result = evaluateMode("retry", context({ cause: "config_drift" }));
		expect(result.applicable).toBe(false);
		expect(result.preconditions[0].detail).toContain("spends budget and changes nothing");
	});

	test("a traffic shift with insufficient spare capacity is refused", () => {
		const result = evaluateMode(
			"traffic_shift",
			context({ spare_capacity_fraction: 0.4 }),
		);
		expect(result.applicable).toBe(false);
		expect(result.unmet).toContain("spare_capacity");
		expect(result.preconditions[1].detail).toContain("would overload it");
	});

	test("a traffic shift on a fleet-wide failure is refused", () => {
		expect(
			evaluateMode("traffic_shift", context({ failure_is_localized: false })).unmet,
		).toContain("failure_is_localized");
	});

	test("all preconditions met makes a mode applicable", () => {
		expect(evaluateMode("rollback", context()).applicable).toBe(true);
		expect(evaluateMode("feature_disable", context()).applicable).toBe(true);
		expect(
			evaluateMode("retry", context({ cause: "transient_dependency", failure_is_transient: true }))
				.applicable,
		).toBe(true);
	});
});

describe("contraindications are hard blocks", () => {
	test("retrying a resource exhaustion is blocked with the mechanism named", () => {
		const result = evaluateMode(
			"retry",
			context({ cause: "resource_exhaustion", failure_is_transient: true }),
		);
		expect(result.applicable).toBe(false);
		expect(result.contraindication).toContain("multiplies the load");
	});

	test("a contraindication short-circuits the precondition check", () => {
		// Evaluating them would invite someone to satisfy them.
		const result = evaluateMode(
			"retry",
			context({ cause: "resource_exhaustion", failure_is_transient: true }),
		);
		expect(result.preconditions).toEqual([]);
	});

	test("shifting traffic under a capacity failure is blocked", () => {
		const result = evaluateMode("traffic_shift", context({ cause: "capacity" }));
		expect(result.applicable).toBe(false);
		expect(result.contraindication).toContain("relocates the overload");
	});

	test("rolling back data corruption is blocked", () => {
		const result = evaluateMode("rollback", context({ cause: "data_corruption" }));
		expect(result.applicable).toBe(false);
		expect(result.contraindication).toContain("does not un-write corrupt data");
	});

	test("retrying a deterministic regression is blocked even if marked transient", () => {
		const result = evaluateMode(
			"retry",
			context({ cause: "regression", failure_is_transient: true }),
		);
		expect(result.applicable).toBe(false);
	});

	test("every contraindication names a mechanism", () => {
		for (const entry of CONTRAINDICATIONS) {
			expect(entry.mechanism.length).toBeGreaterThan(20);
			expect(REMEDIATION_MODES).toContain(entry.mode);
		}
	});
});

describe("a mitigation is not a fix", () => {
	test("every mode carries residual work", () => {
		for (const mode of REMEDIATION_MODES) {
			const result = evaluateMode(
				mode,
				context({ cause: "transient_dependency", failure_is_transient: true }),
			);
			expect(result.residual_work.length).toBeGreaterThan(0);
		}
	});

	test("rollback says the defect is still in the codebase", () => {
		expect(evaluateMode("rollback", context()).residual_work[0]).toContain(
			"still in the codebase",
		);
	});

	test("feature disable says it is off for users it worked for", () => {
		expect(evaluateMode("feature_disable", context()).residual_work[0]).toContain(
			"including those it was working for",
		);
	});

	test("retry says it hides the failure rate", () => {
		const result = evaluateMode(
			"retry",
			context({ cause: "transient_dependency", failure_is_transient: true }),
		);
		expect(result.residual_work.some((r) => r.includes("hide the failure rate"))).toBe(true);
	});

	test("traffic shift says the failing partition is now unobserved", () => {
		expect(
			evaluateMode("traffic_shift", context()).residual_work[0],
		).toContain("unobserved by real traffic");
	});
});

describe("ranking is a trade-off, not a score", () => {
	test("reversible modes are ranked ahead of lossy ones", () => {
		const result = recommend(context({ rollback_loses_writes: true }));
		const rollbackIndex = result.recommended.findIndex((r) => r.mode === "rollback");
		const flagIndex = result.recommended.findIndex((r) => r.mode === "feature_disable");
		expect(flagIndex).toBeLessThan(rollbackIndex);
	});

	test("among equally reversible modes the faster wins", () => {
		const result = recommend(context());
		const times = result.recommended.map((r) => r.time_to_effect_ms);
		expect(times).toEqual([...times].sort((a, b) => a - b));
	});

	test("a lossy mode is called out as a trade-off rather than defaulted away", () => {
		const result = recommend(context({ rollback_loses_writes: true }));
		expect(result.caveats.some((c) => c.includes("a trade-off, not a default"))).toBe(true);
	});

	test("rejections carry the reason, distinguishing blocks from unmet preconditions", () => {
		const result = recommend(context({ cause: "resource_exhaustion" }));
		const retry = result.rejected.find((r) => r.mode === "retry")!;
		expect(retry.reason).toContain("contraindicated");
		const shift = result.rejected.find((r) => r.mode === "traffic_shift");
		if (shift) expect(shift.reason).toMatch(/contraindicated|preconditions unmet/);
	});

	test("the mitigation caveat is always present", () => {
		expect(recommend(context()).caveats[0]).toContain("none of them fixes a defect");
	});

	test("an unknown cause is called out as unable to be contraindication-checked", () => {
		expect(
			recommend(context({ cause: "unknown" })).caveats.some((c) =>
				c.includes("can make it worse"),
			),
		).toBe(true);
	});

	test("no applicable mode distinguishes 'unmet' from 'incomplete context'", () => {
		const result = recommend({ cause: "data_corruption" });
		expect(result.recommended).toEqual([]);
		expect(result.caveats.some((c) => c.includes("worth telling apart"))).toBe(true);
	});

	test("all four modes are always evaluated, even when rejected", () => {
		const result = recommend({ cause: "unknown" });
		expect(result.evaluations.map((e) => e.mode).sort()).toEqual([...REMEDIATION_MODES].sort());
	});
});

describe("rendering", () => {
	test("residual work is printed under every recommendation", () => {
		const text = renderRecommendation(recommend(context()));
		expect(text).toContain("still outstanding:");
		expect(text.split("still outstanding:").length - 1).toBeGreaterThan(1);
	});

	test("ruled-out modes are shown with their reason", () => {
		const text = renderRecommendation(recommend(context({ cause: "resource_exhaustion" })));
		expect(text).toContain("RULED OUT retry");
		expect(text).toContain("multiplies the load");
	});

	test("an empty recommendation still renders its caveats", () => {
		const text = renderRecommendation(recommend({ cause: "data_corruption" }));
		expect(text).toContain("note:");
	});
});
