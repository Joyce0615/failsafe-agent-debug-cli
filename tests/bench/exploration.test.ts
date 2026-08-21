import { describe, expect, test } from "bun:test";
import {
	DEFAULT_RANK_KS,
	EXPLORATION_ACTIONS,
	type ExplorationCase,
	type ExplorationTrace,
	ExplorationCaseSchema,
	ExplorationTraceSchema,
	WELL_EXPLORED_RECALL,
	contingency,
	efficiencyScore,
	explorationReport,
	pathScore,
	rankScore,
	readOrderOf,
	scoreExploration,
	scoreExplorationCases,
	setScore,
	validateExplorationCases,
} from "../../src/bench/exploration.js";

function caseFixture(overrides: Partial<ExplorationCase> = {}): ExplorationCase {
	return ExplorationCaseSchema.parse({
		case_id: "e1",
		relevant: {
			files: ["src/api.py", "src/service.py", "src/store.py"],
			functions: ["handle_request", "persist"],
			tests: ["tests/test_api.py"],
			dependency_paths: [["src/api.py", "src/service.py", "src/store.py"]],
		},
		...overrides,
	});
}

function trace(files: string[], overrides: Partial<ExplorationTrace> = {}): ExplorationTrace {
	return ExplorationTraceSchema.parse({
		case_id: "e1",
		steps: files.map((target, index) => ({ index, kind: "read", target })),
		ranked_files: files,
		...overrides,
	});
}

describe("set scoring", () => {
	test("exact retrieval is perfect precision and recall", () => {
		const s = setScore(["a", "b"], ["a", "b"]);
		expect(s.precision).toBe(1);
		expect(s.recall).toBe(1);
		expect(s.f1).toBe(1);
	});

	test("extra retrievals cost precision, missing ones cost recall", () => {
		expect(setScore(["a", "b", "c"], ["a", "b"]).precision).toBeCloseTo(2 / 3, 10);
		expect(setScore(["a"], ["a", "b"]).recall).toBeCloseTo(0.5, 10);
	});

	test("duplicates in the retrieved set do not inflate the count", () => {
		expect(setScore(["a", "a", "a"], ["a"]).retrieved).toBe(1);
	});

	test("an empty ground truth gives full recall but not free precision", () => {
		const s = setScore(["x"], []);
		expect(s.recall).toBe(1);
		expect(s.precision).toBe(0);
	});
});

describe("dependency-path traversal", () => {
	const chain = [["a", "b", "c"]];

	test("reading a chain in order counts as in-order traversal", () => {
		const s = pathScore(["a", "b", "c"], chain);
		expect(s.traversed_in_order).toBe(1);
		expect(s.traversed_any_order).toBe(1);
		expect(s.mean_hop_coverage).toBe(1);
	});

	test("reading both ends without the middle is not traversal", () => {
		const s = pathScore(["a", "c"], chain);
		expect(s.traversed_any_order).toBe(0);
		expect(s.mean_hop_coverage).toBeCloseTo(2 / 3, 10);
	});

	test("reading every hop out of order is counted but distinguished", () => {
		const s = pathScore(["c", "b", "a"], chain);
		expect(s.traversed_any_order).toBe(1);
		expect(s.traversed_in_order).toBe(0);
	});

	test("only the first read of a file establishes its position", () => {
		// a is re-read after c; the first occurrence still orders the chain.
		const s = pathScore(["a", "b", "c", "a"], chain);
		expect(s.traversed_in_order).toBe(1);
	});

	test("a case with no chains is vacuously fully traversed", () => {
		const s = pathScore([], []);
		expect(s.in_order_rate).toBe(1);
		expect(s.mean_hop_coverage).toBe(1);
	});
});

describe("ranking", () => {
	test("a relevant file first scores MRR 1", () => {
		expect(rankScore(["a", "x"], ["a"]).mean_reciprocal_rank).toBe(1);
	});

	test("burying the relevant file lowers MRR", () => {
		expect(rankScore(["x", "y", "a"], ["a"]).mean_reciprocal_rank).toBeCloseTo(1 / 3, 10);
	});

	test("recall@k grows with k", () => {
		const s = rankScore(["x", "a", "y", "b"], ["a", "b"], [1, 2, 4]);
		expect(s.recall_at_k[1]).toBe(0);
		expect(s.recall_at_k[2]).toBeCloseTo(0.5, 10);
		expect(s.recall_at_k[4]).toBe(1);
	});

	test("an empty ranking scores zero, not a free pass", () => {
		expect(rankScore([], ["a"]).mean_reciprocal_rank).toBe(0);
		expect(DEFAULT_RANK_KS).toEqual([1, 5, 10]);
	});
});

