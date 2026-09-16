import { describe, expect, test } from "bun:test";
import {
	APPROVAL_REQUIRED_AT,
	type ApprovalGrant,
	CONSEQUENCE_LEVELS,
	type DryRunRecord,
	MAX_APPROVAL_TTL_MS,
	type RemediationAction,
	actionDigest,
	checkApproval,
	classifyConsequence,
	grantApproval,
	renderAudit,
	requiresApproval,
} from "../../src/remediation/approval.js";

const KEY = "test-approval-signing-key";
const NOW = 1_700_000_000_000;

function action(overrides: Partial<RemediationAction> = {}): RemediationAction {
	return {
		mode: "rollback",
		target: "checkout",
		parameters: { version: "1.2.3" },
		reversible: true,
		blast_radius: 1,
		requested_by: "agent",
		...overrides,
	};
}

function grant(
	a: RemediationAction = action(),
	overrides: Parameters<typeof grantApproval>[2] = {},
): ApprovalGrant {
	const result = grantApproval(a, "oncall", { now_ms: NOW, key: KEY, ...overrides });
	if (!result.ok) throw new Error(result.reason);
	return result.grant;
}

function dryRun(a: RemediationAction = action()): DryRunRecord {
	return {
		action_digest: actionDigest(a),
		performed_at_ms: NOW,
		predicted_effects: ["restores 1.2.2"],
		succeeded: true,
	};
}

describe("consequence classification", () => {
	test("irreversibility dominates blast radius", () => {
		const smallIrreversible = action({ reversible: false, blast_radius: 0.01 });
		const largeReversible = action({ reversible: true, blast_radius: 1 });
		expect(CONSEQUENCE_LEVELS.indexOf(classifyConsequence(smallIrreversible))).toBeGreaterThan(
			CONSEQUENCE_LEVELS.indexOf(classifyConsequence(largeReversible)),
		);
	});

	test("every irreversible action is severe, however small it looks", () => {
		expect(classifyConsequence(action({ reversible: false, blast_radius: 0.5 }))).toBe("severe");
		expect(classifyConsequence(action({ reversible: false, blast_radius: 0 }))).toBe("severe");
	});

	test("a zero-blast reversible action is low and needs no approval", () => {
		const trivial = action({ blast_radius: 0 });
		expect(classifyConsequence(trivial)).toBe("low");
		expect(requiresApproval(trivial)).toBe(false);
	});

	test("the approval threshold is a declared level", () => {
		expect(CONSEQUENCE_LEVELS).toContain(APPROVAL_REQUIRED_AT);
	});
});

describe("an approval binds to a specific action", () => {
	test("the digest changes with the target", () => {
		expect(actionDigest(action())).not.toBe(actionDigest(action({ target: "payments" })));
	});

	test("the digest changes with a parameter", () => {
		expect(actionDigest(action())).not.toBe(
			actionDigest(action({ parameters: { version: "9.9.9" } })),
		);
	});

	test("parameter order does not change the digest", () => {
		const a = action({ parameters: { a: 1, b: 2 } });
		const b = action({ parameters: { b: 2, a: 1 } });
		expect(actionDigest(a)).toBe(actionDigest(b));
	});

	test("a grant for one target does not authorize another", () => {
		const decision = checkApproval(action({ target: "payments" }), grant(), {
			now_ms: NOW,
			key: KEY,
		});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("do not transfer between targets");
	});

	test("a grant for one requester does not authorize another", () => {
		const decision = checkApproval(action({ requested_by: "someone-else" }), grant(), {
			now_ms: NOW,
			key: KEY,
		});
		expect(decision.allowed).toBe(false);
	});

	test("a tampered signature does not verify", () => {
		const bad = { ...grant(), signature: `${"0".repeat(64)}` };
		expect(checkApproval(action(), bad, { now_ms: NOW, key: KEY }).reason).toContain(
			"signature does not verify",
		);
	});

	test("a signature of the wrong length is rejected without throwing", () => {
		const bad = { ...grant(), signature: "abcd" };
		expect(checkApproval(action(), bad, { now_ms: NOW, key: KEY }).allowed).toBe(false);
	});

	test("a different key does not verify", () => {
		expect(
			checkApproval(action(), grant(), { now_ms: NOW, key: "other-key" }).allowed,
		).toBe(false);
	});
});

