import { describe, expect, test } from "bun:test";
import {
	CONTAINMENT_EXPLANATIONS,
	CONTAINMENT_TOLERANCE_MS,
	type IntegritySpan,
	MIN_SKEW_OBSERVATIONS,
	checkIntegrity,
	checkLogIntegrity,
	estimateServiceSkew,
	impliedOffset,
} from "../../src/trace/integrity.js";

function span(overrides: Partial<IntegritySpan> & { span_id: string }): IntegritySpan {
	return {
		service: "api",
		name: "op",
		start_ms: 1000,
		end_ms: 2000,
		...overrides,
	};
}

function findingsOf(spans: IntegritySpan[], code: string) {
	return checkIntegrity(spans).findings.filter((f) => f.code === code);
}

describe("duplicates: redelivery versus collision", () => {
	test("an identical redelivery is low severity and its own code", () => {
		const s = span({ span_id: "a" });
		const findings = findingsOf([s, { ...s }], "duplicate_span");
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe("low");
		expect(findings[0].detail).toContain("identical content");
	});

	test("a conflicting duplicate is a different, high-severity defect", () => {
		const findings = findingsOf(
			[span({ span_id: "a" }), span({ span_id: "a", name: "different", end_ms: 9999 })],
			"conflicting_duplicate",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe("high");
		expect(findings[0].detail).toContain("corrupts every aggregate");
	});

	test("three identical copies are one finding, not two", () => {
		const s = span({ span_id: "a" });
		expect(findingsOf([s, { ...s }, { ...s }], "duplicate_span")).toHaveLength(1);
	});

	test("distinct spans are not duplicates", () => {
		expect(findingsOf([span({ span_id: "a" }), span({ span_id: "b" })], "duplicate_span")).toEqual(
			[],
		);
	});

	test("only the first copy is used for structural checks", () => {
		const report = checkIntegrity([
			span({ span_id: "a" }),
			span({ span_id: "a" }),
			span({ span_id: "b", parent_span_id: "a", start_ms: 1100, end_ms: 1900 }),
		]);
		expect(report.findings.filter((f) => f.code === "containment_violation")).toEqual([]);
	});
});

describe("structural defects", () => {
	test("a span ending before it starts is high severity", () => {
		const findings = findingsOf(
			[span({ span_id: "a", start_ms: 2000, end_ms: 1000 })],
			"negative_duration",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe("high");
	});

	test("a reference to an absent parent is an orphan, explained as a missing span", () => {
		const findings = findingsOf(
			[span({ span_id: "b", parent_span_id: "ghost" })],
			"orphan_parent",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].explanations).toEqual(["missing_intermediate_span"]);
	});

	test("a zero-duration parent is flagged only when it has children", () => {
		const childless = findingsOf(
			[span({ span_id: "a", start_ms: 1000, end_ms: 1000 })],
			"zero_duration_parent",
		);
		expect(childless).toEqual([]);
		const withChild = findingsOf(
			[
				span({ span_id: "a", start_ms: 1000, end_ms: 1000 }),
				span({ span_id: "b", parent_span_id: "a", start_ms: 1000, end_ms: 1000 }),
			],
			"zero_duration_parent",
		);
		expect(withChild).toHaveLength(1);
	});

	test("a clean trace produces no findings at all", () => {
		const report = checkIntegrity([
			span({ span_id: "root", start_ms: 1000, end_ms: 5000 }),
			span({ span_id: "child", parent_span_id: "root", start_ms: 1100, end_ms: 4900 }),
		]);
		expect(report.findings).toEqual([]);
		expect(report.unresolved_explanations).toEqual([]);
	});
});

describe("containment violations keep their alternatives open", () => {
	test("an isolated cross-service violation keeps every explanation", () => {
		const findings = findingsOf(
			[
				span({ span_id: "root", service: "api", start_ms: 1000, end_ms: 5000 }),
				span({
					span_id: "child",
					parent_span_id: "root",
					service: "worker",
					start_ms: 500,
					end_ms: 4000,
				}),
			],
			"containment_violation",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].explanations.sort()).toEqual([...CONTAINMENT_EXPLANATIONS].sort());
		expect(findings[0].detail).toContain("does not distinguish");
	});

	test("a same-service violation cannot be a clock problem", () => {
		const findings = findingsOf(
			[
				span({ span_id: "root", start_ms: 1000, end_ms: 5000 }),
				span({ span_id: "child", parent_span_id: "root", start_ms: 500, end_ms: 4000 }),
			],
			"containment_violation",
		);
		expect(findings[0].explanations).not.toContain("clock_skew");
	});

	test("a child ending after its parent also violates containment", () => {
		expect(
			findingsOf(
				[
					span({ span_id: "root", start_ms: 1000, end_ms: 2000 }),
					span({ span_id: "child", parent_span_id: "root", start_ms: 1100, end_ms: 9000 }),
				],
				"containment_violation",
			),
		).toHaveLength(1);
	});

	test("a violation inside the tolerance is measurement noise, not a finding", () => {
		expect(
			findingsOf(
				[
					span({ span_id: "root", start_ms: 1000, end_ms: 5000 }),
					span({
						span_id: "child",
						parent_span_id: "root",
						start_ms: 1000 - CONTAINMENT_TOLERANCE_MS,
						end_ms: 4000,
					}),
				],
				"containment_violation",
			),
		).toEqual([]);
	});

	test("open alternatives are surfaced at the report level", () => {
		const report = checkIntegrity([
			span({ span_id: "root", service: "api", start_ms: 1000, end_ms: 5000 }),
			span({
				span_id: "child",
				parent_span_id: "root",
				service: "worker",
				start_ms: 500,
				end_ms: 4000,
			}),
		]);
		expect(report.unresolved_explanations.length).toBeGreaterThan(1);
	});
});

