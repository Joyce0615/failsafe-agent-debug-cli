/**
 * Approval gate for consequential remediation actions (item 77).
 *
 * A gate that can be satisfied by a blanket "yes" is not a gate. Five
 * properties separate an approval mechanism that constrains anything from one
 * that is theatre, and all five are enforced here rather than documented as
 * expectations:
 *
 * 1. **An approval binds to a specific action, not a category.** The token is
 *    an HMAC over a canonical digest of the exact action — mode, target,
 *    parameters — so approval to roll back service A cannot be replayed to roll
 *    back service B, and "approved: remediation" is not a thing that can exist.
 *
 * 2. **Approvals expire.** A token issued three hours ago was issued against a
 *    system state that no longer exists, and the incident it was granted for
 *    may already have been mitigated another way. Expiry is checked against the
 *    *verifier's* clock, not a timestamp inside the token.
 *
 * 3. **The approver is not the requester.** Self-approval defeats the gate
 *    entirely, and it is the single easiest thing to implement by accident.
 *
 * 4. **Irreversible actions require a completed dry run.** Approving an
 *    irreversible action nobody has simulated is approving a description of an
 *    action rather than the action, and the difference shows up exactly once.
 *
 * 5. **The emergency override exists and is expensive.** A system with no
 *    override gets bypassed informally — someone runs the command by hand and
 *    the audit trail ends. So there is one, it demands a written justification,
 *    and it marks the action for mandatory post-hoc review.
 *
 * Pure apart from reading the signing key from the environment.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CONSEQUENCE_LEVELS = ["none", "low", "moderate", "high", "severe"] as const;
export type ConsequenceLevel = (typeof CONSEQUENCE_LEVELS)[number];

/** Level at or above which an approval is required. */
export const APPROVAL_REQUIRED_AT: ConsequenceLevel = "moderate";

export type RemediationAction = {
	/** e.g. `rollback`, `feature_disable`, `traffic_shift`, `restart`. */
	mode: string;
	/** What it acts on: a service, a flag, a shard. */
	target: string;
	/** Parameters that change what the action does. Order-insensitive. */
	parameters: Record<string, string | number | boolean>;
	reversible: boolean;
	/** Fraction of traffic or users affected, 0..1. */
	blast_radius: number;
	/** Who is asking. */
	requested_by: string;
};

/**
 * Classify an action's consequence.
 *
 * Irreversibility dominates blast radius: a small irreversible action outranks
 * a large reversible one, because the recoverable path from the second exists
 * and from the first does not.
 */
export function classifyConsequence(action: RemediationAction): ConsequenceLevel {
	// Irreversibility is not one input among several: it is a different
	// category. Every irreversible action is severe regardless of how small it
	// looks, because the recoverable path exists for the reversible ones and
	// does not exist for these. Blast radius still travels on the record, so
	// nothing is lost by not letting it lower the level.
	if (!action.reversible) return "severe";
	if (action.blast_radius >= 0.5) return "high";
	if (action.blast_radius > 0) return "moderate";
	return "low";
}

export function requiresApproval(action: RemediationAction): boolean {
	return (
		CONSEQUENCE_LEVELS.indexOf(classifyConsequence(action)) >=
		CONSEQUENCE_LEVELS.indexOf(APPROVAL_REQUIRED_AT)
	);
}

/**
 * Canonical digest of an action.
 *
 * Keys are sorted so that two structurally identical actions produce the same
 * digest regardless of how the object was built, and everything that changes
 * what the action *does* is included. `requested_by` is included too: an
 * approval is granted to a person for an action, and letting a second person
 * reuse the first's token would make the audit trail wrong about who acted.
 */
export function actionDigest(action: RemediationAction): string {
	const parameters = Object.keys(action.parameters)
		.sort()
		.map((k) => `${k}=${String(action.parameters[k])}`)
		.join("&");
	return [
		action.mode,
		action.target,
		parameters,
		String(action.reversible),
		action.blast_radius.toFixed(4),
		action.requested_by,
	].join("|");
}

/** Environment variable holding the approval signing key. */
export const APPROVAL_KEY_ENV = "FAILSAFE_APPROVAL_KEY";
/** Longest an approval may remain valid. */
export const MAX_APPROVAL_TTL_MS = 15 * 60_000;

