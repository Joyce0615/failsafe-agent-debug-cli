/**
 * OpenTelemetry agent/workflow conformance ingestion tests (item 21).
 *
 * Covers: GenAI span normalization composed with ownership validation
 * (reusing item 11's `checkOwnedMcpOperation` unmodified), unsupported/
 * ambiguous field surfacing before diagnosis, correlated OTel log record
 * ingestion (exact and nearest-span correlation plus uncorrelated logs),
 * and that the whole report composes without re-deriving any existing
 * primitive.
 */
import { describe, expect, test } from "bun:test";
import {
	type LogRecord,
	buildConformanceReport,
	checkSpanConformance,
	checkTraceConformance,
	correlateLogs,
	resolveSpanOwnership,
} from "../../src/trace/conformance.js";
import type { NormalizedSpan } from "../../src/trace/normalize.js";

function span(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
	return {
		trace_id: "t1",
		span_id: "s1",
		name: "op",
		service: "svc",
		start_ms: 1000,
		duration_ms: 10,
		status: "unset",
		attributes: {},
		messages: [],
		...overrides,
	};
}

describe("ownership validation (reuses item 11's checkOwnedMcpOperation)", () => {
	test("a tool span naming a registered Failsafe tool is owned", () => {
		const result = checkSpanConformance(
			span({
				attributes: {
					"gen_ai.operation.name": "execute_tool",
					"gen_ai.tool.name": "failsafe_diagnose",
				},
			}),
		);
		expect(result.ownership).toEqual({ owner: "failsafe", tool_name: "failsafe_diagnose" });
	});

	test("a tool span naming an unrecognized tool is marked external, not rejected", () => {
		const result = checkSpanConformance(
			span({
				attributes: {
					"gen_ai.operation.name": "execute_tool",
					"gen_ai.tool.name": "some_other_servers_tool",
				},
			}),
		);
		expect(result.ownership.owner).toBe("external");
		expect((result.ownership as { reason: string }).reason).toContain(
			"not a tool this MCP server registers",
		);
	});

	test("a non-tool span (no declared tool_name) is unknown ownership, not falsely external", () => {
		const result = checkSpanConformance(
			span({
				attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "planner" },
			}),
		);
		expect(resolveSpanOwnership(result.span)).toEqual({ owner: "unknown" });
	});
});

describe("unsupported/ambiguous fields surfaced before diagnosis", () => {
	test("a span with no declared operation is an advisory unknown_kind issue", () => {
		const result = checkSpanConformance(span());
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]).toMatchObject({ code: "unknown_kind", severity: "advisory" });
	});

	test("a declared-but-unrecognized operation is a blocking issue, sorted first", () => {
		const result = checkSpanConformance(
			span({ attributes: { "gen_ai.operation.name": "some_future_op" } }),
		);
		expect(result.issues[0]).toMatchObject({
			code: "unrecognized_operation",
			severity: "blocking",
		});
	});

	test("disagreeing aliases on the same span are recorded as a conflict, not reconciled", () => {
		const result = checkSpanConformance(
			span({
				attributes: {
					"gen_ai.operation.name": "chat",
					"gen_ai.usage.input_tokens": "100",
					"llm.token_count.prompt": "120",
				},
			}),
		);
		const conflict = result.issues.find((i) => i.code === "alias_conflict");
		expect(conflict).toBeDefined();
		expect(conflict!.detail).toContain("input_tokens");
		// The canonical value still wins — this module does not reconcile.
		expect(result.span.input_tokens).toBe(100);
	});

	test("a parent/child kind mismatch across the batch is a structure_violation issue", () => {
		const { issues } = checkTraceConformance([
			span({
				span_id: "p1",
				attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "x" },
			}),
			// A plan span expects an agent/workflow parent; a tool parent is a
			// real violation per EXPECTED_PARENTS in genai-normalize.ts.
			span({
				span_id: "c1",
				parent_span_id: "p1",
				attributes: { "gen_ai.operation.name": "planning" },
			}),
		]);
		expect(issues.some((i) => i.code === "structure_violation")).toBe(true);
	});

	test("blocking issues sort before advisory issues within one span", () => {
		// Conflict (advisory) + unrecognized operation (blocking) on one span.
		const result = checkSpanConformance(
			span({
				attributes: {
					"gen_ai.operation.name": "not_a_real_operation",
					"gen_ai.usage.input_tokens": "1",
					"llm.token_count.prompt": "2",
				},
			}),
		);
		expect(result.issues[0].severity).toBe("blocking");
	});
});