describe("systematic offsets are skew; isolated ones are not", () => {
	function skewedTrace(offsets: number[]): IntegritySpan[] {
		const spans: IntegritySpan[] = [];
		offsets.forEach((offset, i) => {
			spans.push(
				span({
					span_id: `p${i}`,
					service: "api",
					start_ms: 10_000 + i * 1000,
					end_ms: 10_900 + i * 1000,
				}),
			);
			spans.push(
				span({
					span_id: `c${i}`,
					parent_span_id: `p${i}`,
					service: "worker",
					start_ms: 10_000 + i * 1000 + offset,
					end_ms: 10_800 + i * 1000 + offset,
				}),
			);
		});
		return spans;
	}

	test("a consistent offset across many spans is diagnosed as a clock", () => {
		const report = checkIntegrity(skewedTrace([-500, -505, -498, -502, -501]));
		const estimate = report.skew.find((s) => s.service === "worker")!;
		expect(estimate.systematic).toBe(true);
		expect(estimate.offset_ms).toBeCloseTo(-501, 0);
		const skewFindings = report.findings.filter((f) => f.code === "clock_skew");
		expect(skewFindings.length).toBe(5);
		expect(skewFindings[0].explanations).toEqual(["clock_skew"]);
	});

	test("offsets that disagree are not called a clock", () => {
		const report = checkIntegrity(skewedTrace([-50, -3000, -700, -20, -5000]));
		const estimate = report.skew.find((s) => s.service === "worker")!;
		expect(estimate.systematic).toBe(false);
		expect(report.findings.filter((f) => f.code === "clock_skew")).toEqual([]);
		expect(report.findings.filter((f) => f.code === "containment_violation").length).toBe(5);
	});

	test("too few observations cannot establish a systematic offset", () => {
		const report = checkIntegrity(skewedTrace([-500, -500]));
		expect(MIN_SKEW_OBSERVATIONS).toBeGreaterThan(2);
		expect(report.skew[0].systematic).toBe(false);
		expect(report.findings.every((f) => f.code !== "clock_skew")).toBe(true);
	});

	test("one bad pair does not drag the median", () => {
		const estimates = estimateServiceSkew(skewedTrace([-500, -500, -500, -500, -90_000]));
		expect(estimates[0].offset_ms).toBe(-500);
	});

	test("same-service edges say nothing about a clock", () => {
		const spans: IntegritySpan[] = [];
		for (let i = 0; i < 5; i++) {
			spans.push(span({ span_id: `p${i}`, start_ms: 10_000 + i * 1000, end_ms: 10_900 + i * 1000 }));
			spans.push(
				span({
					span_id: `c${i}`,
					parent_span_id: `p${i}`,
					start_ms: 9500 + i * 1000,
					end_ms: 10_800 + i * 1000,
				}),
			);
		}
		expect(estimateServiceSkew(spans)).toEqual([]);
	});

	test("the implied offset is zero for a properly contained child", () => {
		const parent = span({ span_id: "p", start_ms: 1000, end_ms: 2000 });
		const child = span({ span_id: "c", start_ms: 1100, end_ms: 1900 });
		expect(impliedOffset(parent, child)).toBe(0);
	});

	test("a clock-skew finding is medium severity, not high", () => {
		// A known constant offset is correctable; an unexplained violation is not.
		const report = checkIntegrity(skewedTrace([-500, -505, -498, -502, -501]));
		expect(report.findings.find((f) => f.code === "clock_skew")!.severity).toBe("medium");
	});
});