export type ApprovalGrant = {
	/** Digest of the action approved. */
	action_digest: string;
	approver: string;
	granted_at_ms: number;
	expires_at_ms: number;
	/** HMAC over the fields above. */
	signature: string;
	/** Present only for an emergency override. */
	override?: { justification: string };
};

function sign(payload: string, key: string): string {
	return createHmac("sha256", key).update(payload).digest("hex");
}

function grantPayload(grant: Omit<ApprovalGrant, "signature">): string {
	return [
		grant.action_digest,
		grant.approver,
		String(grant.granted_at_ms),
		String(grant.expires_at_ms),
		grant.override?.justification ?? "",
	].join("|");
}

export type GrantResult = { ok: true; grant: ApprovalGrant } | { ok: false; reason: string };

/**
 * Issue an approval.
 *
 * Refuses to issue at all in the cases that would produce a useless token:
 * self-approval, an over-long TTL, an override with no justification, or a
 * missing signing key. Issuing and then failing verification would be
 * equivalent but far more confusing at the point of use.
 */
export function grantApproval(
	action: RemediationAction,
	approver: string,
	opts: { now_ms?: number; ttl_ms?: number; override_justification?: string; key?: string } = {},
): GrantResult {
	const key = opts.key ?? process.env[APPROVAL_KEY_ENV];
	if (!key) {
		return { ok: false, reason: `${APPROVAL_KEY_ENV} is not set; approvals cannot be signed` };
	}
	if (approver.trim().length === 0) {
		return { ok: false, reason: "an approval must name its approver" };
	}
	if (approver === action.requested_by) {
		return {
			ok: false,
			reason: `'${approver}' requested this action and cannot also approve it`,
		};
	}

	const now = opts.now_ms ?? Date.now();
	const ttl = opts.ttl_ms ?? MAX_APPROVAL_TTL_MS;
	if (ttl <= 0) return { ok: false, reason: "an approval with a non-positive lifetime is useless" };
	if (ttl > MAX_APPROVAL_TTL_MS) {
		return {
			ok: false,
			reason: `a lifetime of ${ttl}ms exceeds the ${MAX_APPROVAL_TTL_MS}ms ceiling; an approval outliving the state it was granted against is not an approval`,
		};
	}

	const override =
		opts.override_justification !== undefined
			? { justification: opts.override_justification.trim() }
			: undefined;
	if (override && override.justification.length === 0) {
		return { ok: false, reason: "an emergency override requires a written justification" };
	}

	const unsigned: Omit<ApprovalGrant, "signature"> = {
		action_digest: actionDigest(action),
		approver,
		granted_at_ms: now,
		expires_at_ms: now + ttl,
		...(override ? { override } : {}),
	};
	return { ok: true, grant: { ...unsigned, signature: sign(grantPayload(unsigned), key) } };
}

export type DryRunRecord = {
	action_digest: string;
	performed_at_ms: number;
	/** What the dry run predicts will change. */
	predicted_effects: string[];
	/** Whether the dry run itself succeeded. */
	succeeded: boolean;
};

export type GateDecision = {
	allowed: boolean;
	/** Exactly one reason, whether allowing or refusing. */
	reason: string;
	consequence: ConsequenceLevel;
	/** True when the action proceeded under an emergency override. */
	overridden: boolean;
	/** True when the action must be reviewed after the fact. */
	requires_post_hoc_review: boolean;
	audit: AuditRecord;
};

export type AuditRecord = {
	action_digest: string;
	mode: string;
	target: string;
	requested_by: string;
	approver?: string;
	consequence: ConsequenceLevel;
	decided_at_ms: number;
	decision: "allowed" | "refused";
	reason: string;
	override_justification?: string;
	dry_run_performed: boolean;
};

/**
 * Decide whether an action may execute.
 *
 * Verification happens against the verifier's own clock and its own recomputed
 * digest, never against values carried in the grant. A grant that says it is
 * unexpired is not evidence that it is unexpired.
 */
