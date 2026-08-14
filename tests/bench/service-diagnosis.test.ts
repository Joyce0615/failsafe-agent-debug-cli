import { describe, expect, test } from "bun:test";
import {
	ARTIFACT_KINDS,
	DEFAULT_TOP_K,
	SERVICE_BENCH_VERSION,
	type ServiceCase,
	type ServicePrediction,
	ServiceCaseSchema,
	ServiceSuiteSchema,
	aggregate,
	fromServiceRows,
	scoreCase,
	scoreSuite,
	validateSuite,
} from "../../src/bench/service-diagnosis.js";

function caseFixture(overrides: Partial<ServiceCase> = {}): ServiceCase {
	return ServiceCaseSchema.parse({
		case_id: "inc-1",
		components: ["checkout", "payments", "inventory"],
		available_artifacts: ["logs", "traces", "configuration"],
		ground_truth: {
			component: "payments",
			cause_class: "config_drift",
			required_evidence: [
				{ artifact: "logs", id: "line-42" },
				{ artifact: "traces", id: "span-7" },
				{ artifact: "configuration", id: "timeout_ms" },
			],
		},
		budget: { max_latency_ms: 10_000, max_tokens: 5_000 },
		...overrides,
	});
}

function prediction(overrides: Partial<ServicePrediction> = {}): ServicePrediction {
	return {
		case_id: "inc-1",
		ranked_components: ["payments", "checkout"],
		cause_class: "config_drift",
		cited_evidence: [
			{ artifact: "logs", id: "line-42" },
			{ artifact: "traces", id: "span-7" },
			{ artifact: "configuration", id: "timeout_ms" },
		],
		latency_ms: 4_000,
		tokens: 2_000,
		...overrides,
	};
}

describe("component localization", () => {
	test("a perfect ranking scores top-1 and reciprocal rank 1", () => {
		const s = scoreCase(caseFixture(), prediction());
		expect(s.localization.top1).toBe(true);
		expect(s.localization.reciprocal_rank).toBe(1);
	});

	test("a second-place hit loses top-1 but keeps top-k", () => {
		const s = scoreCase(caseFixture(), prediction({ ranked_components: ["checkout", "payments"] }));
		expect(s.localization.top1).toBe(false);
		expect(s.localization.topk).toBe(true);
		expect(s.localization.reciprocal_rank).toBeCloseTo(0.5, 10);
	});

	test("a hit outside k is not top-k", () => {
		const s = scoreCase(
			caseFixture(),
			prediction({ ranked_components: ["a", "b", "c", "payments"] }),
			{ k: 3 },
		);
		expect(s.localization.topk).toBe(false);
		expect(s.localization.reciprocal_rank).toBeCloseTo(0.25, 10);
	});

	test("a miss scores zero reciprocal rank", () => {
		const s = scoreCase(caseFixture(), prediction({ ranked_components: ["checkout"] }));
		expect(s.localization.reciprocal_rank).toBe(0);
	});

	test("abstention is recorded distinctly from a wrong answer", () => {
		const s = scoreCase(caseFixture(), prediction({ ranked_components: [] }));
		expect(s.localization.abstained).toBe(true);
		expect(s.localization.top1).toBe(false);
		expect(s.localization.k).toBe(DEFAULT_TOP_K);
	});
});

describe("cause class scored independently of localization", () => {
	test("a right cause on the wrong component still scores the cause", () => {
		const s = scoreCase(caseFixture(), prediction({ ranked_components: ["inventory"] }));
		expect(s.localization.top1).toBe(false);
		expect(s.cause_class.correct).toBe(true);
	});

	test("a right component with the wrong cause is a distinguishable failure", () => {
		const s = scoreCase(caseFixture(), prediction({ cause_class: "resource_exhaustion" }));
		expect(s.localization.top1).toBe(true);
		expect(s.cause_class.correct).toBe(false);
		expect(s.cause_class.predicted).toBe("resource_exhaustion");
	});

	test("no cause offered is an abstention, not a wrong answer", () => {
		const s = scoreCase(caseFixture(), prediction({ cause_class: undefined }));
		expect(s.cause_class.abstained).toBe(true);
		expect(s.cause_class.correct).toBe(false);
		expect(s.cause_class.predicted).toBeUndefined();
	});
});

