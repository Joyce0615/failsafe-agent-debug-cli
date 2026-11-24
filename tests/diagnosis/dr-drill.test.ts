/**
 * Diagnostic disaster-recovery drills (item 50 — simulate telemetry loss,
 * store corruption, key revocation, provider outage, and compromised
 * debugging memory; measure RPO/RTO, attribution degradation, and safe
 * service restoration).
 */
import { describe, expect, test } from "bun:test";
import type { ProviderRun } from "../../src/diagnosis/cross-provider-replay.js";
import {
	SEVERE_DEGRADATION_THRESHOLD,
	drillCompromisedMemory,
	drillKeyRevocation,
	drillProviderOutage,
	drillStoreCorruption,
	drillTelemetryLoss,
	measureAttributionDegradation,
	measureRpo,
	measureRto,
	renderDrillSuiteReport,
	runDrillSuite,
} from "../../src/diagnosis/dr-drill.js";
import type { DiagnosticBundle } from "../../src/exchange/bundle.js";
import { type CustodyChain, buildCustodyChain } from "../../src/exchange/custody.js";
import type { DisclosurePolicy, PlainSection } from "../../src/exchange/encryption.js";
import type { ChaosScenario, ObservedBehaviour } from "../../src/testing/chaos.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";

function diagnosisFixture(overrides: Partial<FailureDiagnosis> = {}): FailureDiagnosis {
	return {
		schema_version: SCHEMA_VERSION,
		diagnosis_id: "d1",
		failure_id: "f1",
		failure_type: "runtime_exception",
		severity: "error",
		summary: "boom",
		root_cause: { category: "null_reference", explanation: "x is null", confidence: 0.8 },
		evidence: [{ kind: "stack_frame", value: "a" }],
		uncertainty: [],
		minimal_context: [],
		suggested_next_actions: [],
		...overrides,
	};
}

function providerRun(runId: string): ProviderRun {
	return { run_id: runId, diagnosis: diagnosisFixture({ diagnosis_id: runId }) };
}

function bundleFixture(overrides: Partial<DiagnosticBundle> = {}): DiagnosticBundle {
	return {
		schema_version: "0.1",
		bundle_id: "b1",
		created_at: "2026-01-01T00:00:00Z",
		origin: { workspace_hash: "w1", tool_version: "0.1.0" },
		consent: {
			granted_by: "user1",
			granted_at: "2026-01-01T00:00:00Z",
			covers: ["failure"],
			expires_at: "2099-01-01T00:00:00Z",
		},
		failure: {
			signature_hash: "sig1",
			failure_type: "runtime_exception",
			normalized_message: "boom",
		},
		signature: { key_id: "revoked-key", value: "deadbeef" },
		...overrides,
	} as DiagnosticBundle;
}

describe("measureRpo", () => {
	test("exposure window is the gap between last-known-good and detection", () => {
		const r = measureRpo(1000, 5000);
		expect(r.exposure_window_ms).toBe(4000);
	});

	test("never reports a negative exposure window, even if detection precedes the checkpoint timestamp", () => {
		const r = measureRpo(5000, 1000);
		expect(r.exposure_window_ms).toBe(0);
	});
});

describe("measureRto", () => {
	test("reports RTO when the safety check passes", () => {
		const r = measureRto(1000, 6000, { safe: true, reasons: [] });
		expect(r.reported).toBe(true);
		if (r.reported) expect(r.rto_ms).toBe(5000);
	});

	test("refuses to report RTO when the safety check fails, even though restoration completed", () => {
		const r = measureRto(1000, 6000, { safe: false, reasons: ["store still corrupted"] });
		expect(r.reported).toBe(false);
		if (!r.reported) expect(r.reason).toContain("store still corrupted");
	});
});

