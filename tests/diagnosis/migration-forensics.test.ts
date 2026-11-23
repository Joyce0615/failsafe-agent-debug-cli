/**
 * Protocol-deprecation migration forensics tests (item 59 — pair
 * legacy and current MCP traces and classify MRTR, result type,
 * stateless metadata, subscription, and SSE-resume differences as
 * client assumption, server nonconformance, or SDK translation
 * defects).
 */
import { describe, expect, test } from "bun:test";
import {
	type MigrationObservation,
	classifyMigrationDivergence,
	diagnoseMigrationForensics,
	renderMigrationForensicsReport,
} from "../../src/diagnosis/migration-forensics.js";

function observation(overrides: Partial<MigrationObservation>): MigrationObservation {
	return {
		operation_id: "op-1",
		dimension: "mrtr",
		current_behavior: "stalled",
		spec_expected_behavior: "resumed",
		client_sent_legacy_shape: false,
		server_replied_legacy_shape: false,
		...overrides,
	};
}

describe("classifyMigrationDivergence", () => {
	test("returns null when current behavior already matches spec expectation", () => {
		const obs = observation({
			current_behavior: "resumed",
			spec_expected_behavior: "resumed",
		});
		expect(classifyMigrationDivergence(obs)).toBeNull();
	});

	test("client_assumption: client legacy, server current", () => {
		const obs = observation({
			client_sent_legacy_shape: true,
			server_replied_legacy_shape: false,
		});
		const finding = classifyMigrationDivergence(obs);
		expect(finding?.attribution).toBe("client_assumption");
	});

	test("server_nonconformance: server legacy, client current", () => {
		const obs = observation({
			client_sent_legacy_shape: false,
			server_replied_legacy_shape: true,
		});
		const finding = classifyMigrationDivergence(obs);
		expect(finding?.attribution).toBe("server_nonconformance");
	});

	test("insufficient_evidence: both legacy", () => {
		const obs = observation({
			client_sent_legacy_shape: true,
			server_replied_legacy_shape: true,
		});
		const finding = classifyMigrationDivergence(obs);
		expect(finding?.attribution).toBe("insufficient_evidence");
	});

	test("sdk_translation_defect: both current shapes yet behavior still diverges", () => {
		const obs = observation({
			client_sent_legacy_shape: false,
			server_replied_legacy_shape: false,
		});
		const finding = classifyMigrationDivergence(obs);
		expect(finding?.attribution).toBe("sdk_translation_defect");
	});

	test("finding carries operation_id, dimension, and both behaviors", () => {
		const obs = observation({
			operation_id: "op-42",
			dimension: "subscription",
			current_behavior: "lost",
			spec_expected_behavior: "delivered",
			server_replied_legacy_shape: true,
		});
		const finding = classifyMigrationDivergence(obs);
		expect(finding).toMatchObject({
			operation_id: "op-42",
			dimension: "subscription",
			current_behavior: "lost",
			spec_expected_behavior: "delivered",
		});
	});
});

describe("diagnoseMigrationForensics", () => {
	test("groups findings and migrated_cleanly dimensions by operation_id", () => {
		const observations = [
			observation({
				operation_id: "op-1",
				dimension: "mrtr",
				current_behavior: "stalled",
				spec_expected_behavior: "resumed",
				client_sent_legacy_shape: true,
			}),
			observation({
				operation_id: "op-1",
				dimension: "result_type",
				current_behavior: "typed",
				spec_expected_behavior: "typed",
			}),
		];
		const reports = diagnoseMigrationForensics(observations);
		expect(reports.length).toBe(1);
		expect(reports[0].operation_id).toBe("op-1");
		expect(reports[0].findings.length).toBe(1);
		expect(reports[0].migrated_cleanly).toEqual(["result_type"]);
		expect(reports[0].dimensions_analyzed).toBe(2);
	});

	test("separates reports by distinct operation_id, sorted", () => {
		const observations = [
			observation({ operation_id: "op-b", dimension: "sse_resume" }),
			observation({ operation_id: "op-a", dimension: "stateless_metadata" }),
		];
		const reports = diagnoseMigrationForensics(observations);
		expect(reports.map((r) => r.operation_id)).toEqual(["op-a", "op-b"]);
	});

	test("a dimension succeeding on one operation does not suppress a failing dimension on another", () => {
		const observations = [
			observation({
				operation_id: "op-1",
				dimension: "mrtr",
				current_behavior: "resumed",
				spec_expected_behavior: "resumed",
			}),
			observation({
				operation_id: "op-1",
				dimension: "subscription",
				current_behavior: "lost",
				spec_expected_behavior: "delivered",
				server_replied_legacy_shape: true,
			}),
		];
		const [report] = diagnoseMigrationForensics(observations);
		expect(report.migrated_cleanly).toEqual(["mrtr"]);
		expect(report.findings.length).toBe(1);
		expect(report.findings[0].dimension).toBe("subscription");
	});
});

describe("renderMigrationForensicsReport", () => {
	test("renders operation headers, dimensions_analyzed, and findings", () => {
		const observations = [
			observation({
				operation_id: "op-1",
				dimension: "mrtr",
				client_sent_legacy_shape: true,
			}),
		];
		const reports = diagnoseMigrationForensics(observations);
		const text = renderMigrationForensicsReport(reports);
		expect(text).toContain("Operation 'op-1'");
		expect(text).toContain("client_assumption");
	});
});
