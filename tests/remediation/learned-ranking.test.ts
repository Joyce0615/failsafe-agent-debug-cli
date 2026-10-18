import { describe, expect, test } from "bun:test";
import { grantApproval } from "../../src/remediation/approval.js";
import {
	ACTIVATION_MODE,
	MIN_SAMPLES_FOR_RANKING,
	type RemediationOutcome,
	activatePolicy,
	canonicalPermissiveContext,
	computeModeStats,
	learnRankingPolicy,
	policyActivationAction,
	publishPolicyReport,
	rankWithLearnedPolicy,
	renderPolicyReport,
	wilsonLowerBound,
} from "../../src/remediation/learned-ranking.js";
import type { RemediationContext } from "../../src/remediation/modes.js";
import { evaluateMode, recommend } from "../../src/remediation/modes.js";

const KEY = "test-ranking-signing-key";
const NOW = 1_700_000_000_000;

function outcome(overrides: Partial<RemediationOutcome> = {}): RemediationOutcome {
	return {
		cause: "regression",
		mode: "rollback",
		succeeded: true,
		recurred: false,
		...overrides,
	};
}

function repeat<T>(n: number, make: () => T): T[] {
	return Array.from({ length: n }, make);
}

/** A permissive context in which every mode in `modes` is applicable. */
function permissiveContext(overrides: Partial<RemediationContext> = {}): RemediationContext {
	return {
		cause: "config_drift",
		failure_is_transient: true,
		previous_version: "1.2.3",
		previous_version_deployable: true,
		gating_flag: "flag",
		flag_covers_failure: true,
		spare_capacity_fraction: 2,
		failure_is_localized: true,
		...overrides,
	};
}

describe("wilsonLowerBound (item 97)", () => {
	test("is 0 for 0 samples", () => {
		expect(wilsonLowerBound(0, 0)).toBe(0);
	});

	test("is strictly below the raw rate whenever samples are finite and rate is not 0 or 1", () => {
		const bound = wilsonLowerBound(8, 10);
		expect(bound).toBeLessThan(0.8);
		expect(bound).toBeGreaterThan(0);
	});

	test("a small sample at 100% success is ranked below a large sample at a lower rate", () => {
		// This is the whole point of the Wilson bound over a raw rate: 1/1 "looks"
		// perfect but is barely evidence, while 40/45 is real evidence of a
		// slightly-less-than-perfect but trustworthy rate.
		const tiny = wilsonLowerBound(1, 1);
		const large = wilsonLowerBound(40, 45);
		expect(large).toBeGreaterThan(tiny);
	});

	test("converges toward the raw rate as samples grow, for a fixed rate", () => {
		const small = wilsonLowerBound(8, 10);
		const big = wilsonLowerBound(800, 1000);
		expect(Math.abs(big - 0.8)).toBeLessThan(Math.abs(small - 0.8));
	});

	test("never goes negative or above 1", () => {
		expect(wilsonLowerBound(0, 10)).toBeGreaterThanOrEqual(0);
		expect(wilsonLowerBound(10, 10)).toBeLessThanOrEqual(1);
	});
});

describe("computeModeStats (item 97)", () => {
	test("aggregates per (cause, mode) with correct rates", () => {
		const outcomes = [
			outcome({ cause: "regression", mode: "rollback", succeeded: true }),
			outcome({ cause: "regression", mode: "rollback", succeeded: true }),
			outcome({ cause: "regression", mode: "rollback", succeeded: false }),
			outcome({ cause: "regression", mode: "retry", succeeded: false }),
		];
		const stats = computeModeStats(outcomes);
		const rollback = stats.find((s) => s.cause === "regression" && s.mode === "rollback");
		const retry = stats.find((s) => s.cause === "regression" && s.mode === "retry");
		expect(rollback?.samples).toBe(3);
		expect(rollback?.success_rate).toBeCloseTo(2 / 3, 6);
		expect(retry?.samples).toBe(1);
		expect(retry?.success_rate).toBe(0);
	});

	test("tracks recurrence separately from success", () => {
		const outcomes = [
			outcome({ succeeded: true, recurred: true }),
			outcome({ succeeded: true, recurred: false }),
		];
		const stats = computeModeStats(outcomes);
		expect(stats[0].success_rate).toBe(1);
		expect(stats[0].recurrence_rate).toBe(0.5);
	});

	test("returns stats sorted by cause then mode, deterministically", () => {
		const outcomes = [
			outcome({ cause: "capacity", mode: "traffic_shift" }),
			outcome({ cause: "regression", mode: "rollback" }),
			outcome({ cause: "capacity", mode: "feature_disable" }),
		];
		const a = computeModeStats(outcomes);
		const b = computeModeStats([...outcomes].reverse());
		expect(a.map((s) => `${s.cause}|${s.mode}`)).toEqual(b.map((s) => `${s.cause}|${s.mode}`));
		expect(a.map((s) => `${s.cause}|${s.mode}`)).toEqual([
			"capacity|feature_disable",
			"capacity|traffic_shift",
			"regression|rollback",
		]);
	});

	test("empty input produces empty stats", () => {
		expect(computeModeStats([])).toEqual([]);
	});
});

