/**
 * Retention, deletion, legal-hold, and tenant-isolation controls (item 90).
 *
 * These four are usually implemented as separate features and interact in ways
 * that make each one wrong on its own. The interactions are what this module is
 * about.
 *
 * 1. **Legal hold beats retention, and the conflict must be recorded.** A
 *    record past its TTL under hold is not deleted. If that is not logged, a
 *    compliance statement reads "we delete after 30 days" while records sit
 *    indefinitely, and both halves are believed by different people.
 *    `planRetention` emits `retained_under_hold` as a first-class outcome.
 *
 * 2. **Deletion is verified, not requested.** "We issued a delete" and "the row
 *    is gone" are different sentences. Derived copies — indexes, caches,
 *    exported bundles, backups — are enumerated per record, and any location
 *    the deleter cannot reach is reported as *known residue* rather than
 *    assumed clean. A deletion report with no residue section is a deletion
 *    report that has not looked.
 *
 * 3. **Tenant isolation is enforced, not conventional.** A query with no tenant
 *    predicate is *rejected*, never defaulted to "all tenants". Defaulting is
 *    how a cross-tenant leak happens: the code that forgot the predicate is
 *    indistinguishable from the code that meant to scan everything.
 *
 * 4. **A deletion request that collides with a hold is refused**, not queued.
 *    Silently deferring it produces a system that reports the deletion as
 *    complete and performs it weeks later, after the hold lifts, with nobody
 *    watching.
 *
 * Pure: plans and verifies; the storage engine executes.
 */

export const DATA_CLASSES = [
	"failure_output",
	"diagnosis",
	"trace",
	"exchange_bundle",
	"audit_log",
] as const;
export type GovernedDataClass = (typeof DATA_CLASSES)[number];

export type RetentionRule = {
	data_class: GovernedDataClass;
	/** Milliseconds after creation at which the record becomes deletable. */
	ttl_ms: number;
	/**
	 * Whether a legal hold can suspend deletion of this class. Audit logs are
	 * deliberately not holdable-exempt: a class nothing can hold is a class
	 * whose deletion cannot be paused for an investigation.
	 */
	holdable: boolean;
};

export const DEFAULT_RETENTION: Record<GovernedDataClass, RetentionRule> = {
	failure_output: { data_class: "failure_output", ttl_ms: 30 * 86_400_000, holdable: true },
	diagnosis: { data_class: "diagnosis", ttl_ms: 90 * 86_400_000, holdable: true },
	trace: { data_class: "trace", ttl_ms: 7 * 86_400_000, holdable: true },
	exchange_bundle: { data_class: "exchange_bundle", ttl_ms: 14 * 86_400_000, holdable: true },
	// Audit records outlive the things they describe, or the audit is not one.
	audit_log: { data_class: "audit_log", ttl_ms: 365 * 86_400_000, holdable: true },
};

export type GovernedRecord = {
	id: string;
	tenant: string;
	data_class: GovernedDataClass;
	created_at_ms: number;
	/** Every place a copy of this record exists. */
	locations: string[];
};

export type LegalHold = {
	id: string;
	/** Tenants the hold covers. Empty means every tenant. */
	tenants: string[];
	/** Data classes covered. Empty means every class. */
	data_classes: GovernedDataClass[];
	placed_at_ms: number;
	/** Absent means indefinite, which is itself worth reporting. */
	lifted_at_ms?: number;
	reason: string;
};

/** Whether a hold is in force for a record at a given time. */
export function holdApplies(hold: LegalHold, record: GovernedRecord, atMs: number): boolean {
	if (atMs < hold.placed_at_ms) return false;
	if (hold.lifted_at_ms !== undefined && atMs >= hold.lifted_at_ms) return false;
	if (hold.tenants.length > 0 && !hold.tenants.includes(record.tenant)) return false;
	if (hold.data_classes.length > 0 && !hold.data_classes.includes(record.data_class)) return false;
	return true;
}

export const RETENTION_OUTCOMES = [
	"retain_within_ttl",
	"delete_expired",
	"retained_under_hold",
	"no_rule",
] as const;
export type RetentionOutcome = (typeof RETENTION_OUTCOMES)[number];

export type RetentionDecision = {
	record: GovernedRecord;
	outcome: RetentionOutcome;
	age_ms: number;
	ttl_ms?: number;
	/** Holds keeping this record alive past its TTL. */
	holds: string[];
	detail: string;
};

/**
 * Decide what happens to each record.
 *
 * `retained_under_hold` is separated from `retain_within_ttl` because they are
 * different states with different reporting obligations: one is the policy
 * working, the other is the policy being suspended, and a compliance report
 * that shows them as one number is describing a system nobody has.
 */