describe("explanation evidence", () => {
	test("citing exactly the required evidence is perfect precision and recall", () => {
		const s = scoreCase(caseFixture(), prediction());
		expect(s.evidence.precision).toBe(1);
		expect(s.evidence.recall).toBe(1);
		expect(s.evidence.f1).toBe(1);
	});

	test("padding citations costs precision but not recall", () => {
		const s = scoreCase(
			caseFixture(),
			prediction({
				cited_evidence: [
					{ artifact: "logs", id: "line-42" },
					{ artifact: "traces", id: "span-7" },
					{ artifact: "configuration", id: "timeout_ms" },
					{ artifact: "logs", id: "irrelevant" },
				],
			}),
		);
		expect(s.evidence.recall).toBe(1);
		expect(s.evidence.precision).toBeCloseTo(0.75, 10);
	});

	test("repeating one citation does not inflate precision", () => {
		const s = scoreCase(
			caseFixture(),
			prediction({
				cited_evidence: [
					{ artifact: "logs", id: "line-42" },
					{ artifact: "logs", id: "line-42" },
				],
			}),
		);
		expect(s.evidence.cited).toBe(1);
		expect(s.evidence.precision).toBe(1);
		expect(s.evidence.recall).toBeCloseTo(1 / 3, 10);
	});

	test("recall is broken down per artifact kind", () => {
		const s = scoreCase(
			caseFixture(),
			prediction({ cited_evidence: [{ artifact: "logs", id: "line-42" }] }),
		);
		expect(s.evidence.by_artifact.logs.recall).toBe(1);
		expect(s.evidence.by_artifact.traces.recall).toBe(0);
		expect(s.evidence.by_artifact.metrics).toBeUndefined();
	});

	test("citing an artifact the case never supplied is counted as fabrication", () => {
		const s = scoreCase(
			caseFixture(),
			prediction({
				cited_evidence: [
					{ artifact: "logs", id: "line-42" },
					{ artifact: "metrics", id: "cpu.p99" },
				],
			}),
		);
		expect(s.evidence.unavailable_artifact_citations).toBe(1);
	});

	test("citing nothing scores zero precision, not a free pass", () => {
		const s = scoreCase(caseFixture(), prediction({ cited_evidence: [] }));
		expect(s.evidence.precision).toBe(0);
		expect(s.evidence.recall).toBe(0);
		expect(s.evidence.f1).toBe(0);
	});
});

describe("latency and cost", () => {
	test("within-budget latency and cost are reported with utilization", () => {
		const s = scoreCase(caseFixture(), prediction());
		expect(s.latency.within_budget).toBe(true);
		expect(s.latency.utilization).toBeCloseTo(0.4, 10);
		expect(s.cost.within_budget).toBe(true);
		expect(s.cost.utilization).toBeCloseTo(0.4, 10);
	});

	test("an overrun is flagged without altering the accuracy dimensions", () => {
		const s = scoreCase(caseFixture(), prediction({ latency_ms: 30_000, tokens: 50_000 }));
		expect(s.latency.within_budget).toBe(false);
		expect(s.cost.within_budget).toBe(false);
		expect(s.localization.top1).toBe(true);
		expect(s.evidence.recall).toBe(1);
	});
});