describe("learnRankingPolicy always produces a draft (item 97)", () => {
	test("a freshly learned policy has status 'draft', regardless of evidence", () => {
		const outcomes = [
			...repeat(20, () => outcome({ cause: "regression", mode: "rollback", succeeded: true })),
			...repeat(20, () => outcome({ cause: "regression", mode: "retry", succeeded: false })),
		];
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		expect(policy.status).toBe("draft");
	});

	test("a cause with fewer than minSamples for every mode is published with an empty order", () => {
		const outcomes = repeat(3, () =>
			outcome({ cause: "data_corruption", mode: "rollback", succeeded: true }),
		);
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW, minSamples: 10 });
		const cause = policy.causes.find((c) => c.cause === "data_corruption");
		expect(cause?.order).toEqual([]);
		expect(cause?.insufficient_evidence).toContain("rollback");
	});

	test("a cause with only one mode clearing the threshold still has an empty order", () => {
		// Ranking requires at least two things to compare; "order" of one mode
		// is not a ranking decision.
		const outcomes = [
			...repeat(15, () => outcome({ cause: "regression", mode: "rollback", succeeded: true })),
			...repeat(3, () => outcome({ cause: "regression", mode: "retry", succeeded: false })),
		];
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW, minSamples: 10 });
		const cause = policy.causes.find((c) => c.cause === "regression");
		expect(cause?.order).toEqual([]);
		expect(cause?.stats.length).toBe(2);
	});

	test("a cause with two or more well-evidenced modes orders them by Wilson lower bound, best first", () => {
		const outcomes = [
			...repeat(15, () => outcome({ cause: "regression", mode: "rollback", succeeded: true })),
			...repeat(15, () =>
				outcome({ cause: "regression", mode: "feature_disable", succeeded: false }),
			),
		];
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW, minSamples: 10 });
		const cause = policy.causes.find((c) => c.cause === "regression");
		expect(cause?.order).toEqual(["rollback", "feature_disable"]);
	});

	test("ties in Wilson lower bound break deterministically by mode name", () => {
		const outcomes = [
			...repeat(10, () => outcome({ cause: "capacity", mode: "traffic_shift", succeeded: true })),
			...repeat(10, () => outcome({ cause: "capacity", mode: "feature_disable", succeeded: true })),
		];
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW, minSamples: 10 });
		const cause = policy.causes.find((c) => c.cause === "capacity");
		// Both are 10/10 -> identical Wilson bound -> alphabetical tiebreak.
		expect(cause?.order).toEqual(["feature_disable", "traffic_shift"]);
	});

	test("a cause with zero outcomes at all is omitted from the policy entirely", () => {
		const outcomes = repeat(20, () =>
			outcome({ cause: "regression", mode: "rollback", succeeded: true }),
		);
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		expect(policy.causes.some((c) => c.cause === "unknown")).toBe(false);
	});

	test("the policy id is a deterministic function of its content", () => {
		const outcomes = repeat(20, () =>
			outcome({ cause: "regression", mode: "rollback", succeeded: true }),
		);
		const a = learnRankingPolicy(outcomes, { now_ms: NOW });
		const b = learnRankingPolicy(outcomes, { now_ms: NOW });
		expect(a.id).toBe(b.id);
	});

	test("default minSamples is MIN_SAMPLES_FOR_RANKING", () => {
		const outcomes = [
			...repeat(MIN_SAMPLES_FOR_RANKING, () =>
				outcome({ cause: "regression", mode: "rollback", succeeded: true }),
			),
			...repeat(MIN_SAMPLES_FOR_RANKING, () =>
				outcome({ cause: "regression", mode: "retry", succeeded: false }),
			),
		];
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		expect(policy.min_samples).toBe(MIN_SAMPLES_FOR_RANKING);
		const cause = policy.causes.find((c) => c.cause === "regression");
		expect(cause?.order.length).toBe(2);
	});
});