export function planRetention(
	records: GovernedRecord[],
	holds: LegalHold[],
	nowMs: number,
	rules: Record<GovernedDataClass, RetentionRule> = DEFAULT_RETENTION,
): RetentionDecision[] {
	return records.map((record) => {
		const rule = rules[record.data_class];
		const age = nowMs - record.created_at_ms;

		if (!rule) {
			return {
				record,
				outcome: "no_rule",
				age_ms: age,
				holds: [],
				detail: `no retention rule for class '${record.data_class}'; the record is kept by default and that default is not a policy`,
			};
		}
		if (age < rule.ttl_ms) {
			return {
				record,
				outcome: "retain_within_ttl",
				age_ms: age,
				ttl_ms: rule.ttl_ms,
				holds: [],
				detail: `${Math.floor(age / 86_400_000)}d old against a ${Math.floor(rule.ttl_ms / 86_400_000)}d retention`,
			};
		}

		const applicable = rule.holdable
			? holds.filter((hold) => holdApplies(hold, record, nowMs))
			: [];
		if (applicable.length > 0) {
			return {
				record,
				outcome: "retained_under_hold",
				age_ms: age,
				ttl_ms: rule.ttl_ms,
				holds: applicable.map((h) => h.id),
				detail: `past its ${Math.floor(rule.ttl_ms / 86_400_000)}d retention by ${Math.floor((age - rule.ttl_ms) / 86_400_000)}d and preserved by ${applicable.length} legal hold(s): ${applicable.map((h) => h.reason).join("; ")}`,
			};
		}

		return {
			record,
			outcome: "delete_expired",
			age_ms: age,
			ttl_ms: rule.ttl_ms,
			holds: [],
			detail: `past its ${Math.floor(rule.ttl_ms / 86_400_000)}d retention with no hold in force`,
		};
	});
}

export type DeletionRequest = {
	record_id: string;
	requested_by: string;
	reason: string;
};

export type DeletionOutcome =
	| { status: "deleted"; verified_locations: string[]; residue: string[] }
	| { status: "refused"; reason: string }
	| { status: "partial"; verified_locations: string[]; residue: string[]; reason: string };

/** A location the deleter can reach and confirm. */
export type LocationDeleter = {
	/** Location name, e.g. `sqlite`, `search_index`, `s3_export`. */
	location: string;
	/** Delete and then confirm absence. `false` means the row is still there. */
	deleteAndVerify(recordId: string): boolean;
};

export type DeletionReport = {
	request: DeletionRequest;
	outcome: DeletionOutcome;
	/** Locations no deleter covers. Known residue rather than assumed clean. */
	unreachable: string[];
	audit: {
		record_id: string;
		requested_by: string;
		reason: string;
		at_ms: number;
		status: DeletionOutcome["status"];
		detail: string;
	};
};

/**
 * Execute a deletion, verifying each location and accounting for the rest.
 *
 * Refuses outright when a hold is in force. Queueing the request instead would
 * report the deletion as accepted and perform it weeks later, once the hold
 * lifts, with nobody watching — which is worse than a refusal because it
 * produces a record that says the deletion happened on the wrong date.
 */
export function executeDeletion(
	request: DeletionRequest,
	record: GovernedRecord,
	holds: LegalHold[],
	deleters: LocationDeleter[],
	nowMs: number,
): DeletionReport {
	const applicable = holds.filter((hold) => holdApplies(hold, record, nowMs));
	const audit = (status: DeletionOutcome["status"], detail: string) => ({
		record_id: record.id,
		requested_by: request.requested_by,
		reason: request.reason,
		at_ms: nowMs,
		status,
		detail,
	});

	if (applicable.length > 0) {
		const detail = `refused: ${applicable.length} legal hold(s) in force (${applicable.map((h) => h.id).join(", ")}); the request is not queued, because a deferred deletion would be reported as complete and performed later unobserved`;
		return {
			request,
			outcome: { status: "refused", reason: detail },
			unreachable: [],
			audit: audit("refused", detail),
		};
	}

	const covered = new Map(deleters.map((d) => [d.location, d]));
	const verified: string[] = [];
	const residue: string[] = [];
	const unreachable: string[] = [];

	for (const location of record.locations) {
		const deleter = covered.get(location);
		if (!deleter) {
			unreachable.push(location);
			continue;
		}
		if (deleter.deleteAndVerify(record.id)) verified.push(location);
		else residue.push(location);
	}

	const allResidue = [...residue, ...unreachable];
	if (allResidue.length === 0) {
		const detail = `deleted and verified in ${verified.length} location(s)`;
		return {
			request,
			outcome: { status: "deleted", verified_locations: verified, residue: [] },
			unreachable: [],
			audit: audit("deleted", detail),
		};
	}

	const detail = `deleted from ${verified.length} location(s); ${allResidue.length} location(s) still hold a copy (${allResidue.join(", ")}) — this is known residue, not a clean deletion`;
	return {
		request,
		outcome: {
			status: "partial",
			verified_locations: verified,
			residue: allResidue,
			reason: detail,
		},
		unreachable,
		audit: audit("partial", detail),
	};
}