describe("aggregation", () => {
	const cases = [
		caseFixture(),
		caseFixture({
			case_id: "inc-2",
			available_artifacts: ["logs", "metrics"],
			ground_truth: {
				component: "inventory",
				cause_class: "resource_exhaustion",
				required_evidence: [
					{ artifact: "logs", id: "oom" },
					{ artifact: "metrics", id: "rss.p99" },
				],
			},
		}),
	];

	test("reports five independent sections and no overall score", () => {
		const scores = cases.map((c) => scoreCase(c, prediction({ case_id: c.case_id })));
		const report = aggregate(scores);
		expect(report.schema_version).toBe(SERVICE_BENCH_VERSION);
		expect(Object.keys(report)).toContain("localization");
		expect(Object.keys(report)).toContain("cause_class");
		expect(Object.keys(report)).toContain("evidence");
		expect(Object.keys(report)).toContain("latency");
		expect(Object.keys(report)).toContain("cost");
		expect(Object.keys(report)).not.toContain("overall");
		expect(Object.keys(report)).not.toContain("score");
	});

	test("per-artifact recall only counts cases that required that artifact", () => {
		const scores = cases.map((c) => scoreCase(c, prediction({ case_id: c.case_id })));
		const report = aggregate(scores);
		expect(report.evidence.recall_by_artifact.configuration.cases).toBe(1);
		expect(report.evidence.recall_by_artifact.metrics.cases).toBe(1);
		expect(report.evidence.recall_by_artifact.logs.cases).toBe(2);
	});

	test("availability slices expose a system that only reads one surface", () => {
		const scores = cases.map((c) =>
			scoreCase(
				c,
				prediction({
					case_id: c.case_id,
					// Only ever cites logs, and only localizes the log-heavy case.
					ranked_components: c.case_id === "inc-1" ? ["payments"] : ["checkout"],
					cited_evidence: [{ artifact: "logs", id: c.case_id === "inc-1" ? "line-42" : "oom" }],
				}),
			),
		);
		const report = aggregate(scores);
		const metricsSlice = report.slices.find((s) => s.artifact === "metrics");
		const tracesSlice = report.slices.find((s) => s.artifact === "traces");
		expect(metricsSlice?.top1_accuracy).toBe(0);
		expect(tracesSlice?.top1_accuracy).toBe(1);
	});

	test("latency reports both mean and median", () => {
		const scores = [
			scoreCase(cases[0], prediction({ latency_ms: 1_000 })),
			scoreCase(cases[1], prediction({ case_id: "inc-2", latency_ms: 9_000 })),
		];
		const report = aggregate(scores);
		expect(report.latency.mean_ms).toBe(5_000);
		expect(report.latency.median_ms).toBe(5_000);
		expect(report.cost.total_tokens).toBe(4_000);
	});

	test("an empty score set aggregates to zeros rather than NaN", () => {
		const report = aggregate([]);
		expect(report.cases).toBe(0);
		expect(report.localization.top1_accuracy).toBe(0);
		expect(report.evidence.mean_f1).toBe(0);
		expect(report.slices).toEqual([]);
	});
});

describe("suite scoring", () => {
	test("a case with no prediction is scored as a full abstention, not skipped", () => {
		const suite = ServiceSuiteSchema.parse({
			schema_version: SERVICE_BENCH_VERSION,
			dataset_version: "v1",
			created_at: "2026-08-14T00:00:00.000Z",
			cases: [caseFixture(), caseFixture({ case_id: "inc-2" })],
		});
		const scores = scoreSuite(suite, [prediction()]);
		expect(scores).toHaveLength(2);
		expect(scores[1].localization.abstained).toBe(true);
		expect(scores[1].cause_class.abstained).toBe(true);
		expect(aggregate(scores).localization.top1_accuracy).toBe(0.5);
	});
});

