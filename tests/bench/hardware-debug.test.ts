import { describe, expect, test } from "bun:test";
import {
	HW_ARTIFACTS,
	HW_BENCH_VERSION,
	HW_BUG_CLASS_NAMES,
	type HwCase,
	type HwPrediction,
	HwSuiteSchema,
	aggregateHardware,
	fromHardwareRows,
	pathDistance,
	scoreHwCase,
	scoreHwSuite,
	softwareAnalogue,
	validateHwSuite,
} from "../../src/bench/hardware-debug.js";

function hwCase(overrides: Partial<HwCase> = {}): HwCase {
	return {
		case_id: "hw-1",
		available_artifacts: ["rtl", "testbench", "constraint"],
		candidate_paths: ["tb.dut", "tb.dut.alu", "tb.dut.alu.adder", "tb.dut.fifo"],
		ground_truth: {
			instance_path: "tb.dut.alu.adder",
			file: "rtl/adder.v",
			line: 42,
			bug_class: "width_truncation",
			software_analogue_trap: true,
			required_artifacts: ["rtl", "constraint"],
		},
		...overrides,
	};
}

function pred(overrides: Partial<HwPrediction> = {}): HwPrediction {
	return { case_id: "hw-1", ranked_paths: [], edited_artifacts: [], ...overrides };
}

describe("hierarchical localization", () => {
	test("an exact instance path is distance zero", () => {
		expect(pathDistance("tb.dut.alu", "tb.dut.alu")).toBe(0);
	});

	test("an ancestor is positive: too coarse, not simply wrong", () => {
		expect(pathDistance("tb.dut", "tb.dut.alu.adder")).toBe(2);
	});

	test("a descendant is negative: too specific", () => {
		expect(pathDistance("tb.dut.alu.adder.carry", "tb.dut.alu.adder")).toBe(-1);
	});

	test("a divergent path is a plain miss, not a distance", () => {
		expect(pathDistance("tb.dut.fifo", "tb.dut.alu.adder")).toBeNull();
		expect(pathDistance("other.tree", "tb.dut")).toBeNull();
	});

	test("naming the parent counts as a hierarchical hit but not an exact one", () => {
		const score = scoreHwCase(
			hwCase(),
			pred({ ranked_paths: ["tb.dut.alu", "tb.dut.alu.adder"] }),
		);
		expect(score.localization.exact).toBe(false);
		expect(score.localization.hierarchical).toBe(true);
		expect(score.localization.top_distance).toBe(1);
		expect(score.localization.rank).toBe(1);
		expect(score.localization.reciprocal_rank).toBe(0.5);
	});

	test("naming the grandparent exceeds the default tolerance", () => {
		const score = scoreHwCase(hwCase(), pred({ ranked_paths: ["tb.dut"] }));
		expect(score.localization.hierarchical).toBe(false);
		expect(score.localization.top_distance).toBe(2);
	});

	test("the tolerance is configurable", () => {
		const score = scoreHwCase(hwCase(), pred({ ranked_paths: ["tb.dut"] }), {
			ancestor_tolerance: 2,
		});
		expect(score.localization.hierarchical).toBe(true);
	});

	test("a descendant is never a hierarchical hit: over-specific is a different error", () => {
		const score = scoreHwCase(
			hwCase(),
			pred({ ranked_paths: ["tb.dut.alu.adder.carry"] }),
			{ ancestor_tolerance: 5 },
		);
		expect(score.localization.hierarchical).toBe(false);
		expect(score.localization.top_distance).toBe(-1);
	});

	test("file and line are scored independently of the path", () => {
		const score = scoreHwCase(
			hwCase(),
			pred({ ranked_paths: ["tb.dut.fifo"], predicted_file: "rtl/adder.v", predicted_line: 42 }),
		);
		expect(score.localization.exact).toBe(false);
		expect(score.localization.file_correct).toBe(true);
		expect(score.localization.line_correct).toBe(true);
	});

	test("a case with no ground-truth line cannot score a line hit", () => {
		const noLine = hwCase({
			ground_truth: { ...hwCase().ground_truth, line: undefined },
		});
		const score = scoreHwCase(noLine, pred({ predicted_line: 42 }));
		expect(score.localization.line_correct).toBe(false);
	});

	test("an empty ranking is an abstention with no distance", () => {
		const score = scoreHwCase(hwCase(), pred());
		expect(score.localization.abstained).toBe(true);
		expect(score.localization.top_distance).toBeNull();
		expect(score.localization.hierarchical).toBe(false);
	});
});