describe("approvals expire", () => {
	test("a valid, unexpired approval is accepted", () => {
		const decision = checkApproval(action(), grant(), { now_ms: NOW + 1000, key: KEY });
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toContain("approved by 'oncall'");
	});

	test("an expired approval is refused with the state argument", () => {
		const decision = checkApproval(action(), grant(), {
			now_ms: NOW + MAX_APPROVAL_TTL_MS + 1,
			key: KEY,
		});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("no longer holds");
	});

	test("expiry is checked against the verifier's clock, not the token", () => {
		// A grant claiming a far-future expiry is still bounded at issue time.
		const result = grantApproval(action(), "oncall", {
			now_ms: NOW,
			key: KEY,
			ttl_ms: MAX_APPROVAL_TTL_MS * 10,
		});
		expect(result.ok).toBe(false);
	});

	test("a grant dated in the future is refused", () => {
		expect(
			checkApproval(action(), grant(), { now_ms: NOW - 10_000, key: KEY }).allowed,
		).toBe(false);
	});

	test("a non-positive lifetime is refused at issue", () => {
		const result = grantApproval(action(), "oncall", { now_ms: NOW, key: KEY, ttl_ms: 0 });
		expect(result.ok).toBe(false);
	});
});

describe("the approver is not the requester", () => {
	test("self-approval is refused at issue time", () => {
		const result = grantApproval(action({ requested_by: "oncall" }), "oncall", {
			now_ms: NOW,
			key: KEY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("cannot also approve it");
	});

	test("a forged self-approval is refused at verification time too", () => {
		const forged = grant(action({ requested_by: "someone" }));
		// Rebuild the action so its requester matches the approver.
		const selfRequested = action({ requested_by: "oncall" });
		expect(checkApproval(selfRequested, forged, { now_ms: NOW, key: KEY }).allowed).toBe(false);
	});

	test("an anonymous approver is refused", () => {
		expect(grantApproval(action(), "  ", { now_ms: NOW, key: KEY }).ok).toBe(false);
	});
});

describe("irreversible actions require a dry run", () => {
	const irreversible = action({ reversible: false, blast_radius: 0.1 });

	test("without a dry run the action is refused", () => {
		const decision = checkApproval(irreversible, grant(irreversible), {
			now_ms: NOW,
			key: KEY,
		});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("a description of an action rather than the action");
	});

	test("with a successful dry run it is allowed", () => {
		const decision = checkApproval(irreversible, grant(irreversible), {
			now_ms: NOW,
			key: KEY,
			dry_run: dryRun(irreversible),
		});
		expect(decision.allowed).toBe(true);
	});

	test("a dry run for a different action does not count", () => {
		const decision = checkApproval(irreversible, grant(irreversible), {
			now_ms: NOW,
			key: KEY,
			dry_run: dryRun(action({ target: "elsewhere", reversible: false, blast_radius: 0.1 })),
		});
		expect(decision.reason).toContain("dry run was performed for a different action");
	});

	test("a failed dry run blocks the real run", () => {
		const decision = checkApproval(irreversible, grant(irreversible), {
			now_ms: NOW,
			key: KEY,
			dry_run: { ...dryRun(irreversible), succeeded: false },
		});
		expect(decision.reason).toContain("the real run is not more likely to");
	});

	test("a reversible action needs no dry run", () => {
		expect(checkApproval(action(), grant(), { now_ms: NOW, key: KEY }).allowed).toBe(true);
	});
});

describe("the emergency override", () => {
	test("an override is allowed and flagged for review", () => {
		const overrideGrant = grant(action(), { override_justification: "prod is down" });
		const decision = checkApproval(action(), overrideGrant, { now_ms: NOW, key: KEY });
		expect(decision.allowed).toBe(true);
		expect(decision.overridden).toBe(true);
		expect(decision.requires_post_hoc_review).toBe(true);
		expect(decision.reason).toContain("prod is down");
	});

	test("an override without a justification cannot be issued", () => {
		const result = grantApproval(action(), "oncall", {
			now_ms: NOW,
			key: KEY,
			override_justification: "   ",
		});
		expect(result.ok).toBe(false);
	});

	test("the justification is part of the signature and cannot be edited", () => {
		const overrideGrant = grant(action(), { override_justification: "prod is down" });
		const edited = { ...overrideGrant, override: { justification: "routine maintenance" } };
		expect(checkApproval(action(), edited, { now_ms: NOW, key: KEY }).allowed).toBe(false);
	});

	test("an override does not excuse an expired approval", () => {
		const overrideGrant = grant(action(), { override_justification: "prod is down" });
		expect(
			checkApproval(action(), overrideGrant, {
				now_ms: NOW + MAX_APPROVAL_TTL_MS + 1,
				key: KEY,
			}).allowed,
		).toBe(false);
	});

	test("an override does not excuse a missing dry run", () => {
		const irreversible = action({ reversible: false, blast_radius: 0.1 });
		const overrideGrant = grant(irreversible, { override_justification: "prod is down" });
		expect(
			checkApproval(irreversible, overrideGrant, { now_ms: NOW, key: KEY }).allowed,
		).toBe(false);
	});
});

describe("the gate itself", () => {
	test("a low-consequence action passes without an approval", () => {
		const decision = checkApproval(action({ blast_radius: 0 }), undefined, {
			now_ms: NOW,
			key: KEY,
		});
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toContain("below the");
	});

	test("a consequential action with no approval is refused", () => {
		const decision = checkApproval(action(), undefined, { now_ms: NOW, key: KEY });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("none was supplied");
	});

	test("a missing signing key refuses rather than allowing", () => {
		expect(checkApproval(action(), grant(), { now_ms: NOW, key: "" }).allowed).toBe(false);
	});

	test("a properly approved severe action still requires post-hoc review", () => {
		const severe = action({ reversible: false, blast_radius: 0.9 });
		const decision = checkApproval(severe, grant(severe), {
			now_ms: NOW,
			key: KEY,
			dry_run: dryRun(severe),
		});
		expect(decision.allowed).toBe(true);
		expect(decision.requires_post_hoc_review).toBe(true);
	});
});

describe("audit records", () => {
	test("every decision produces a record, allowed or refused", () => {
		const allowed = checkApproval(action(), grant(), { now_ms: NOW, key: KEY });
		const refused = checkApproval(action(), undefined, { now_ms: NOW, key: KEY });
		expect(allowed.audit.decision).toBe("allowed");
		expect(refused.audit.decision).toBe("refused");
	});

	test("the record carries requester, approver, consequence, and dry-run state", () => {
		const record = checkApproval(action(), grant(), { now_ms: NOW, key: KEY }).audit;
		expect(record.requested_by).toBe("agent");
		expect(record.approver).toBe("oncall");
		expect(record.consequence).toBe("high");
		expect(record.dry_run_performed).toBe(false);
	});

	test("an override justification reaches the audit record", () => {
		const overrideGrant = grant(action(), { override_justification: "prod is down" });
		const record = checkApproval(action(), overrideGrant, { now_ms: NOW, key: KEY }).audit;
		expect(record.override_justification).toBe("prod is down");
	});

	test("rendering leads with the decision and never buries a refusal", () => {
		const text = renderAudit(
			checkApproval(action(), undefined, { now_ms: NOW, key: KEY }).audit,
		);
		expect(text.startsWith("[REFUSED]")).toBe(true);
		expect(text).toContain("none was supplied");
	});

	test("an override is visible in the rendered line", () => {
		const overrideGrant = grant(action(), { override_justification: "prod is down" });
		const text = renderAudit(
			checkApproval(action(), overrideGrant, { now_ms: NOW, key: KEY }).audit,
		);
		expect(text).toContain("OVERRIDE: prod is down");
	});
});