describe("correlated OTel log records (new ingestion path)", () => {
	const spans: NormalizedSpan[] = [
		span({ trace_id: "tr1", span_id: "sp1", start_ms: 1000 }),
		span({ trace_id: "tr1", span_id: "sp2", start_ms: 2000 }),
	];

	test("a log sharing trace_id and span_id correlates exactly", () => {
		const log: LogRecord = {
			ts_ms: 1005,
			severity_text: "ERROR",
			body: "boom",
			trace_id: "tr1",
			span_id: "sp1",
		};
		const [result] = correlateLogs([log], spans);
		expect(result).toMatchObject({ status: "exact", span_id: "sp1" });
	});

	test("a log with a trace_id but no span_id falls back to the nearest span by start time", () => {
		const log: LogRecord = { ts_ms: 2050, severity_text: "INFO", body: "note", trace_id: "tr1" };
		const [result] = correlateLogs([log], spans);
		expect(result).toMatchObject({ status: "nearest", span_id: "sp2" });
		expect((result as { delta_ms: number }).delta_ms).toBe(50);
	});

	test("a log with no trace_id at all is uncorrelated, not dropped", () => {
		const log: LogRecord = { ts_ms: 1000, severity_text: "WARN", body: "orphan log" };
		const [result] = correlateLogs([log], spans);
		expect(result.status).toBe("uncorrelated");
		expect((result as { reason: string }).reason).toContain("no trace_id");
	});

	test("a log whose trace_id matches no span is uncorrelated with a named reason", () => {
		const log: LogRecord = {
			ts_ms: 1000,
			severity_text: "WARN",
			body: "other trace",
			trace_id: "unknown_trace",
		};
		const [result] = correlateLogs([log], spans);
		expect(result.status).toBe("uncorrelated");
		expect((result as { reason: string }).reason).toContain("matches no span");
	});

	test("every supplied log produces exactly one correlation result (none silently dropped)", () => {
		const logs: LogRecord[] = [
			{ ts_ms: 1000, severity_text: "INFO", body: "a" },
			{ ts_ms: 1000, severity_text: "INFO", body: "b", trace_id: "tr1", span_id: "sp1" },
			{ ts_ms: 1000, severity_text: "INFO", body: "c", trace_id: "does-not-exist" },
		];
		expect(correlateLogs(logs, spans)).toHaveLength(3);
	});
});

describe("buildConformanceReport composes without re-deriving anything", () => {
	test("full report tallies ownership, issues, and log correlation together", () => {
		const spansIn: NormalizedSpan[] = [
			span({
				trace_id: "tr1",
				span_id: "sp1",
				attributes: {
					"gen_ai.operation.name": "execute_tool",
					"gen_ai.tool.name": "failsafe_diagnose",
				},
			}),
			span({ trace_id: "tr1", span_id: "sp2", start_ms: 2000 }), // undeclared -> advisory unknown_kind
		];
		const logs: LogRecord[] = [
			{ ts_ms: 1000, severity_text: "ERROR", body: "x", trace_id: "tr1", span_id: "sp1" },
			{ ts_ms: 1000, severity_text: "WARN", body: "y" },
		];
		const report = buildConformanceReport(spansIn, logs);

		expect(report.spans_examined).toBe(2);
		expect(report.logs_examined).toBe(2);
		expect(report.ownership.failsafe).toBe(1);
		expect(report.ownership.unknown).toBe(1);
		expect(report.log_correlation.exact).toBe(1);
		expect(report.log_correlation.uncorrelated).toBe(1);
		expect(report.blocking_issues).toBe(0);
		expect(report.span_conformance).toHaveLength(2);
		expect(report.log_correlation_detail).toHaveLength(2);
	});

	test("a blocking issue anywhere in the batch is counted in blocking_issues", () => {
		const report = buildConformanceReport([
			span({ attributes: { "gen_ai.operation.name": "not_a_real_op" } }),
		]);
		expect(report.blocking_issues).toBe(1);
	});

	test("an empty batch produces a well-formed, zeroed report rather than throwing", () => {
		const report = buildConformanceReport([]);
		expect(report).toMatchObject({
			spans_examined: 0,
			logs_examined: 0,
			issues: [],
			blocking_issues: 0,
			ownership: { failsafe: 0, external: 0, unknown: 0 },
			log_correlation: { exact: 0, nearest: 0, uncorrelated: 0 },
		});
	});
});