describe("publishPolicyReport compares learned order to the static formula (item 97)", () => {
	test("a cause with insufficient evidence is reported as insufficient_data", () => {
		const outcomes = repeat(2, () =>
			outcome({ cause: "data_corruption", mode: "rollback", succeeded: true }),
		);
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		const report = publishPolicyReport(policy);
		const entry = report.entries.find((e) => e.cause === "data_corruption");
		expect(entry?.verdict).toBe("insufficient_data");
	});

	test("a learned order identical to the static formula's is reported as matches_static", () => {
		// rollback (reversible, 5min) outranks traffic_shift (reversible, 60s)?
		// No -- static order sorts by time-to-effect within the same
		// reversibility tier, so retry (5s) < feature_disable (30s) <
		// traffic_shift (60s) < rollback (5min) for config_drift, where all four
		// are reversible and admissible. Feed outcomes that reproduce exactly
		// that order.
		const staticOrder = recommend(canonicalPermissiveContext("config_drift")).recommended.map(
			(r) => r.mode,
		);
		expect(staticOrder[0]).toBe("retry");

		// Give every mode decisively separated, strictly decreasing success
		// rates in the *same* order the static formula already produces.
		const outcomes = staticOrder.flatMap((mode, i) => {
			const successes = 20 - i * 5; // 20, 15, 10, 5
			return [
				...repeat(successes, () => outcome({ cause: "config_drift", mode, succeeded: true })),
				...repeat(20 - successes, () => outcome({ cause: "config_drift", mode, succeeded: false })),
			];
		});
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		const report = publishPolicyReport(policy);
		const entry = report.entries.find((e) => e.cause === "config_drift");
		expect(entry?.learned_order).toEqual(staticOrder);
		expect(entry?.verdict).toBe("matches_static");
		expect(report.diverging_causes).not.toContain("config_drift");
	});

	test("a learned order that reverses the static formula's is reported as diverges, with a caveat", () => {
		const staticOrder = recommend(canonicalPermissiveContext("config_drift")).recommended.map(
			(r) => r.mode,
		);
		const reversed = [...staticOrder].reverse();
		const outcomes = reversed.flatMap((mode, i) => {
			const successes = 20 - i * 5;
			return [
				...repeat(successes, () => outcome({ cause: "config_drift", mode, succeeded: true })),
				...repeat(20 - successes, () => outcome({ cause: "config_drift", mode, succeeded: false })),
			];
		});
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		const report = publishPolicyReport(policy);
		const entry = report.entries.find((e) => e.cause === "config_drift");
		expect(entry?.learned_order).toEqual(reversed);
		expect(entry?.verdict).toBe("diverges");
		expect(report.diverging_causes).toContain("config_drift");
		expect(report.caveats.some((c) => c.includes("actual change in recommended order"))).toBe(true);
	});

	test("rendering the report prints verdict, learned order, and static order per cause", () => {
		const outcomes = [
			...repeat(15, () => outcome({ cause: "regression", mode: "rollback", succeeded: true })),
			...repeat(15, () =>
				outcome({ cause: "regression", mode: "feature_disable", succeeded: false }),
			),
		];
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		const text = renderPolicyReport(publishPolicyReport(policy));
		expect(text).toContain("regression");
		expect(text).toContain("learned:");
		expect(text).toContain("static:");
	});
});

