import { describe, expect, test } from "bun:test";
import {
	DATA_CLASSES,
	DEFAULT_RETENTION,
	type GovernedRecord,
	type LegalHold,
	type LocationDeleter,
	RETENTION_OUTCOMES,
	executeDeletion,
	governanceReport,
	holdApplies,
	planRetention,
	queryRecords,
} from "../../src/storage/governance.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function record(overrides: Partial<GovernedRecord> & { id: string }): GovernedRecord {
	return {
		tenant: "acme",
		data_class: "failure_output",
		created_at_ms: NOW - 60 * DAY,
		locations: ["sqlite"],
		...overrides,
	};
}

function hold(overrides: Partial<LegalHold> & { id: string }): LegalHold {
	return {
		tenants: [],
		data_classes: [],
		placed_at_ms: NOW - 90 * DAY,
		reason: "litigation",
		...overrides,
	};
}

function deleter(location: string, succeeds = true): LocationDeleter {
	return { location, deleteAndVerify: () => succeeds };
}

describe("hold applicability", () => {
	test("an unscoped hold covers everything", () => {
		expect(holdApplies(hold({ id: "h1" }), record({ id: "r1" }), NOW)).toBe(true);
	});

	test("a tenant-scoped hold covers only its tenants", () => {
		const scoped = hold({ id: "h1", tenants: ["other"] });
		expect(holdApplies(scoped, record({ id: "r1" }), NOW)).toBe(false);
		expect(holdApplies(scoped, record({ id: "r1", tenant: "other" }), NOW)).toBe(true);
	});

	test("a class-scoped hold covers only its classes", () => {
		const scoped = hold({ id: "h1", data_classes: ["trace"] });
		expect(holdApplies(scoped, record({ id: "r1" }), NOW)).toBe(false);
		expect(holdApplies(scoped, record({ id: "r1", data_class: "trace" }), NOW)).toBe(true);
	});

	test("a hold does not apply before it was placed or after it lifts", () => {
		const window = hold({ id: "h1", placed_at_ms: NOW - DAY, lifted_at_ms: NOW + DAY });
		expect(holdApplies(window, record({ id: "r1" }), NOW - 2 * DAY)).toBe(false);
		expect(holdApplies(window, record({ id: "r1" }), NOW)).toBe(true);
		expect(holdApplies(window, record({ id: "r1" }), NOW + 2 * DAY)).toBe(false);
	});
});

describe("legal hold beats retention and the conflict is recorded", () => {
	test("an expired record with no hold is deletable", () => {
		const [decision] = planRetention([record({ id: "r1" })], [], NOW);
		expect(decision.outcome).toBe("delete_expired");
	});

	test("an expired record under hold is a distinct outcome, not 'retained'", () => {
		const [decision] = planRetention([record({ id: "r1" })], [hold({ id: "h1" })], NOW);
		expect(decision.outcome).toBe("retained_under_hold");
		expect(decision.holds).toEqual(["h1"]);
		expect(decision.detail).toContain("preserved by 1 legal hold");
	});

	test("a record within its TTL is not confused with one under hold", () => {
		const [decision] = planRetention(
			[record({ id: "r1", created_at_ms: NOW - DAY })],
			[hold({ id: "h1" })],
			NOW,
		);
		expect(decision.outcome).toBe("retain_within_ttl");
		expect(decision.holds).toEqual([]);
	});

	test("a class with no rule is reported as ungoverned rather than kept quietly", () => {
		// A rule set that genuinely lacks an entry, which is the state a new data
		// class arrives in before anyone writes a policy for it.
		const rules = Object.fromEntries(
			Object.entries(DEFAULT_RETENTION).filter(([key]) => key !== "failure_output"),
		) as typeof DEFAULT_RETENTION;
		const [decision] = planRetention([record({ id: "r1" })], [], NOW, rules);
		expect(decision.outcome).toBe("no_rule");
		expect(decision.detail).toContain("that default is not a policy");
	});

	test("every outcome is a declared member of the vocabulary", () => {
		for (const decision of planRetention([record({ id: "r1" })], [hold({ id: "h1" })], NOW)) {
			expect(RETENTION_OUTCOMES).toContain(decision.outcome);
		}
	});
});