export function checkApproval(
	action: RemediationAction,
	grant: ApprovalGrant | undefined,
	opts: { now_ms?: number; dry_run?: DryRunRecord; key?: string } = {},
): GateDecision {
	const now = opts.now_ms ?? Date.now();
	const consequence = classifyConsequence(action);
	const digest = actionDigest(action);

	const decide = (
		allowed: boolean,
		reason: string,
		extra: Partial<GateDecision> = {},
	): GateDecision => ({
		allowed,
		reason,
		consequence,
		overridden: extra.overridden ?? false,
		requires_post_hoc_review: extra.requires_post_hoc_review ?? false,
		audit: {
			action_digest: digest,
			mode: action.mode,
			target: action.target,
			requested_by: action.requested_by,
			...(grant ? { approver: grant.approver } : {}),
			consequence,
			decided_at_ms: now,
			decision: allowed ? "allowed" : "refused",
			reason,
			...(grant?.override ? { override_justification: grant.override.justification } : {}),
			dry_run_performed: opts.dry_run !== undefined,
		},
	});

	if (!requiresApproval(action)) {
		return decide(
			true,
			`consequence '${consequence}' is below the '${APPROVAL_REQUIRED_AT}' threshold`,
		);
	}
	if (!grant) {
		return decide(false, `consequence '${consequence}' requires an approval and none was supplied`);
	}

	const key = opts.key ?? process.env[APPROVAL_KEY_ENV];
	if (!key) {
		return decide(false, `${APPROVAL_KEY_ENV} is not set; the approval cannot be verified`);
	}

	// Recompute the digest rather than trusting the one in the grant: an
	// approval for a different action is the whole attack.
	if (grant.action_digest !== digest) {
		return decide(
			false,
			"the approval was granted for a different action; approvals do not transfer between targets or parameters",
		);
	}

	const expected = Buffer.from(sign(grantPayload(grant), key), "hex");
	const actual = Buffer.from(grant.signature, "hex");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return decide(false, "the approval signature does not verify");
	}

	if (grant.approver === action.requested_by) {
		return decide(false, `'${grant.approver}' both requested and approved this action`);
	}
	if (now >= grant.expires_at_ms) {
		return decide(
			false,
			`the approval expired ${now - grant.expires_at_ms}ms ago; the system state it was granted against no longer holds`,
		);
	}
	if (now < grant.granted_at_ms) {
		return decide(false, "the approval is dated in the future relative to this clock");
	}

	if (!action.reversible) {
		const dryRun = opts.dry_run;
		if (!dryRun) {
			return decide(
				false,
				"an irreversible action requires a completed dry run; approving one nobody has simulated is approving a description of an action rather than the action",
			);
		}
		if (dryRun.action_digest !== digest) {
			return decide(false, "the dry run was performed for a different action");
		}
		if (!dryRun.succeeded) {
			return decide(false, "the dry run did not succeed; the real run is not more likely to");
		}
	}

	if (grant.override) {
		return decide(
			true,
			`emergency override by '${grant.approver}': ${grant.override.justification}`,
			{
				overridden: true,
				requires_post_hoc_review: true,
			},
		);
	}

	return decide(
		true,
		`approved by '${grant.approver}', valid for a further ${grant.expires_at_ms - now}ms`,
		{
			// Severe actions are reviewed afterwards even when properly approved:
			// the approval says somebody agreed beforehand, not that it went well.
			requires_post_hoc_review: consequence === "severe",
		},
	);
}

/**
 * Render an audit record as one line.
 *
 * Includes the refusal reason as prominently as an approval, because the
 * interesting entries in an audit log are the refusals and the overrides, and a
 * format that buries them is a format nobody reads for either.
 */
export function renderAudit(record: AuditRecord): string {
	const parts = [
		`[${record.decision.toUpperCase()}]`,
		`${record.mode} on ${record.target}`,
		`consequence=${record.consequence}`,
		`by=${record.requested_by}`,
		record.approver ? `approver=${record.approver}` : "approver=none",
		`dry_run=${record.dry_run_performed}`,
	];
	if (record.override_justification) parts.push(`OVERRIDE: ${record.override_justification}`);
	parts.push(`— ${record.reason}`);
	return parts.join(" ");
}
