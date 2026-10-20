import { describe, expect, test } from "bun:test";
import {
	AGENTCHAOSBENCH_VERSION,
	type ChaosBenchCase,
	ChaosBenchCaseSchema,
	type ChaosBenchPrediction,
	ChaosBenchSuiteSchema,
	FAULT_TYPES,
	REFERENCE_DEPENDENT_FAULT_TYPES,
	aggregateChaosBench,
	renderChaosBenchReport,
	scoreChaosBenchCase,
	scoreChaosBenchSuite,
	validateChaosBenchCase,
	validateChaosBenchSuite,
} from "../../src/bench/agentchaosbench.js";

type SpanOverrides = Partial<{
	kind: "agent" | "llm" | "tool" | "guardrail" | "retrieval";
	status: "ok" | "error";
}>;

function span(id: string, overrides: SpanOverrides = {}) {
	return { ...baseSpan(id), ...overrides };
}

function baseSpan(id: string) {
	return {
		trace_id: "t1",
		span_id: id,
		name: `step-${id}`,
		kind: "tool" as const,
		status: "ok" as const,
		start_ms: 0,
		duration_ms: 10,
	};
}

function toolCrashCase(overrides: Partial<ChaosBenchCase> = {}): ChaosBenchCase {
	return ChaosBenchCaseSchema.parse({
		case_id: "case-crash-1",
		trace: [span("s1"), span("s2", { status: "error" }), span("s3")],
		ground_truth: {
			fault_type: "tool_crash",
			fault_span: { trace_id: "t1", span_id: "s2" },
		},
		...overrides,
	});
}

function cleanCase(): ChaosBenchCase {
	return ChaosBenchCaseSchema.parse({
		case_id: "case-clean-1",
		trace: [span("s1"), span("s2"), span("s3")],
		ground_truth: { fault_type: "none", fault_span: null },
	});
}

function guardrailBypassCase(): ChaosBenchCase {
	return ChaosBenchCaseSchema.parse({
		case_id: "case-guardrail-1",
		trace: [span("s1"), span("s2", { kind: "guardrail" }), span("s3")],
		ground_truth: {
			fault_type: "guardrail_bypass",
			fault_span: { trace_id: "t1", span_id: "s2" },
		},
	});
}

function referenceDependentCase(): ChaosBenchCase {
	return ChaosBenchCaseSchema.parse({
		case_id: "case-ref-1",
		trace: [span("s1"), span("s2"), span("s3")],
		reference_trace: [span("r1"), span("r2"), span("r3")],
		ground_truth: {
			fault_type: "reference_dependent",
			fault_span: { trace_id: "t1", span_id: "s2" },
		},
	});
}

function prediction(overrides: Partial<ChaosBenchPrediction> = {}): ChaosBenchPrediction {
	return {
		case_id: "case-crash-1",
		fault_type: "tool_crash",
		fault_span: { trace_id: "t1", span_id: "s2" },
		used_reference_trace: false,
		...overrides,
	};
}

describe("FAULT_TYPES / REFERENCE_DEPENDENT_FAULT_TYPES vocabulary", () => {
	test("'none' and 'guardrail_bypass' are both present as first-class labels", () => {
		expect(FAULT_TYPES).toContain("none");
		expect(FAULT_TYPES).toContain("guardrail_bypass");
	});

	test("reference_dependent is marked as needing a reference trace", () => {
		expect(REFERENCE_DEPENDENT_FAULT_TYPES.has("reference_dependent")).toBe(true);
		expect(REFERENCE_DEPENDENT_FAULT_TYPES.has("tool_crash")).toBe(false);
	});
});

