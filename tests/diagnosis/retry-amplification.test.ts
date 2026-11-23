/**
 * Retry-induced fault persistence and amplification tests (item 58 —
 * compare causal signatures before and after retries, identify blind
 * replication and expanding cascade radius, and avoid counting
 * repeated symptoms as independent root causes).
 */
import { describe, expect, test } from "bun:test";
import type { Incident } from "../../src/diagnosis/incident-clustering.js";
import {
	type RetryAttempt,
	diagnoseRetryPersistence,
	renderRetryPersistenceReport,
} from "../../src/diagnosis/retry-amplification.js";

function incident(overrides: Partial<Incident>): Incident {
	return {
		id: "inc-1",
		cause_category: "timeout",
		component: "svc-a",
		causal_path: ["api", "svc-a"],
		message: "deadline exceeded",
		occurred_at_ms: 1000,
		...overrides,
	};
}

function attempt(overrides: Partial<RetryAttempt>): RetryAttempt {
	return {
		attempt_id: "a1",
		sequence: 0,
		incident: incident({}),
		blast_radius: 1,
		...overrides,
	};
}

describe("diagnoseRetryPersistence: abstention", () => {
	test("abstains with fewer than MIN_ATTEMPTS_TO_COMPARE attempts", () => {
		const report = diagnoseRetryPersistence([attempt({ attempt_id: "a1" })]);
		expect(report.confidence).toBe("abstained");
		expect(report.findings).toEqual([]);
	});

	test("abstains with zero attempts", () => {
		const report = diagnoseRetryPersistence([]);
		expect(report.confidence).toBe("abstained");
	});
});

describe("diagnoseRetryPersistence: blind_replication", () => {
	test("detects identical causal signature across consecutive attempts", () => {
		const attempts = [
			attempt({ attempt_id: "a1", sequence: 0, incident: incident({ id: "inc-1" }), blast_radius: 1 }),
			attempt({ attempt_id: "a2", sequence: 1, incident: incident({ id: "inc-2" }), blast_radius: 1 }),
		];
		const report = diagnoseRetryPersistence(attempts);
		expect(report.confidence).toBe("full");
		const blind = report.findings.filter((f) => f.kind === "blind_replication");
		expect(blind.length).toBe(1);
		expect(blind[0]).toMatchObject({ from_attempt_id: "a1", to_attempt_id: "a2" });
	});

	test("deflates naive_root_cause_count to corrected_root_cause_count when the fault persists", () => {
		const attempts = [
			attempt({ attempt_id: "a1", sequence: 0, incident: incident({ id: "inc-1" }), blast_radius: 1 }),
			attempt({ attempt_id: "a2", sequence: 1, incident: incident({ id: "inc-2" }), blast_radius: 1 }),
			attempt({ attempt_id: "a3", sequence: 2, incident: incident({ id: "inc-3" }), blast_radius: 1 }),
		];
		const report = diagnoseRetryPersistence(attempts);
		expect(report.naive_root_cause_count).toBe(3);
		expect(report.corrected_root_cause_count).toBe(1);
	});

	test("does not report blind_replication when causal signatures differ", () => {
		const attempts = [
			attempt({
				attempt_id: "a1",
				sequence: 0,
				incident: incident({ id: "inc-1", cause_category: "timeout" }),
				blast_radius: 1,
			}),
			attempt({
				attempt_id: "a2",
				sequence: 1,
				incident: incident({ id: "inc-2", cause_category: "auth_failure" }),
				blast_radius: 1,
			}),
		];
		const report = diagnoseRetryPersistence(attempts);
		expect(report.findings.filter((f) => f.kind === "blind_replication")).toEqual([]);
		expect(report.corrected_root_cause_count).toBe(2);
	});
});

describe("diagnoseRetryPersistence: cascade_amplification", () => {
	test("detects a strictly growing blast radius between consecutive attempts", () => {
		const attempts = [
			attempt({
				attempt_id: "a1",
				sequence: 0,
				incident: incident({ id: "inc-1", cause_category: "timeout" }),
				blast_radius: 1,
			}),
			attempt({
				attempt_id: "a2",
				sequence: 1,
				incident: incident({ id: "inc-2", cause_category: "rate_limit" }),
				blast_radius: 4,
			}),
		];
		const report = diagnoseRetryPersistence(attempts);
		const cascade = report.findings.filter((f) => f.kind === "cascade_amplification");
		expect(cascade.length).toBe(1);
		expect(cascade[0]).toMatchObject({ from_blast_radius: 1, to_blast_radius: 4 });
	});

	test("does not report cascade_amplification when blast radius shrinks or stays equal", () => {
		const attempts = [
			attempt({ attempt_id: "a1", sequence: 0, incident: incident({ id: "inc-1" }), blast_radius: 3 }),
			attempt({ attempt_id: "a2", sequence: 1, incident: incident({ id: "inc-2" }), blast_radius: 3 }),
			attempt({ attempt_id: "a3", sequence: 2, incident: incident({ id: "inc-3" }), blast_radius: 2 }),
		];
		const report = diagnoseRetryPersistence(attempts);
		expect(report.findings.filter((f) => f.kind === "cascade_amplification")).toEqual([]);
	});

	test("reports both blind_replication and cascade_amplification independently for the same pair", () => {
		const attempts = [
			attempt({ attempt_id: "a1", sequence: 0, incident: incident({ id: "inc-1" }), blast_radius: 1 }),
			attempt({ attempt_id: "a2", sequence: 1, incident: incident({ id: "inc-2" }), blast_radius: 5 }),
		];
		const report = diagnoseRetryPersistence(attempts);
		expect(report.findings.some((f) => f.kind === "blind_replication")).toBe(true);
		expect(report.findings.some((f) => f.kind === "cascade_amplification")).toBe(true);
	});
});

describe("diagnoseRetryPersistence: sequencing", () => {
	test("sorts attempts by sequence before comparing, regardless of input order", () => {
		const attempts = [
			attempt({ attempt_id: "a2", sequence: 1, incident: incident({ id: "inc-2" }), blast_radius: 2 }),
			attempt({ attempt_id: "a1", sequence: 0, incident: incident({ id: "inc-1" }), blast_radius: 1 }),
		];
		const report = diagnoseRetryPersistence(attempts);
		const cascade = report.findings.find((f) => f.kind === "cascade_amplification");
		expect(cascade).toMatchObject({ from_attempt_id: "a1", to_attempt_id: "a2" });
	});
});

describe("renderRetryPersistenceReport", () => {
	test("renders confidence, counts, and findings", () => {
		const attempts = [
			attempt({ attempt_id: "a1", sequence: 0, incident: incident({ id: "inc-1" }), blast_radius: 1 }),
			attempt({ attempt_id: "a2", sequence: 1, incident: incident({ id: "inc-2" }), blast_radius: 1 }),
		];
		const report = diagnoseRetryPersistence(attempts);
		const text = renderRetryPersistenceReport(report);
		expect(text).toContain("confidence: full");
		expect(text).toContain("blind_replication");
	});
});