describe("hardware semantics and the software-analogue trap", () => {
	test("every bug class declares the software misreading it invites", () => {
		for (const name of HW_BUG_CLASS_NAMES) {
			expect(softwareAnalogue(name).length).toBeGreaterThan(0);
			expect(HW_BUG_CLASS_NAMES).not.toContain(softwareAnalogue(name));
		}
	});

	test("the canonical traps are the ones a software reasoner actually falls for", () => {
		expect(softwareAnalogue("clock_domain_crossing")).toBe("data_race");
		expect(softwareAnalogue("reset_polarity")).toBe("boolean_inversion");
		expect(softwareAnalogue("blocking_assignment")).toBe("statement_ordering");
	});

	test("the correct class scores correct and is not flagged as a trap", () => {
		const score = scoreHwCase(hwCase(), pred({ bug_class: "width_truncation" }));
		expect(score.semantics.correct).toBe(true);
		expect(score.semantics.fell_for_software_analogue).toBe(false);
	});

	test("the analogue is flagged specifically, not merely counted as wrong", () => {
		const score = scoreHwCase(hwCase(), pred({ bug_class: "implicit_cast" }));
		expect(score.semantics.correct).toBe(false);
		expect(score.semantics.fell_for_software_analogue).toBe(true);
	});

	test("an unrelated wrong class is wrong without being the trap", () => {
		const score = scoreHwCase(hwCase(), pred({ bug_class: "fsm_deadlock" }));
		expect(score.semantics.correct).toBe(false);
		expect(score.semantics.fell_for_software_analogue).toBe(false);
	});

	test("omitting a class is an abstention, not a wrong class", () => {
		const score = scoreHwCase(hwCase(), pred());
		expect(score.semantics.abstained).toBe(true);
		expect(score.semantics.correct).toBe(false);
		expect(score.semantics.predicted).toBeUndefined();
	});
});

describe("cross-artifact coordination", () => {
	test("touching every required artifact is complete", () => {
		const score = scoreHwCase(hwCase(), pred({ edited_artifacts: ["rtl", "constraint"] }));
		expect(score.coordination.complete).toBe(true);
		expect(score.coordination.missing).toEqual([]);
		expect(score.coordination.multi_artifact).toBe(true);
	});

	test("the classic failure — fixed the RTL, forgot the constraint — is named", () => {
		const score = scoreHwCase(hwCase(), pred({ edited_artifacts: ["rtl"] }));
		expect(score.coordination.complete).toBe(false);
		expect(score.coordination.missing).toEqual(["constraint"]);
	});

	test("spurious edits are counted apart from missing ones", () => {
		const score = scoreHwCase(
			hwCase(),
			pred({ edited_artifacts: ["rtl", "constraint", "testbench"] }),
		);
		expect(score.coordination.complete).toBe(true);
		expect(score.coordination.spurious).toEqual(["testbench"]);
		expect(score.coordination.missing).toEqual([]);
	});

	test("editing an artifact the case never supplied is counted separately", () => {
		const score = scoreHwCase(
			hwCase(),
			pred({ edited_artifacts: ["rtl", "constraint", "waveform"] }),
		);
		expect(score.coordination.unavailable).toEqual(["waveform"]);
	});

	test("duplicate edits cannot manufacture coverage", () => {
		const score = scoreHwCase(
			hwCase(),
			pred({ edited_artifacts: ["rtl", "rtl", "rtl"] }),
		);
		expect(score.coordination.edited).toEqual(["rtl"]);
		expect(score.coordination.complete).toBe(false);
	});

	test("a single-artifact fix is labelled as such", () => {
		const single = hwCase({
			ground_truth: { ...hwCase().ground_truth, required_artifacts: ["rtl"] },
		});
		const score = scoreHwCase(single, pred({ edited_artifacts: ["rtl"] }));
		expect(score.coordination.multi_artifact).toBe(false);
		expect(score.coordination.complete).toBe(true);
	});
});