describe("validateChaosBenchCase: catches corpus-authoring errors before they corrupt a score", () => {
	test("a well-formed case is valid", () => {
		expect(validateChaosBenchCase(toolCrashCase()).ok).toBe(true);
	});

	test("a reference_dependent ground truth with no reference_trace is rejected", () => {
		const broken: ChaosBenchCase = {
			...referenceDependentCase(),
			reference_trace: undefined,
		};
		const result = validateChaosBenchCase(broken);
		expect(result.ok).toBe(false);
		expect(result.problems.some((p) => p.includes("requires a reference_trace"))).toBe(true);
	});

	test("fault_type 'none' with a non-null fault_span is rejected", () => {
		const broken: ChaosBenchCase = {
			...cleanCase(),
			ground_truth: { fault_type: "none", fault_span: { trace_id: "t1", span_id: "s1" } },
		};
		expect(validateChaosBenchCase(broken).ok).toBe(false);
	});

	test("a non-'none' fault_type with a null fault_span is rejected", () => {
		const broken: ChaosBenchCase = {
			...toolCrashCase(),
			ground_truth: { fault_type: "tool_crash", fault_span: null },
		};
		expect(validateChaosBenchCase(broken).ok).toBe(false);
	});

	test("a fault_span naming a span absent from trace is rejected", () => {
		const broken: ChaosBenchCase = {
			...toolCrashCase(),
			ground_truth: { fault_type: "tool_crash", fault_span: { trace_id: "t1", span_id: "nope" } },
		};
		const result = validateChaosBenchCase(broken);
		expect(result.ok).toBe(false);
		expect(result.problems.some((p) => p.includes("does not name a span present"))).toBe(true);
	});

	test("validateChaosBenchSuite collects problems across every case", () => {
		const suite = ChaosBenchSuiteSchema.parse({
			schema_version: AGENTCHAOSBENCH_VERSION,
			cases: [
				toolCrashCase(),
				{
					...cleanCase(),
					ground_truth: { fault_type: "none", fault_span: { trace_id: "t1", span_id: "s1" } },
				},
			],
		});
		const result = validateChaosBenchSuite(suite);
		expect(result.ok).toBe(false);
		expect(result.problems).toHaveLength(1);
	});
});

describe("scoreChaosBenchCase: fault-type and location scored independently", () => {
	test("a fully correct prediction scores correct on both axes", () => {
		const score = scoreChaosBenchCase(toolCrashCase(), prediction());
		expect(score.fault_type_verdict).toBe("correct");
		expect(score.location_verdict).toBe("correct");
	});

	test("right fault type, wrong span: location wrong, fault type still correct (separate axes)", () => {
		const score = scoreChaosBenchCase(
			toolCrashCase(),
			prediction({ fault_span: { trace_id: "t1", span_id: "s3" } }),
		);
		expect(score.fault_type_verdict).toBe("correct");
		expect(score.location_verdict).toBe("wrong");
	});

	test("right span, wrong fault type: fault type wrong, location can still be correct", () => {
		const score = scoreChaosBenchCase(toolCrashCase(), prediction({ fault_type: "tool_timeout" }));
		expect(score.fault_type_verdict).toBe("wrong");
		expect(score.location_verdict).toBe("correct");
	});

	test("a 'none' ground-truth case has a null location_verdict (nothing to localize)", () => {
		const score = scoreChaosBenchCase(cleanCase(), {
			case_id: "case-clean-1",
			fault_type: "none",
			fault_span: null,
			used_reference_trace: false,
		});
		expect(score.fault_type_verdict).toBe("correct");
		expect(score.location_verdict).toBeNull();
	});

	test("hazard 1: guardrail_bypass must be named explicitly -- predicting 'none' on a guardrail-bypass case is wrong, not a true negative", () => {
		const score = scoreChaosBenchCase(guardrailBypassCase(), {
			case_id: "case-guardrail-1",
			fault_type: "none",
			fault_span: null,
			used_reference_trace: false,
		});
		expect(score.is_guardrail_bypass).toBe(true);
		expect(score.fault_type_verdict).toBe("wrong");
	});

	test("hazard 1: a correctly identified guardrail bypass scores correct and is tracked as guardrail_bypass", () => {
		const score = scoreChaosBenchCase(guardrailBypassCase(), {
			case_id: "case-guardrail-1",
			fault_type: "guardrail_bypass",
			fault_span: { trace_id: "t1", span_id: "s2" },
			used_reference_trace: false,
		});
		expect(score.fault_type_verdict).toBe("correct");
		expect(score.location_verdict).toBe("correct");
	});

	test("hazard 2: a reference-dependent case predicted WITHOUT the reference trace is insufficient_evidence, never wrong, even if the guess happens to be correct", () => {
		const score = scoreChaosBenchCase(referenceDependentCase(), {
			case_id: "case-ref-1",
			fault_type: "reference_dependent",
			fault_span: { trace_id: "t1", span_id: "s2" },
			used_reference_trace: false,
		});
		expect(score.fault_type_verdict).toBe("insufficient_evidence");
		expect(score.location_verdict).toBe("insufficient_evidence");
		expect(score.reference_dependent).toBe(true);
	});

	test("hazard 2: a reference-dependent case predicted WITH the reference trace is scored normally", () => {
		const correct = scoreChaosBenchCase(referenceDependentCase(), {
			case_id: "case-ref-1",
			fault_type: "reference_dependent",
			fault_span: { trace_id: "t1", span_id: "s2" },
			used_reference_trace: true,
		});
		expect(correct.fault_type_verdict).toBe("correct");

		const wrong = scoreChaosBenchCase(referenceDependentCase(), {
			case_id: "case-ref-1",
			fault_type: "tool_crash",
			fault_span: { trace_id: "t1", span_id: "s2" },
			used_reference_trace: true,
		});
		expect(wrong.fault_type_verdict).toBe("wrong");
	});

	test("a null predicted fault_span against a null ground-truth fault_span is not scored as correct location (location_verdict stays null)", () => {
		const score = scoreChaosBenchCase(cleanCase(), {
			case_id: "case-clean-1",
			fault_type: "none",
			fault_span: null,
			used_reference_trace: false,
		});
		expect(score.location_verdict).toBeNull();
	});
});