describe("efficiency", () => {
	test("read precision reflects the share of distinct reads that mattered", () => {
		const s = efficiencyScore(["a", "x", "y"], ["a"]);
		expect(s.read_precision).toBeCloseTo(1 / 3, 10);
		expect(s.distinct_reads).toBe(3);
	});

	test("re-reads are counted as redundant, not as new reads", () => {
		const s = efficiencyScore(["a", "a", "a"], ["a"]);
		expect(s.distinct_reads).toBe(1);
		expect(s.redundant_reads).toBe(2);
		expect(s.total_reads).toBe(3);
	});

	test("time-to-first-relevant is the index of the first useful read", () => {
		expect(efficiencyScore(["x", "y", "a"], ["a"]).steps_to_first_relevant).toBe(2);
	});

	test("never reaching a relevant file is null, not zero", () => {
		expect(efficiencyScore(["x"], ["a"]).steps_to_first_relevant).toBeNull();
	});
});

describe("case scoring", () => {
	test("a thorough, ordered exploration scores well on every axis", () => {
		const s = scoreExploration(
			caseFixture(),
			ExplorationTraceSchema.parse({
				case_id: "e1",
				steps: [
					{ index: 0, kind: "read", target: "src/api.py", symbol: "handle_request" },
					{ index: 1, kind: "read", target: "src/service.py" },
					{ index: 2, kind: "read", target: "src/store.py", symbol: "persist" },
					{ index: 3, kind: "read", target: "tests/test_api.py" },
				],
				ranked_files: ["src/store.py", "src/service.py", "src/api.py"],
			}),
		);
		expect(s.files.recall).toBe(1);
		expect(s.functions.recall).toBe(1);
		expect(s.tests.recall).toBe(1);
		expect(s.paths.traversed_in_order).toBe(1);
		expect(s.ranking.mean_reciprocal_rank).toBe(1);
		expect(s.explored_well).toBe(true);
	});

	test("reading the right file but the wrong function is visible", () => {
		const s = scoreExploration(
			caseFixture(),
			ExplorationTraceSchema.parse({
				case_id: "e1",
				steps: [{ index: 0, kind: "read", target: "src/api.py", symbol: "unrelated_helper" }],
				ranked_files: ["src/api.py"],
			}),
		);
		expect(s.files.matched).toBe(1);
		expect(s.functions.recall).toBe(0);
	});

	test("non-read steps do not count as having read anything", () => {
		const s = scoreExploration(
			caseFixture(),
			ExplorationTraceSchema.parse({
				case_id: "e1",
				steps: [
					{ index: 0, kind: "search", target: "src/api.py" },
					{ index: 1, kind: "list", target: "src" },
				],
				ranked_files: ["src/api.py"],
			}),
		);
		expect(s.files.matched).toBe(0);
		expect(readOrderOf(ExplorationTraceSchema.parse({ case_id: "e1" }))).toEqual([]);
	});

	test("a shallow exploration falls below the well-explored threshold", () => {
		const s = scoreExploration(caseFixture(), trace(["src/api.py"]));
		expect(s.files.recall).toBeCloseTo(1 / 3, 10);
		expect(s.explored_well).toBe(false);
		expect(WELL_EXPLORED_RECALL).toBe(0.7);
	});

	test("an empty trace is scored, not skipped", () => {
		const scores = scoreExplorationCases([caseFixture()], []);
		expect(scores).toHaveLength(1);
		expect(scores[0].files.recall).toBe(0);
		expect(scores[0].explored_well).toBe(false);
	});

	test("every action kind is representable", () => {
		expect(EXPLORATION_ACTIONS).toEqual(["list", "search", "read", "rank"]);
	});
});