describe("delivery order and gaps", () => {
	test("a sequence that goes backwards against start time is reordering", () => {
		const findings = findingsOf(
			[
				span({ span_id: "a", start_ms: 1000, end_ms: 1100, sequence: 5 }),
				span({ span_id: "b", start_ms: 2000, end_ms: 2100, sequence: 4 }),
			],
			"out_of_order_delivery",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].explanations).toEqual(["reordered_delivery"]);
	});

	test("a gap in the sequence counts the missing spans", () => {
		const findings = findingsOf(
			[
				span({ span_id: "a", start_ms: 1000, end_ms: 1100, sequence: 1 }),
				span({ span_id: "b", start_ms: 2000, end_ms: 2100, sequence: 5 }),
			],
			"sequence_gap",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].detail).toContain("3 span(s) missing");
	});

	test("spans without sequence numbers are not judged on order", () => {
		const report = checkIntegrity([
			span({ span_id: "a", start_ms: 5000, end_ms: 5100 }),
			span({ span_id: "b", start_ms: 1000, end_ms: 1100 }),
		]);
		expect(report.findings).toEqual([]);
	});

	test("a contiguous sequence produces no gap findings", () => {
		expect(
			findingsOf(
				[
					span({ span_id: "a", start_ms: 1000, end_ms: 1100, sequence: 1 }),
					span({ span_id: "b", start_ms: 2000, end_ms: 2100, sequence: 2 }),
				],
				"sequence_gap",
			),
		).toEqual([]);
	});
});

describe("report shape", () => {
	test("findings are ordered by severity", () => {
		const report = checkIntegrity([
			span({ span_id: "dup" }),
			span({ span_id: "dup" }),
			span({ span_id: "bad", start_ms: 5000, end_ms: 1000 }),
		]);
		expect(report.findings[0].severity).toBe("high");
		expect(report.findings[report.findings.length - 1].severity).toBe("low");
	});

	test("counts tally every code that fired", () => {
		const report = checkIntegrity([
			span({ span_id: "dup" }),
			span({ span_id: "dup" }),
			span({ span_id: "orphan", parent_span_id: "ghost" }),
		]);
		expect(report.counts.duplicate_span).toBe(1);
		expect(report.counts.orphan_parent).toBe(1);
		expect(report.spans_examined).toBe(3);
	});

	test("an empty span set is a clean report", () => {
		const report = checkIntegrity([]);
		expect(report.findings).toEqual([]);
		expect(report.skew).toEqual([]);
		expect(report.counts).toEqual({});
	});
});

describe("logs", () => {
	test("a backwards timestamp with an advancing sequence is a clock step", () => {
		const findings = checkLogIntegrity([
			{ service: "api", ts_ms: 2000, message: "a", sequence: 1 },
			{ service: "api", ts_ms: 1000, message: "b", sequence: 2 },
		]);
		expect(findings[0].explanations).toEqual(["clock_skew"]);
		expect(findings[0].detail).toContain("the clock moved, not the stream");
	});

	test("a backwards timestamp with a backwards sequence is reordering", () => {
		const findings = checkLogIntegrity([
			{ service: "api", ts_ms: 2000, message: "a", sequence: 2 },
			{ service: "api", ts_ms: 1000, message: "b", sequence: 1 },
		]);
		expect(findings[0].explanations).toEqual(["reordered_delivery"]);
	});

	test("without a sequence number the case is undecidable and says so", () => {
		const findings = checkLogIntegrity([
			{ service: "api", ts_ms: 2000, message: "a" },
			{ service: "api", ts_ms: 1000, message: "b" },
		]);
		expect(findings[0].explanations.sort()).toEqual(["clock_skew", "reordered_delivery"]);
		expect(findings[0].detail).toContain("no sequence number to disambiguate");
	});

	test("services are checked independently", () => {
		const findings = checkLogIntegrity([
			{ service: "api", ts_ms: 2000, message: "a" },
			{ service: "worker", ts_ms: 1000, message: "b" },
		]);
		expect(findings).toEqual([]);
	});

	test("identical lines at the same millisecond are duplicates", () => {
		const findings = checkLogIntegrity([
			{ service: "api", ts_ms: 1000, message: "boom" },
			{ service: "api", ts_ms: 1000, message: "boom" },
		]);
		expect(findings.filter((f) => f.code === "duplicate_span")).toHaveLength(1);
	});

	test("the same message at different times is not a duplicate", () => {
		const findings = checkLogIntegrity([
			{ service: "api", ts_ms: 1000, message: "boom" },
			{ service: "api", ts_ms: 2000, message: "boom" },
		]);
		expect(findings).toEqual([]);
	});

	test("an empty log stream is clean", () => {
		expect(checkLogIntegrity([])).toEqual([]);
	});
});