describe("aggregateChaosBench / scoreChaosBenchSuite: separate axes, abstention tracked apart from accuracy", () => {
	test("accuracy, resolved_accuracy, and insufficient_evidence_rate on an all-correct, all-resolved suite", () => {
		const suite = ChaosBenchSuiteSchema.parse({
			schema_version: AGENTCHAOSBENCH_VERSION,
			cases: [toolCrashCase(), cleanCase()],
		});
		const predictions: ChaosBenchPrediction[] = [
			prediction(),
			{
				case_id: "case-clean-1",
				fault_type: "none",
				fault_span: null,
				used_reference_trace: false,
			},
		];
		const report = scoreChaosBenchSuite(suite, predictions);
		expect(report.cases).toBe(2);
		expect(report.fault_type.accuracy).toBe(1);
		expect(report.fault_type.resolved_accuracy).toBe(1);
		expect(report.fault_type.insufficient_evidence_rate).toBe(0);
		// Only toolCrashCase has a non-null fault_span to localize.
		expect(report.location.scored_cases).toBe(1);
		expect(report.location.accuracy).toBe(1);
	});

	test("insufficient_evidence lowers the raw rate but is excluded from resolved_accuracy's denominator", () => {
		const suite = ChaosBenchSuiteSchema.parse({
			schema_version: AGENTCHAOSBENCH_VERSION,
			cases: [toolCrashCase(), referenceDependentCase()],
		});
		const predictions: ChaosBenchPrediction[] = [
			prediction(), // correct
			{
				case_id: "case-ref-1",
				fault_type: "reference_dependent",
				fault_span: { trace_id: "t1", span_id: "s2" },
				used_reference_trace: false, // abstained -> insufficient_evidence
			},
		];
		const report = scoreChaosBenchSuite(suite, predictions);
		// raw accuracy counts the abstained case against the detector: 1/2
		expect(report.fault_type.accuracy).toBe(0.5);
		// resolved accuracy only counts the one resolved (correct) case: 1/1
		expect(report.fault_type.resolved_accuracy).toBe(1);
		expect(report.fault_type.insufficient_evidence_rate).toBe(0.5);
	});

	test("guardrail_bypass and reference_dependent cases are reported in their own sections", () => {
		const suite = ChaosBenchSuiteSchema.parse({
			schema_version: AGENTCHAOSBENCH_VERSION,
			cases: [guardrailBypassCase(), referenceDependentCase(), toolCrashCase()],
		});
		const predictions: ChaosBenchPrediction[] = [
			{
				case_id: "case-guardrail-1",
				fault_type: "guardrail_bypass",
				fault_span: { trace_id: "t1", span_id: "s2" },
				used_reference_trace: false,
			},
			{
				case_id: "case-ref-1",
				fault_type: "reference_dependent",
				fault_span: { trace_id: "t1", span_id: "s2" },
				used_reference_trace: true,
			},
			prediction(),
		];
		const report = scoreChaosBenchSuite(suite, predictions);
		expect(report.guardrail_bypass.cases).toBe(1);
		expect(report.guardrail_bypass.fault_type_accuracy).toBe(1);
		expect(report.reference_dependent.cases).toBe(1);
		expect(report.reference_dependent.fault_type_accuracy).toBe(1);
		expect(report.reference_dependent.insufficient_evidence_rate).toBe(0);
	});

	test("joint_correct_rate counts a case only when fault type is correct and location is not wrong", () => {
		const suite = ChaosBenchSuiteSchema.parse({
			schema_version: AGENTCHAOSBENCH_VERSION,
			cases: [toolCrashCase(), cleanCase()],
		});
		const predictions: ChaosBenchPrediction[] = [
			prediction({ fault_span: { trace_id: "t1", span_id: "s3" } }), // right type, wrong span
			{
				case_id: "case-clean-1",
				fault_type: "none",
				fault_span: null,
				used_reference_trace: false,
			},
		];
		const report = scoreChaosBenchSuite(suite, predictions);
		// case 1: fault_type correct but location wrong -> not joint-correct.
		// case 2: fault_type correct, location null (not wrong) -> joint-correct.
		expect(report.joint_correct_rate).toBe(0.5);
	});

	test("scoreChaosBenchSuite throws on a prediction referencing an unknown case_id", () => {
		const suite = ChaosBenchSuiteSchema.parse({
			schema_version: AGENTCHAOSBENCH_VERSION,
			cases: [toolCrashCase()],
		});
		expect(() =>
			scoreChaosBenchSuite(suite, [prediction({ case_id: "does-not-exist" })]),
		).toThrow();
	});

	test("aggregateChaosBench on an empty score list returns zeroed rates, not NaN or a throw", () => {
		const report = aggregateChaosBench([]);
		expect(report.cases).toBe(0);
		expect(report.fault_type.accuracy).toBe(0);
		expect(report.fault_type.resolved_accuracy).toBe(0);
		expect(report.location.accuracy).toBe(0);
		expect(report.joint_correct_rate).toBe(0);
	});
});

describe("renderChaosBenchReport: human-readable summary", () => {
	test("mentions case count, every section's accuracy, and both hazard sections by name", () => {
		const suite = ChaosBenchSuiteSchema.parse({
			schema_version: AGENTCHAOSBENCH_VERSION,
			cases: [toolCrashCase(), guardrailBypassCase()],
		});
		const predictions: ChaosBenchPrediction[] = [
			prediction(),
			{
				case_id: "case-guardrail-1",
				fault_type: "guardrail_bypass",
				fault_span: { trace_id: "t1", span_id: "s2" },
				used_reference_trace: false,
			},
		];
		const report = scoreChaosBenchSuite(suite, predictions);
		const lines = renderChaosBenchReport(report);
		expect(lines[0]).toContain("2 case(s)");
		expect(lines.some((l) => l.includes("fault-type"))).toBe(true);
		expect(lines.some((l) => l.includes("location"))).toBe(true);
		expect(lines.some((l) => l.includes("guardrail_bypass"))).toBe(true);
		expect(lines.some((l) => l.includes("reference_dependent"))).toBe(true);
		expect(lines.some((l) => l.includes("joint correct rate"))).toBe(true);
	});
});