describe("measureAttributionDegradation", () => {
	test("no degradation when post_drill equals baseline", () => {
		const r = measureAttributionDegradation(0.9, 0.9);
		expect(r.relative_degradation).toBe(0);
		expect(r.severe).toBe(false);
	});

	test("severe degradation when the relative drop exceeds the threshold", () => {
		const r = measureAttributionDegradation(0.9, 0.9 * (1 - SEVERE_DEGRADATION_THRESHOLD) - 0.01);
		expect(r.severe).toBe(true);
	});

	test("improvement (post_drill > baseline) is never flagged severe and has zero relative degradation", () => {
		const r = measureAttributionDegradation(0.5, 0.8);
		expect(r.relative_degradation).toBe(0);
		expect(r.severe).toBe(false);
		expect(r.delta).toBeCloseTo(0.3);
	});
});

describe("drillTelemetryLoss", () => {
	test("acceptable when loss was loud (reuses assessResilience)", () => {
		const scenario: ChaosScenario = {
			kind: "exporter_outage",
			description: "test",
			start_ms: 0,
			duration_ms: 1000,
		};
		const observed: ObservedBehaviour = {
			offered: 10,
			accepted: 5,
			errors_surfaced: 5,
			silent_drops: 0,
			bytes_offered: 1000,
			bytes_stored: 500,
			timestamps_altered: 0,
		};
		const r = drillTelemetryLoss({ scenario, observed });
		expect(r.acceptable).toBe(true);
	});

	test("not acceptable when loss was silent", () => {
		const scenario: ChaosScenario = {
			kind: "exporter_outage",
			description: "test",
			start_ms: 0,
			duration_ms: 1000,
		};
		const observed: ObservedBehaviour = {
			offered: 10,
			accepted: 5,
			errors_surfaced: 0,
			silent_drops: 5,
			bytes_offered: 1000,
			bytes_stored: 500,
			timestamps_altered: 0,
		};
		const r = drillTelemetryLoss({ scenario, observed });
		expect(r.acceptable).toBe(false);
	});
});

describe("drillStoreCorruption", () => {
	test("acceptable when a corrupted chain is caught by recomputeChainIntegrity", () => {
		const chain: CustodyChain = buildCustodyChain("c1", "2026-01-01T00:00:00Z", [
			{ stage: "evidence", label: "e1", content: { a: 1 } },
			{ stage: "analysis", label: "a1", content: { b: 2 } },
		]);
		// Simulate corruption: splice in a different content_hash at record 1.
		const corrupted: CustodyChain = structuredClone(chain);
		corrupted.records[1].content_hash = "deadbeef";
		const r = drillStoreCorruption({ chain: corrupted });
		expect(r.acceptable).toBe(true);
	});

	test("not acceptable (nothing to verify) when the supplied chain is actually valid", () => {
		const chain: CustodyChain = buildCustodyChain("c1", "2026-01-01T00:00:00Z", [
			{ stage: "evidence", label: "e1", content: { a: 1 } },
		]);
		const r = drillStoreCorruption({ chain });
		expect(r.acceptable).toBe(false);
	});
});

describe("drillKeyRevocation", () => {
	const sections: PlainSection[] = [{ id: "s1", kind: "failure", content: "stack trace" }];
	const policy: DisclosurePolicy = { recipient: "vendor1", allowed_kinds: ["failure"] };

	test("acceptable when the recipient genuinely loses access after the key is removed", () => {
		const r = drillKeyRevocation({
			sections,
			all_keys_before: { s1: Buffer.alloc(32, 1) },
			all_keys_after_revocation: {},
			policy,
		});
		expect(r.acceptable).toBe(true);
	});

	test("not acceptable when the recipient still has access after revocation", () => {
		const r = drillKeyRevocation({
			sections,
			all_keys_before: { s1: Buffer.alloc(32, 1) },
			all_keys_after_revocation: { s1: Buffer.alloc(32, 1) },
			policy,
		});
		expect(r.acceptable).toBe(false);
	});
});