describe("aggregation and slices", () => {
	const suite = HwSuiteSchema.parse({
		schema_version: HW_BENCH_VERSION,
		dataset_version: "test",
		created_at: "2026-08-24T00:00:00.000Z",
		cases: [
			hwCase(),
			hwCase({
				case_id: "hw-2",
				ground_truth: {
					instance_path: "tb.dut.fifo",
					file: "rtl/fifo.v",
					bug_class: "clock_domain_crossing",
					software_analogue_trap: false,
					required_artifacts: ["rtl"],
				},
			}),
		],
	});

	test("the multi-artifact slice exposes coordination collapse", () => {
		const report = aggregateHardware(
			scoreHwSuite(suite, [
				pred({ case_id: "hw-1", edited_artifacts: ["rtl"] }),
				pred({ case_id: "hw-2", edited_artifacts: ["rtl"] }),
			]),
		);
		const single = report.coordination.by_span.find((s) => s.span === "single_artifact");
		const multi = report.coordination.by_span.find((s) => s.span === "multi_artifact");
		expect(single?.completion_rate).toBe(1);
		expect(multi?.completion_rate).toBe(0);
		expect(report.coordination.completion_rate).toBe(0.5);
		expect(report.coordination.mean_missing).toBe(0.5);
	});

	test("the trapped slice separates the hard cases from the easy ones", () => {
		const report = aggregateHardware(
			scoreHwSuite(suite, [
				pred({ case_id: "hw-1", bug_class: "implicit_cast" }),
				pred({ case_id: "hw-2", bug_class: "clock_domain_crossing" }),
			]),
		);
		expect(report.semantics.accuracy).toBe(0.5);
		const trapped = report.semantics.by_trap.find((s) => s.trapped);
		const untrapped = report.semantics.by_trap.find((s) => !s.trapped);
		expect(trapped?.accuracy).toBe(0);
		expect(trapped?.software_analogue_rate).toBe(1);
		expect(untrapped?.accuracy).toBe(1);
	});

	test("too-coarse and too-specific answers are reported separately", () => {
		const report = aggregateHardware(
			scoreHwSuite(suite, [
				pred({ case_id: "hw-1", ranked_paths: ["tb.dut"] }),
				pred({ case_id: "hw-2", ranked_paths: ["tb.dut.fifo.ptr"] }),
			]),
		);
		expect(report.localization.too_coarse_rate).toBe(0.5);
		expect(report.localization.too_specific_rate).toBe(0.5);
		expect(report.localization.exact_accuracy).toBe(0);
	});

	test("a missing prediction is a full abstention rather than a skip", () => {
		const scores = scoreHwSuite(suite, [pred({ case_id: "hw-1", ranked_paths: ["tb.dut.alu.adder"] })]);
		expect(scores).toHaveLength(2);
		const report = aggregateHardware(scores);
		expect(report.localization.abstention_rate).toBe(0.5);
		expect(report.semantics.abstention_rate).toBe(1);
	});

	test("artifact availability slices list only supplied kinds", () => {
		const report = aggregateHardware(scoreHwSuite(suite, []));
		const kinds = report.slices.map((s) => s.artifact);
		expect(kinds).toContain("rtl");
		expect(kinds).toContain("constraint");
		expect(kinds).not.toContain("waveform");
	});

	test("an empty score set aggregates to zeros rather than NaN", () => {
		const report = aggregateHardware([]);
		expect(report.cases).toBe(0);
		expect(report.localization.mean_reciprocal_rank).toBe(0);
		expect(report.coordination.by_span).toEqual([]);
		expect(report.semantics.by_trap).toEqual([]);
		expect(report.slices).toEqual([]);
	});
});

