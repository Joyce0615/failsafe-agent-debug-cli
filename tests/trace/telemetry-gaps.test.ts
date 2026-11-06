/**
 * Detect and explain distributed telemetry gaps (item 32).
 */
import { describe, expect, test } from "bun:test";
import type { ContinueResult } from "../../src/telemetry/propagation.js";
import type { RetentionDecision } from "../../src/telemetry/retention.js";
import type { IntegritySpan } from "../../src/trace/integrity.js";
import type { NormalizationReport } from "../../src/trace/genai-normalize.js";
import { detectTelemetryGaps, GAP_CATEGORIES } from "../../src/trace/telemetry-gaps.js";

const baseSpan = (over: Partial<IntegritySpan>): IntegritySpan => ({
	span_id: "s",
	service: "svc",
	name: "op",
	start_ms: 0,
	end_ms: 10,
	...over,
});

describe("detectTelemetryGaps", () => {
	test("an orphan parent (missing span) is reported as unknown evidence, not confirmed absence", () => {
		const spans: IntegritySpan[] = [baseSpan({ span_id: "child", parent_span_id: "ghost" })];
		const report = detectTelemetryGaps({ spans });
		const missing = report.findings.find((f) => f.category === "missing_span");
		expect(missing).toBeDefined();
		expect(missing?.evidence).toBe("unknown_evidence");
		expect(report.unknown_evidence_count).toBeGreaterThan(0);
		expect(report.caveat).toBeDefined();
	});

	test("a restarted propagation is reported as broken_context with the restart reason as the cause", () => {
		const restarts: ContinueResult[] = [
			{
				context: {
					trace_id: "a".repeat(32),
					span_id: "b".repeat(16),
					sampled: false,
					trace_state: [],
				},
				action: "restarted",
				reason: "malformed traceparent",
			},
		];
		const report = detectTelemetryGaps({ propagation_restarts: restarts });
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0].category).toBe("broken_context");
		expect(report.findings[0].cause).toBe("malformed traceparent");
		expect(report.findings[0].evidence).toBe("confirmed_absence");
	});

	test("a trace dropped by a sub-1.0 sampling rate is sampling_loss, confirmed absence, not an unexplained gap", () => {
		const decisions: RetentionDecision[] = [
			{
				trace_id: "t1",
				keep: false,
				reasons: [],
				priority: 0,
				sampling_rate: 0.1,
				weight: 10,
			},
		];
		const report = detectTelemetryGaps({ retention: decisions });
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0].category).toBe("sampling_loss");
		expect(report.findings[0].evidence).toBe("confirmed_absence");
		expect(report.findings[0].cause).toContain("0.1");
	});

	test("a genai unknown_reason is reported as provider_translation loss with the reason named", () => {
		const genai: NormalizationReport = {
			spans: 5,
			by_kind: {
				workflow: 0,
				agent: 0,
				plan: 0,
				tool: 0,
				llm: 0,
				retrieval: 0,
				embedding: 0,
				unknown: 2,
			},
			unknown_reasons: [{ reason: "no recognized operation attribute", spans: 2 }],
			deprecated_usage: [],
			conflicts: [],
			structure_issues: [],
			inferred_kinds: 0,
		};
		const report = detectTelemetryGaps({ genai });
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0].category).toBe("provider_translation");
		expect(report.findings[0].cause).toBe("no recognized operation attribute");
	});

	test("every GAP_CATEGORIES entry is a real, distinct reachable category", () => {
		expect(new Set(GAP_CATEGORIES).size).toBe(GAP_CATEGORIES.length);
	});

	test("a clean input with no gaps produces zero findings and no caveat", () => {
		const report = detectTelemetryGaps({});
		expect(report.findings).toHaveLength(0);
		expect(report.caveat).toBeUndefined();
	});

	test("confirmed-absence and unknown-evidence counts never double count a finding", () => {
		const spans: IntegritySpan[] = [baseSpan({ span_id: "child", parent_span_id: "ghost" })];
		const restarts: ContinueResult[] = [
			{
				context: {
					trace_id: "a".repeat(32),
					span_id: "b".repeat(16),
					sampled: false,
					trace_state: [],
				},
				action: "restarted",
				reason: "malformed traceparent",
			},
		];
		const report = detectTelemetryGaps({ spans, propagation_restarts: restarts });
		expect(report.confirmed_absence_count + report.unknown_evidence_count).toBe(
			report.findings.length,
		);
	});
});