export type TenantQuery = {
	/** Absent means the caller did not scope the query, which is rejected. */
	tenant?: string;
	data_class?: GovernedDataClass;
	/** Explicit opt-in for a genuine cross-tenant operation. */
	cross_tenant?: { authorized_by: string; reason: string };
};

export type QueryResult<T> = { ok: true; rows: T[]; scope: string } | { ok: false; reason: string };

/**
 * Run a query with tenant isolation enforced.
 *
 * A query with no tenant and no explicit cross-tenant authorization is
 * **rejected**. Defaulting to all tenants is how a leak happens: the code that
 * forgot the predicate becomes indistinguishable from the code that meant to
 * scan everything, and only one of them is a bug.
 */
export function queryRecords(
	records: GovernedRecord[],
	query: TenantQuery,
): QueryResult<GovernedRecord> {
	if (!query.tenant && !query.cross_tenant) {
		return {
			ok: false,
			reason:
				"the query has no tenant predicate and no cross-tenant authorization; this is refused rather than defaulted to every tenant, because a forgotten predicate and a deliberate scan would otherwise look identical",
		};
	}
	if (query.cross_tenant) {
		if (!query.cross_tenant.authorized_by || !query.cross_tenant.reason) {
			return {
				ok: false,
				reason: "a cross-tenant query must name who authorized it and why",
			};
		}
		const rows = records.filter((r) => !query.data_class || r.data_class === query.data_class);
		return {
			ok: true,
			rows,
			scope: `cross-tenant, authorized by ${query.cross_tenant.authorized_by}: ${query.cross_tenant.reason}`,
		};
	}

	const rows = records.filter(
		(r) => r.tenant === query.tenant && (!query.data_class || r.data_class === query.data_class),
	);
	return { ok: true, rows, scope: `tenant '${query.tenant}'` };
}

export type GovernanceReport = {
	records: number;
	by_outcome: Record<RetentionOutcome, number>;
	/** Records past TTL that a hold is preserving, with the holds responsible. */
	held_past_retention: Array<{ record_id: string; overdue_days: number; holds: string[] }>;
	/** Holds with no lift date. */
	indefinite_holds: string[];
	/** Data classes with no rule at all. */
	ungoverned_classes: GovernedDataClass[];
	caveats: string[];
};

/**
 * Summarize governance state.
 *
 * The `held_past_retention` list is the important one: it is the gap between
 * the retention policy as written and the data as it exists, and it is the
 * number that a compliance statement must be reconciled against rather than
 * asserted over.
 */
export function governanceReport(
	decisions: RetentionDecision[],
	holds: LegalHold[],
	rules: Record<GovernedDataClass, RetentionRule> = DEFAULT_RETENTION,
): GovernanceReport {
	const byOutcome = Object.fromEntries(RETENTION_OUTCOMES.map((o) => [o, 0])) as Record<
		RetentionOutcome,
		number
	>;
	for (const decision of decisions) byOutcome[decision.outcome]++;

	const held = decisions
		.filter((d) => d.outcome === "retained_under_hold")
		.map((d) => ({
			record_id: d.record.id,
			overdue_days: Math.floor((d.age_ms - (d.ttl_ms ?? 0)) / 86_400_000),
			holds: d.holds,
		}))
		.sort((a, b) => b.overdue_days - a.overdue_days || a.record_id.localeCompare(b.record_id));

	const indefinite = holds.filter((h) => h.lifted_at_ms === undefined).map((h) => h.id);
	const ungoverned = DATA_CLASSES.filter((c) => !rules[c]);

	const caveats: string[] = [];
	if (held.length > 0) {
		caveats.push(
			`${held.length} record(s) are past their retention and preserved by legal hold; any statement of the form "we delete after N days" must be reconciled against this list rather than asserted over it`,
		);
	}
	if (indefinite.length > 0) {
		caveats.push(
			`${indefinite.length} hold(s) have no lift date (${indefinite.join(", ")}); an indefinite hold is a retention policy of "forever" for everything it covers`,
		);
	}
	if (byOutcome.no_rule > 0) {
		caveats.push(
			`${byOutcome.no_rule} record(s) belong to a class with no retention rule; they are kept by default, and a default is not a policy`,
		);
	}

	return {
		records: decisions.length,
		by_outcome: byOutcome,
		held_past_retention: held,
		indefinite_holds: indefinite,
		ungoverned_classes: ungoverned,
		caveats,
	};
}