describe("activatePolicy requires the item-77 approval gate (item 97)", () => {
	function evidencedPolicy() {
		const outcomes = [
			...repeat(15, () => outcome({ cause: "regression", mode: "rollback", succeeded: true })),
			...repeat(15, () =>
				outcome({ cause: "regression", mode: "feature_disable", succeeded: false }),
			),
		];
		return learnRankingPolicy(outcomes, { now_ms: NOW });
	}

	test("activation without a grant is refused", () => {
		const policy = evidencedPolicy();
		const result = activatePolicy(policy, "agent", undefined, { now_ms: NOW, key: KEY });
		expect(result.ok).toBe(false);
	});

	test("self-approval is refused, exactly as it is for any other remediation action", () => {
		const policy = evidencedPolicy();
		const action = policyActivationAction(policy, "agent");
		expect(action.mode).toBe(ACTIVATION_MODE);
		const grantResult = grantApproval(action, "agent", { now_ms: NOW, key: KEY });
		expect(grantResult.ok).toBe(false);
	});

	test("a valid, non-self grant activates the policy, and the result is reflected in status/activated_by", () => {
		const policy = evidencedPolicy();
		const action = policyActivationAction(policy, "agent");
		const grantResult = grantApproval(action, "oncall-lead", { now_ms: NOW, key: KEY });
		expect(grantResult.ok).toBe(true);
		if (!grantResult.ok) throw new Error("unreachable");

		const result = activatePolicy(policy, "agent", grantResult.grant, { now_ms: NOW, key: KEY });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.policy.status).toBe("active");
		expect(result.policy.activated_by).toBe("oncall-lead");
	});

	test("an expired grant is refused", () => {
		const policy = evidencedPolicy();
		const action = policyActivationAction(policy, "agent");
		const grantResult = grantApproval(action, "oncall-lead", {
			now_ms: NOW,
			key: KEY,
			ttl_ms: 1000,
		});
		expect(grantResult.ok).toBe(true);
		if (!grantResult.ok) throw new Error("unreachable");
		const result = activatePolicy(policy, "agent", grantResult.grant, {
			now_ms: NOW + 2000,
			key: KEY,
		});
		expect(result.ok).toBe(false);
	});

	test("a grant for a different policy_id does not activate this policy", () => {
		const policy = evidencedPolicy();
		const otherAction = policyActivationAction({ ...policy, id: "different-policy-id" }, "agent");
		const grantResult = grantApproval(otherAction, "oncall-lead", { now_ms: NOW, key: KEY });
		expect(grantResult.ok).toBe(true);
		if (!grantResult.ok) throw new Error("unreachable");
		const result = activatePolicy(policy, "agent", grantResult.grant, { now_ms: NOW, key: KEY });
		expect(result.ok).toBe(false);
	});

	test("a policy with no cause clearing the two-mode threshold cannot be activated at all", () => {
		const outcomes = repeat(3, () =>
			outcome({ cause: "data_corruption", mode: "rollback", succeeded: true }),
		);
		const policy = learnRankingPolicy(outcomes, { now_ms: NOW });
		const action = policyActivationAction(policy, "agent");
		const grantResult = grantApproval(action, "oncall-lead", { now_ms: NOW, key: KEY });
		expect(grantResult.ok).toBe(true);
		if (!grantResult.ok) throw new Error("unreachable");
		const result = activatePolicy(policy, "agent", grantResult.grant, { now_ms: NOW, key: KEY });
		expect(result.ok).toBe(false);
	});

	test("an already-active policy cannot be re-activated", () => {
		const policy = evidencedPolicy();
		const action = policyActivationAction(policy, "agent");
		const grantResult = grantApproval(action, "oncall-lead", { now_ms: NOW, key: KEY });
		if (!grantResult.ok) throw new Error("unreachable");
		const activated = activatePolicy(policy, "agent", grantResult.grant, { now_ms: NOW, key: KEY });
		if (!activated.ok) throw new Error("unreachable");

		const reGrant = grantApproval(
			policyActivationAction(activated.policy, "agent"),
			"oncall-lead",
			{ now_ms: NOW, key: KEY },
		);
		if (!reGrant.ok) throw new Error("unreachable");
		const result = activatePolicy(activated.policy, "agent", reGrant.grant, {
			now_ms: NOW,
			key: KEY,
		});
		expect(result.ok).toBe(false);
	});

	test("the activation action always has blast_radius 1 and reversible true, regardless of policy content", () => {
		const policy = evidencedPolicy();
		const action = policyActivationAction(policy, "agent");
		expect(action.blast_radius).toBe(1);
		expect(action.reversible).toBe(true);
	});
});