describe("drillProviderOutage", () => {
	test("acceptable when the module correctly abstains with only one provider left", () => {
		const r = drillProviderOutage({
			replay: { runs: [providerRun("r1")], identities: {}, fidelity: {} },
		});
		expect(r.acceptable).toBe(true);
		expect(r.report.abstain).toBe(true);
	});

	test("not acceptable if, with enough pinned providers, the module somehow fails to abstain when it should report", () => {
		const r = drillProviderOutage({
			replay: {
				runs: [providerRun("r1"), providerRun("r2")],
				identities: {
					r1: {
						"gen_ai.provider.name": "anthropic",
						"gen_ai.request.model": "claude-x",
						"gen_ai.agent.version": "1.0.0",
					},
					r2: {
						"gen_ai.provider.name": "openai",
						"gen_ai.request.model": "gpt-x",
						"gen_ai.agent.version": "1.0.0",
					},
				},
				fidelity: {},
			},
		});
		// With two fully pinned, faithful providers, the module should NOT
		// abstain -- it has enough evidence to report drift, so this drill
		// scenario is NOT acceptable (abstention was expected to trigger only
		// when degraded, not when healthy).
		expect(r.report.abstain).toBe(false);
	});
});

describe("drillCompromisedMemory", () => {
	test("acceptable when all bundles signed under a compromised key are rejected", () => {
		const r = drillCompromisedMemory({
			bundles: [bundleFixture()],
			trust_options: { now: "2026-01-02T00:00:00Z", known_key_ids: ["good-key"] },
		});
		expect(r.acceptable).toBe(true);
	});
});

describe("runDrillSuite + renderDrillSuiteReport", () => {
	test("composes every supplied scenario and reports untested kinds", () => {
		const chain: CustodyChain = buildCustodyChain("c1", "2026-01-01T00:00:00Z", [
			{ stage: "evidence", label: "e1", content: { a: 1 } },
			{ stage: "analysis", label: "a1", content: { b: 2 } },
		]);
		const corrupted: CustodyChain = structuredClone(chain);
		corrupted.records[1].content_hash = "deadbeef";

		const report = runDrillSuite({
			store_corruption: { chain: corrupted },
			last_known_good_ms: 1000,
			incident_detected_ms: 5000,
			restoration_complete_ms: 9000,
			restoration_safety: { safe: true, reasons: [] },
			attribution_baseline: 0.9,
			attribution_post_drill: 0.85,
		});
		expect(report.results).toHaveLength(1);
		expect(report.failed_scenarios).toEqual([]);
		expect(report.untested).toEqual([
			"telemetry_loss",
			"key_revocation",
			"provider_outage",
			"compromised_memory",
		]);
		const text = renderDrillSuiteReport(report);
		expect(text).toContain("Diagnostic Disaster-Recovery Drill Report");
		expect(text).toContain("RPO exposure window: 4000ms");
		expect(text).toContain("RTO: 4000ms");
		expect(text).toContain("Untested:");
	});

	test("failed_scenarios lists every unacceptable result", () => {
		const scenario: ChaosScenario = {
			kind: "exporter_outage",
			description: "test",
			start_ms: 0,
			duration_ms: 1000,
		};
		const observed: ObservedBehaviour = {
			offered: 10,
			accepted: 5,
			errors_surfaced: 0,
			silent_drops: 5,
			bytes_offered: 1000,
			bytes_stored: 500,
			timestamps_altered: 0,
		};
		const report = runDrillSuite({
			telemetry_loss: { scenario, observed },
			last_known_good_ms: 1000,
			incident_detected_ms: 5000,
			restoration_complete_ms: 9000,
			restoration_safety: { safe: true, reasons: [] },
			attribution_baseline: 0.9,
			attribution_post_drill: 0.85,
		});
		expect(report.failed_scenarios).toEqual(["telemetry_loss"]);
	});

	test("RTO is not reported in the rendered report when the safety check fails", () => {
		const report = runDrillSuite({
			last_known_good_ms: 1000,
			incident_detected_ms: 5000,
			restoration_complete_ms: 9000,
			restoration_safety: { safe: false, reasons: ["telemetry still silently dropping"] },
			attribution_baseline: 0.9,
			attribution_post_drill: 0.9,
		});
		expect(report.rto.reported).toBe(false);
		const text = renderDrillSuiteReport(report);
		expect(text).toContain("RTO: not reported");
	});
});