describe("suite validation", () => {
	function suiteOf(cases: HwCase[]) {
		return HwSuiteSchema.parse({
			schema_version: HW_BENCH_VERSION,
			dataset_version: "test",
			created_at: "2026-08-24T00:00:00.000Z",
			cases,
		});
	}

	test("a well-formed suite has no issues", () => {
		expect(validateHwSuite(suiteOf([hwCase()]))).toEqual([]);
	});

	test("duplicate case ids are rejected", () => {
		expect(
			validateHwSuite(suiteOf([hwCase(), hwCase()])).some((i) => i.problem.includes("duplicate")),
		).toBe(true);
	});

	test("a truth path outside the candidates is unanswerable", () => {
		const issues = validateHwSuite(suiteOf([hwCase({ candidate_paths: ["tb.dut.fifo"] })]));
		expect(issues.some((i) => i.problem.includes("not among candidate_paths"))).toBe(true);
	});

	test("requiring an artifact the case does not supply is rejected", () => {
		const issues = validateHwSuite(
			suiteOf([hwCase({ available_artifacts: ["rtl", "testbench"] })]),
		);
		expect(issues.some((i) => i.problem.includes("which the case does not supply"))).toBe(true);
	});

	test("a case with no RTL cannot be localized at all", () => {
		const issues = validateHwSuite(
			suiteOf([
				hwCase({
					available_artifacts: ["testbench", "constraint"],
					ground_truth: { ...hwCase().ground_truth, required_artifacts: ["constraint"] },
				}),
			]),
		);
		expect(issues.some((i) => i.problem.includes("no RTL supplied"))).toBe(true);
	});
});

describe("row normalization", () => {
	test("a row with an unknown bug class is skipped, not coerced", () => {
		const suite = fromHardwareRows(
			[
				{ id: "a", bug_class: "off_by_one", instance_path: "tb.dut", file: "a.v" },
				{ id: "b", bug_class: "reset_polarity", instance_path: "tb.dut", file: "b.v" },
			],
			"v1",
		);
		expect(suite.cases).toHaveLength(1);
		expect(suite.cases[0].case_id).toBe("b");
	});

	test("rows without a path or file are skipped", () => {
		expect(
			fromHardwareRows([{ id: "a", bug_class: "reset_polarity", file: "a.v" }], "v1").cases,
		).toHaveLength(0);
	});

	test("rtl is always available and the truth path always a candidate", () => {
		const suite = fromHardwareRows(
			[
				{
					id: "b",
					bug_class: "reset_polarity",
					instance_path: "tb.dut.rst",
					file: "b.v",
					candidate_paths: ["tb.dut.other"],
				},
			],
			"v1",
		);
		expect(suite.cases[0].available_artifacts).toContain("rtl");
		expect(suite.cases[0].candidate_paths).toContain("tb.dut.rst");
		expect(validateHwSuite(suite)).toEqual([]);
	});

	test("required artifacts are added to availability so a case stays answerable", () => {
		const suite = fromHardwareRows(
			[
				{
					id: "b",
					bug_class: "timing_violation",
					instance_path: "tb.dut",
					file: "b.v",
					required_artifacts: ["rtl", "constraint"],
				},
			],
			"v1",
		);
		expect(suite.cases[0].available_artifacts).toContain("constraint");
		expect(validateHwSuite(suite)).toEqual([]);
	});

	test("an absent trap flag defaults to untrapped rather than inflating the hard slice", () => {
		const suite = fromHardwareRows(
			[{ id: "b", bug_class: "reset_polarity", instance_path: "tb.dut", file: "b.v" }],
			"v1",
		);
		expect(suite.cases[0].ground_truth.software_analogue_trap).toBe(false);
	});

	test("unknown artifact names are dropped rather than passed through", () => {
		const suite = fromHardwareRows(
			[
				{
					id: "b",
					bug_class: "reset_polarity",
					instance_path: "tb.dut",
					file: "b.v",
					available_artifacts: ["rtl", "netlist"],
				},
			],
			"v1",
		);
		for (const artifact of suite.cases[0].available_artifacts) {
			expect(HW_ARTIFACTS as readonly string[]).toContain(artifact);
		}
	});
});