describe("rankWithLearnedPolicy never grows the safe set (item 97)", () => {
	function activePolicyFor(cause: RemediationContext["cause"], order: string[]) {
		const outcomes = order.flatMap((mode, i) => {
			const successes = 20 - i * 5;
			return [
				...repeat(successes, () =>
					outcome({ cause, mode: mode as RemediationOutcome["mode"], succeeded: true }),
				),
				...repeat(20 - successes, () =>
					outcome({ cause, mode: mode as RemediationOutcome["mode"], succeeded: false }),
				),
			];
		});
		const draft = learnRankingPolicy(outcomes, { now_ms: NOW });
		return {
			...draft,
			status: "active" as const,
			activated_by: "oncall-lead",
			activated_at_ms: NOW,
		};
	}

	test("with no policy supplied, the result is identical to recommend()", () => {
		const context = permissiveContext();
		const base = recommend(context);
		const ranked = rankWithLearnedPolicy(context);
		expect(ranked.recommended.map((r) => r.mode)).toEqual(base.recommended.map((r) => r.mode));
	});

	test("a draft policy has no effect on ranking", () => {
		const context = permissiveContext({ cause: "config_drift" });
		const base = recommend(context);
		const draftPolicy = learnRankingPolicy(
			[
				...repeat(15, () => outcome({ cause: "config_drift", mode: "retry", succeeded: false })),
				...repeat(15, () => outcome({ cause: "config_drift", mode: "rollback", succeeded: true })),
			],
			{ now_ms: NOW },
		);
		expect(draftPolicy.status).toBe("draft");
		const ranked = rankWithLearnedPolicy(context, draftPolicy);
		expect(ranked.recommended.map((r) => r.mode)).toEqual(base.recommended.map((r) => r.mode));
	});

	test("an active policy for a different cause has no effect", () => {
		const context = permissiveContext({ cause: "config_drift" });
		const base = recommend(context);
		const policy = activePolicyFor("regression", ["rollback", "feature_disable"]);
		const ranked = rankWithLearnedPolicy(context, policy);
		expect(ranked.recommended.map((r) => r.mode)).toEqual(base.recommended.map((r) => r.mode));
	});

	test("an active policy for the matching cause reorders only the already-applicable set", () => {
		const context = permissiveContext({ cause: "config_drift" });
		const base = recommend(context);
		const baseModes = base.recommended.map((r) => r.mode);
		expect(baseModes.length).toBeGreaterThanOrEqual(2);

		// Learn the exact reverse of whatever order recommend() already produced.
		const reversed = [...baseModes].reverse();
		const policy = activePolicyFor("config_drift", reversed);
		const ranked = rankWithLearnedPolicy(context, policy);

		expect(ranked.recommended.map((r) => r.mode)).toEqual(reversed);
		// Same set, just reordered -- nothing was added or removed.
		expect([...ranked.recommended.map((r) => r.mode)].sort()).toEqual([...baseModes].sort());
	});

	test("a mode the policy has no evidence for keeps its static position and sorts after evidenced modes", () => {
		const context = permissiveContext({ cause: "config_drift" });
		const base = recommend(context);
		const baseModes = base.recommended.map((r) => r.mode);
		// Only learn an order for the first mode vs itself is impossible; learn
		// for the first two modes only, leaving the rest unevidenced.
		const [first, second, ...rest] = baseModes;
		if (!second) return; // not enough modes in this context to exercise the case
		const policy = activePolicyFor("config_drift", [second, first]);
		const ranked = rankWithLearnedPolicy(context, policy);
		const rankedModes = ranked.recommended.map((r) => r.mode);
		expect(rankedModes[0]).toBe(second);
		expect(rankedModes[1]).toBe(first);
		expect(rankedModes.slice(2)).toEqual(rest);
	});

	test("a contraindicated mode never appears, even if the policy ranks it first", () => {
		// retry is contraindicated for resource_exhaustion in modes.ts; feed a
		// policy that (nonsensically) ranks it top anyway and confirm it still
		// never appears.
		const context: RemediationContext = {
			cause: "resource_exhaustion",
			failure_is_transient: true, // would satisfy retry's own precondition...
			previous_version: "1.0",
			previous_version_deployable: true,
			gating_flag: "flag",
			flag_covers_failure: true,
			spare_capacity_fraction: 2,
			failure_is_localized: true,
		};
		expect(evaluateMode("retry", context).applicable).toBe(false); // ...but contraindicated anyway
		const policy = activePolicyFor("resource_exhaustion", ["retry", "rollback"]);
		const ranked = rankWithLearnedPolicy(context, policy);
		expect(ranked.recommended.map((r) => r.mode)).not.toContain("retry");
	});

	test("the caveat set names the policy and lists any unevidenced modes that kept their static position", () => {
		const context = permissiveContext({ cause: "config_drift" });
		const base = recommend(context);
		const baseModes = base.recommended.map((r) => r.mode);
		const [first, second] = baseModes;
		if (!second) return;
		const policy = activePolicyFor("config_drift", [second, first]);
		const ranked = rankWithLearnedPolicy(context, policy);
		expect(ranked.caveats.some((c) => c.includes(policy.id))).toBe(true);
		if (baseModes.length > 2) {
			expect(ranked.caveats.some((c) => c.includes("kept their static-ranking position"))).toBe(
				true,
			);
		}
	});

	test("an unapplicable context (nothing recommended) is unaffected by any policy", () => {
		const context: RemediationContext = { cause: "unknown" };
		const base = recommend(context);
		expect(base.recommended).toEqual([]);
		const policy = activePolicyFor("unknown", ["rollback", "retry"]);
		const ranked = rankWithLearnedPolicy(context, policy);
		expect(ranked.recommended).toEqual([]);
	});
});