describe("independence from patch success", () => {
	function scored(recallFiles: string[], resolved: boolean) {
		return scoreExploration(caseFixture(), trace(recallFiles, { patch_resolved: resolved }));
	}

	test("patch success never enters an exploration metric", () => {
		const explored = ["src/api.py", "src/service.py", "src/store.py"];
		const passed = scored(explored, true);
		const failed = scored(explored, false);
		expect(passed.files).toEqual(failed.files);
		expect(passed.ranking).toEqual(failed.ranking);
		expect(passed.efficiency).toEqual(failed.efficiency);
	});

	test("the off-diagonal cells are reported, not averaged away", () => {
		const table = contingency([
			scored(["src/api.py", "src/service.py", "src/store.py"], false),
			scored(["src/other.py"], true),
		]);
		expect(table.explored_well_but_failed).toBe(1);
		expect(table.explored_poorly_but_passed).toBe(1);
	});

	test("a guessable corpus shows a negative or zero association", () => {
		const table = contingency([
			scored(["src/api.py", "src/service.py", "src/store.py"], false),
			scored(["src/other.py"], true),
		]);
		expect(table.phi).toBeLessThanOrEqual(0);
	});

	test("a corpus where exploration predicts success shows a positive phi", () => {
		const table = contingency([
			scored(["src/api.py", "src/service.py", "src/store.py"], true),
			scored(["src/other.py"], false),
		]);
		expect(table.phi).toBeGreaterThan(0);
	});

	test("cases with an unknown patch outcome are excluded from the table", () => {
		const table = contingency([scoreExploration(caseFixture(), trace(["src/api.py"]))]);
		expect(table.cases).toBe(0);
		expect(table.phi).toBe(0);
	});
});

describe("report", () => {
	test("aggregates every axis and carries the contingency table", () => {
		const scores = scoreExplorationCases(
			[caseFixture(), caseFixture({ case_id: "e2" })],
			[
				trace(["src/api.py", "src/service.py", "src/store.py"], { patch_resolved: true }),
				ExplorationTraceSchema.parse({
					case_id: "e2",
					steps: [{ index: 0, kind: "read", target: "src/api.py" }],
					ranked_files: ["src/api.py"],
					patch_resolved: false,
				}),
			],
		);
		const report = explorationReport(scores);
		expect(report.cases).toBe(2);
		expect(report.files.mean_recall).toBeCloseTo((1 + 1 / 3) / 2, 10);
		expect(report.patch_independence.cases).toBe(2);
		expect(report.paths.in_order_rate).toBeCloseTo(0.5, 10);
	});

	test("cases that never reached a relevant file are counted, not averaged in", () => {
		const scores = scoreExplorationCases([caseFixture()], [trace(["src/nothing.py"])]);
		const report = explorationReport(scores);
		expect(report.efficiency.never_reached_relevant).toBe(1);
		expect(report.efficiency.mean_steps_to_first_relevant).toBe(0);
	});

	test("an empty score set reports zeros rather than NaN", () => {
		const report = explorationReport([]);
		expect(report.cases).toBe(0);
		expect(report.files.mean_f1).toBe(0);
		expect(report.ranking.mean_reciprocal_rank).toBe(0);
	});
});

describe("corpus validation", () => {
	test("a well-formed case has no issues", () => {
		expect(validateExplorationCases([caseFixture()])).toEqual([]);
	});

	test("duplicate case ids are rejected", () => {
		expect(
			validateExplorationCases([caseFixture(), caseFixture()]).some((i) =>
				i.problem.includes("duplicate"),
			),
		).toBe(true);
	});

	test("a case with no relevant files cannot be scored", () => {
		const issues = validateExplorationCases([
			ExplorationCaseSchema.parse({ case_id: "x", relevant: {} }),
		]);
		expect(issues.some((i) => i.problem.includes("unscoreable"))).toBe(true);
	});

	test("a dependency chain naming a file outside the relevant set is rejected", () => {
		const issues = validateExplorationCases([
			caseFixture({
				relevant: {
					files: ["a", "b"],
					functions: [],
					tests: [],
					dependency_paths: [["a", "ghost"]],
				},
			}),
		]);
		expect(issues.some((i) => i.problem.includes("'ghost'"))).toBe(true);
	});

	test("a chain that repeats a file has undefined in-order semantics", () => {
		const issues = validateExplorationCases([
			caseFixture({
				relevant: { files: ["a"], functions: [], tests: [], dependency_paths: [["a", "a"]] },
			}),
		]);
		expect(issues.some((i) => i.problem.includes("repeats a file"))).toBe(true);
	});
});