describe("suite validation", () => {
	function suiteOf(cases: ServiceCase[]) {
		return ServiceSuiteSchema.parse({
			schema_version: SERVICE_BENCH_VERSION,
			dataset_version: "v1",
			created_at: "2026-08-14T00:00:00.000Z",
			cases,
		});
	}

	test("a valid suite has no issues", () => {
		expect(validateSuite(suiteOf([caseFixture()]))).toEqual([]);
	});

	test("duplicate case ids are rejected", () => {
		const issues = validateSuite(suiteOf([caseFixture(), caseFixture()]));
		expect(issues.some((i) => i.problem === "duplicate case_id")).toBe(true);
	});

	test("a ground-truth component outside the component list is rejected", () => {
		const issues = validateSuite(
			suiteOf([caseFixture({ components: ["checkout", "inventory"] })]),
		);
		expect(issues.some((i) => i.problem.includes("not among the case's components"))).toBe(true);
	});

	test("an unanswerable case citing an unsupplied artifact is rejected", () => {
		const issues = validateSuite(suiteOf([caseFixture({ available_artifacts: ["logs"] })]));
		expect(issues.some((i) => i.problem.includes("does not supply"))).toBe(true);
	});

	test("a case with no required evidence cannot score explanations", () => {
		const issues = validateSuite(
			suiteOf([
				caseFixture({
					ground_truth: {
						component: "payments",
						cause_class: "config_drift",
						required_evidence: [],
					},
				}),
			]),
		);
		expect(issues.some((i) => i.problem.includes("explanation quality cannot be scored"))).toBe(
			true,
		);
	});
});

describe("row adapter", () => {
	test("normalizes object and string evidence forms", () => {
		const suite = fromServiceRows(
			[
				{
					case_id: "inc-1",
					components: ["a", "b"],
					root_cause_service: "b",
					cause_class: "bad_deploy",
					available_artifacts: ["logs", "traces"],
					required_evidence: [{ artifact: "logs", id: "l1" }, "traces:s1"],
				},
			],
			"v2",
		);
		expect(suite.cases).toHaveLength(1);
		expect(suite.cases[0].ground_truth.required_evidence).toEqual([
			{ artifact: "logs", id: "l1" },
			{ artifact: "traces", id: "s1" },
		]);
		expect(suite.dataset_version).toBe("v2");
	});

	test("a ground-truth component missing from the list is added, not dropped", () => {
		const suite = fromServiceRows(
			[
				{
					case_id: "inc-2",
					components: ["a"],
					faulty_component: "z",
					failure_type: "config_drift",
					required_evidence: ["logs:x"],
				},
			],
			"v2",
		);
		expect(suite.cases[0].components).toContain("z");
	});

	test("available artifacts default to the ones the evidence needs", () => {
		const suite = fromServiceRows(
			[
				{
					case_id: "inc-3",
					components: ["a"],
					component: "a",
					anomaly_type: "latency_spike",
					required_evidence: ["metrics:p99", "traces:s2"],
				},
			],
			"v2",
		);
		expect(suite.cases[0].available_artifacts.sort()).toEqual(["metrics", "traces"]);
	});

	test("rows that cannot be normalized are skipped rather than guessed at", () => {
		const suite = fromServiceRows(
			[
				{ case_id: "no-component", cause_class: "x", required_evidence: ["logs:a"] },
				{ case_id: "no-cause", component: "a", required_evidence: ["logs:a"] },
				{ case_id: "no-artifacts", component: "a", cause_class: "x", required_evidence: [] },
			],
			"v2",
		);
		expect(suite.cases).toEqual([]);
	});

	test("unknown artifact names are dropped, not coerced", () => {
		const suite = fromServiceRows(
			[
				{
					case_id: "inc-4",
					components: ["a"],
					component: "a",
					cause_class: "x",
					required_evidence: ["screenshots:1", "logs:l1"],
				},
			],
			"v2",
		);
		expect(suite.cases[0].ground_truth.required_evidence).toEqual([
			{ artifact: "logs", id: "l1" },
		]);
	});

	test("every artifact kind is representable", () => {
		expect(ARTIFACT_KINDS).toEqual(["logs", "traces", "metrics", "configuration", "source"]);
	});
});