describe("deletion is verified, not requested", () => {
	const request = { record_id: "r1", requested_by: "operator", reason: "user request" };

	test("a fully verified deletion reports no residue", () => {
		const report = executeDeletion(
			request,
			record({ id: "r1", locations: ["sqlite", "search_index"] }),
			[],
			[deleter("sqlite"), deleter("search_index")],
			NOW,
		);
		expect(report.outcome.status).toBe("deleted");
		expect(report.unreachable).toEqual([]);
	});

	test("a location the deleter cannot reach is known residue, not assumed clean", () => {
		const report = executeDeletion(
			request,
			record({ id: "r1", locations: ["sqlite", "s3_export"] }),
			[],
			[deleter("sqlite")],
			NOW,
		);
		expect(report.outcome.status).toBe("partial");
		expect(report.unreachable).toEqual(["s3_export"]);
		if (report.outcome.status === "partial") {
			expect(report.outcome.reason).toContain("known residue, not a clean deletion");
		}
	});

	test("a delete that does not verify counts as residue", () => {
		const report = executeDeletion(
			request,
			record({ id: "r1", locations: ["sqlite"] }),
			[],
			[deleter("sqlite", false)],
			NOW,
		);
		expect(report.outcome.status).toBe("partial");
		if (report.outcome.status === "partial") {
			expect(report.outcome.residue).toEqual(["sqlite"]);
		}
	});

	test("a deletion under hold is refused, not queued", () => {
		const report = executeDeletion(
			request,
			record({ id: "r1" }),
			[hold({ id: "h1" })],
			[deleter("sqlite")],
			NOW,
		);
		expect(report.outcome.status).toBe("refused");
		if (report.outcome.status === "refused") {
			expect(report.outcome.reason).toContain("not queued");
			expect(report.outcome.reason).toContain("performed later unobserved");
		}
	});

	test("every outcome produces an audit entry naming who and why", () => {
		for (const holds of [[], [hold({ id: "h1" })]]) {
			const report = executeDeletion(request, record({ id: "r1" }), holds, [deleter("sqlite")], NOW);
			expect(report.audit.requested_by).toBe("operator");
			expect(report.audit.reason).toBe("user request");
			expect(report.audit.at_ms).toBe(NOW);
			expect(report.audit.detail.length).toBeGreaterThan(10);
		}
	});

	test("a record with no locations deletes trivially and says so", () => {
		const report = executeDeletion(request, record({ id: "r1", locations: [] }), [], [], NOW);
		expect(report.outcome.status).toBe("deleted");
	});
});

describe("tenant isolation is enforced, not conventional", () => {
	const records = [
		record({ id: "a", tenant: "acme" }),
		record({ id: "b", tenant: "globex" }),
		record({ id: "c", tenant: "acme", data_class: "trace" }),
	];

	test("a query with no tenant is refused rather than scanning everything", () => {
		const result = queryRecords(records, {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("would otherwise look identical");
	});

	test("a scoped query returns only that tenant", () => {
		const result = queryRecords(records, { tenant: "acme" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows.map((r) => r.id).sort()).toEqual(["a", "c"]);
			expect(result.scope).toContain("acme");
		}
	});

	test("a class filter narrows within the tenant", () => {
		const result = queryRecords(records, { tenant: "acme", data_class: "trace" });
		expect(result.ok && result.rows.map((r) => r.id)).toEqual(["c"]);
	});

	test("a cross-tenant query requires an authorizer and a reason", () => {
		expect(
			queryRecords(records, { cross_tenant: { authorized_by: "", reason: "x" } }).ok,
		).toBe(false);
		expect(
			queryRecords(records, { cross_tenant: { authorized_by: "dpo", reason: "" } }).ok,
		).toBe(false);
	});

	test("an authorized cross-tenant query works and records its authorization", () => {
		const result = queryRecords(records, {
			cross_tenant: { authorized_by: "dpo", reason: "regulator request" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toHaveLength(3);
			expect(result.scope).toContain("dpo");
			expect(result.scope).toContain("regulator request");
		}
	});

	test("a tenant with no records returns empty rather than falling back", () => {
		const result = queryRecords(records, { tenant: "nobody" });
		expect(result.ok && result.rows).toEqual([]);
	});
});

describe("the governance report", () => {
	test("held-past-retention records are listed with how overdue they are", () => {
		const decisions = planRetention(
			[record({ id: "r1", created_at_ms: NOW - 100 * DAY })],
			[hold({ id: "h1" })],
			NOW,
		);
		const report = governanceReport(decisions, [hold({ id: "h1" })]);
		expect(report.held_past_retention).toHaveLength(1);
		expect(report.held_past_retention[0].overdue_days).toBe(70);
		expect(report.caveats.some((c) => c.includes("must be reconciled against this list"))).toBe(
			true,
		);
	});

	test("an indefinite hold is called a retention policy of forever", () => {
		const report = governanceReport([], [hold({ id: "h1" })]);
		expect(report.indefinite_holds).toEqual(["h1"]);
		expect(report.caveats.some((c) => c.includes('retention policy of "forever"'))).toBe(true);
	});

	test("a lifted hold is not counted as indefinite", () => {
		const report = governanceReport([], [hold({ id: "h1", lifted_at_ms: NOW })]);
		expect(report.indefinite_holds).toEqual([]);
	});

	test("outcome counts cover every record", () => {
		const decisions = planRetention(
			[
				record({ id: "r1" }),
				record({ id: "r2", created_at_ms: NOW - DAY }),
				record({ id: "r3" }),
			],
			[hold({ id: "h1", tenants: ["acme"], data_classes: ["failure_output"] })],
			NOW,
		);
		const report = governanceReport(decisions, []);
		const total = Object.values(report.by_outcome).reduce((a, b) => a + b, 0);
		expect(total).toBe(3);
		expect(report.records).toBe(3);
	});

	test("every governed class has a default rule", () => {
		const report = governanceReport([], []);
		expect(report.ungoverned_classes).toEqual([]);
		for (const cls of DATA_CLASSES) expect(DEFAULT_RETENTION[cls]).toBeDefined();
	});

	test("an empty state reports zeros without caveats", () => {
		const report = governanceReport([], []);
		expect(report.records).toBe(0);
		expect(report.caveats).toEqual([]);
	});
});
