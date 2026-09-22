import { describe, expect, test } from "bun:test";
import {
	type CallChainTask,
	MIN_INFORMATIVE_PATH_LENGTH,
	SHORTCUT_FAILURE_FRACTION,
	type StatefulTask,
	assessSuiteValidity,
	callChainShortcut,
	scoreCallChain,
	scoreStateful,
	sliceByChainLength,
	statefulShortcut,
} from "../../src/bench/repo-reasoning.js";

function chainTask(overrides: Partial<CallChainTask> = {}): CallChainTask {
	return {
		task_id: "t1",
		entry: "api.py::handle",
		target: "commit",
		valid_paths: [["handle", "validate", "persist", "commit"]],
		target_occurrences: ["db.py", "cache.py"],
		step_files: {
			handle: "api.py",
			validate: "schema.py",
			persist: "db.py",
			commit: "db.py",
		},
		...overrides,
	};
}

function statefulTask(overrides: Partial<StatefulTask> = {}): StatefulTask {
	return {
		task_id: "s1",
		path: ["handle", "validate", "persist"],
		initial_state: [
			{ name: "count", value: "0" },
			{ name: "user", value: "alice" },
			{ name: "dirty", value: "false" },
		],
		expected_state: [
			{ name: "count", value: "1" },
			{ name: "user", value: "alice" },
			{ name: "dirty", value: "true" },
		],
		mutated_variables: ["count", "dirty"],
		...overrides,
	};
}

describe("the shortcut check on call chains", () => {
	test("a well-formed cross-file task is not shortcuttable", () => {
		expect(callChainShortcut(chainTask()).shortcuttable).toBe(false);
	});

	test("a target occurring in one file is answerable by search alone", () => {
		const finding = callChainShortcut(chainTask({ target_occurrences: ["db.py"] }));
		expect(finding.shortcuttable).toBe(true);
		expect(finding.reasons[0]).toContain("repository-wide search answers this");
	});

	test("a target occurring nowhere is likewise shortcuttable", () => {
		expect(callChainShortcut(chainTask({ target_occurrences: [] })).shortcuttable).toBe(true);
	});

	test("a path entirely within one file crosses no boundary", () => {
		const finding = callChainShortcut(
			chainTask({
				step_files: { handle: "api.py", validate: "api.py", persist: "api.py", commit: "api.py" },
			}),
		);
		expect(finding.reasons.some((r) => r.includes("nothing crosses a boundary"))).toBe(true);
	});

	test("a path too short to require traversal is shortcuttable", () => {
		const finding = callChainShortcut(chainTask({ valid_paths: [["handle", "commit"]] }));
		expect(finding.reasons.some((r) => r.includes(String(MIN_INFORMATIVE_PATH_LENGTH)))).toBe(true);
	});

	test("every reason that applies is reported, not just the first", () => {
		const finding = callChainShortcut(
			chainTask({
				target_occurrences: ["db.py"],
				valid_paths: [["handle", "commit"]],
				step_files: { handle: "api.py", commit: "api.py" },
			}),
		);
		expect(finding.reasons.length).toBeGreaterThanOrEqual(3);
	});
});

describe("the shortcut check on stateful tasks", () => {
	test("a task whose variables are all mutated is not shortcuttable", () => {
		const task = statefulTask({
			expected_state: [
				{ name: "count", value: "1" },
				{ name: "dirty", value: "true" },
			],
		});
		expect(statefulShortcut(task).shortcuttable).toBe(false);
	});

	test("a task asking only about untouched variables is answerable by copying", () => {
		const task = statefulTask({
			expected_state: [{ name: "user", value: "alice" }],
			mutated_variables: ["count"],
		});
		const finding = statefulShortcut(task);
		expect(finding.shortcuttable).toBe(true);
		expect(finding.reasons[0]).toContain("copying the initial state answers this exactly");
	});

	test("an expected state identical to the initial one is shortcuttable", () => {
		const task = statefulTask({
			expected_state: [
				{ name: "count", value: "0" },
				{ name: "user", value: "alice" },
				{ name: "dirty", value: "false" },
			],
		});
		expect(statefulShortcut(task).shortcuttable).toBe(true);
	});

	test("too short a path is shortcuttable", () => {
		expect(statefulShortcut(statefulTask({ path: ["a", "b"] })).shortcuttable).toBe(true);
	});
});

describe("several call paths can be correct", () => {
	const multi = chainTask({
		valid_paths: [
			["handle", "validate", "persist", "commit"],
			["handle", "authorize", "persist", "commit"],
		],
		step_files: {
			handle: "api.py",
			validate: "schema.py",
			authorize: "auth.py",
			persist: "db.py",
			commit: "db.py",
		},
	});

	test("either valid path scores as exact", () => {
		expect(scoreCallChain(multi, ["handle", "validate", "persist", "commit"]).exact).toBe(true);
		expect(scoreCallChain(multi, ["handle", "authorize", "persist", "commit"]).exact).toBe(true);
	});

	test("a wrong path is not exact but keeps its prefix credit", () => {
		const score = scoreCallChain(multi, ["handle", "validate", "commit"]);
		expect(score.exact).toBe(false);
		expect(score.prefix).toBeGreaterThan(0);
	});

	test("steps in no valid path at all are counted as fabricated", () => {
		const score = scoreCallChain(multi, ["handle", "teleport", "commit"]);
		expect(score.fabricated_steps).toBe(1);
	});

	test("edge precision and recall are scored against the best-matching path", () => {
		const score = scoreCallChain(multi, ["handle", "authorize", "persist", "commit"]);
		expect(score.edge_precision).toBe(1);
		expect(score.edge_recall).toBe(1);
	});

	test("an empty prediction scores zero without throwing", () => {
		const score = scoreCallChain(multi, []);
		expect(score.exact).toBe(false);
		expect(score.edge_precision).toBe(0);
		expect(score.fabricated_steps).toBe(0);
	});

	test("the shortcut verdict travels with the score", () => {
		expect(scoreCallChain(chainTask({ target_occurrences: ["db.py"] }), []).shortcuttable).toBe(
			true,
		);
	});
});

describe("state is scored per variable", () => {
	test("seven of eight right is not the same as none right", () => {
		const partial = scoreStateful(statefulTask(), [
			{ name: "count", value: "1" },
			{ name: "user", value: "alice" },
			{ name: "dirty", value: "false" },
		]);
		const none = scoreStateful(statefulTask(), [
			{ name: "count", value: "99" },
			{ name: "user", value: "bob" },
			{ name: "dirty", value: "false" },
		]);
		expect(partial.variable_accuracy).toBeGreaterThan(none.variable_accuracy);
		expect(partial.exact_state).toBe(false);
		expect(none.exact_state).toBe(false);
	});

	test("a perfect prediction is exact", () => {
		const score = scoreStateful(statefulTask(), statefulTask().expected_state);
		expect(score.exact_state).toBe(true);
		expect(score.variable_accuracy).toBe(1);
	});

	test("mutated-variable accuracy is the number that reflects execution", () => {
		// Copies the initial state: correct on the untouched variable only.
		const score = scoreStateful(statefulTask(), statefulTask().initial_state);
		expect(score.variable_accuracy).toBeCloseTo(1 / 3, 5);
		expect(score.mutated_variable_accuracy).toBe(0);
	});

	test("a task with no mutated variables yields null rather than a flattering 1", () => {
		const task = statefulTask({ mutated_variables: [] });
		expect(scoreStateful(task, task.expected_state).mutated_variable_accuracy).toBeNull();
	});

	test("extra and missing variables are counted separately", () => {
		const score = scoreStateful(statefulTask(), [
			{ name: "count", value: "1" },
			{ name: "extra", value: "x" },
		]);
		expect(score.extra_variables).toBe(1);
		expect(score.missing_variables).toBe(2);
	});

	test("an empty expected state does not divide by zero", () => {
		const score = scoreStateful(statefulTask({ expected_state: [] }), []);
		expect(score.variable_accuracy).toBe(0);
		expect(score.mutated_variable_accuracy).toBeNull();
	});
});

describe("suite validity is assessed before any accuracy is quoted", () => {
	test("a clean suite is a cross-file benchmark", () => {
		const findings = Array.from({ length: 10 }, (_, i) =>
			callChainShortcut(chainTask({ task_id: `t${i}` })),
		);
		const validity = assessSuiteValidity(findings);
		expect(validity.verdict).toBe("cross_file");
		expect(validity.detail).toContain("no task is answerable without traversal");
	});

	test("a mostly-shortcuttable suite is not a cross-file benchmark", () => {
		const findings = Array.from({ length: 10 }, (_, i) =>
			callChainShortcut(
				chainTask({ task_id: `t${i}`, target_occurrences: i < 8 ? ["db.py"] : ["db.py", "x.py"] }),
			),
		);
		const validity = assessSuiteValidity(findings);
		expect(validity.shortcut_fraction).toBeGreaterThan(SHORTCUT_FAILURE_FRACTION);
		expect(validity.verdict).toBe("not_a_cross_file_benchmark");
		expect(validity.detail).toContain("not evidence of cross-file reasoning");
	});

	test("a partly-shortcuttable suite says the affected tasks are excluded", () => {
		const findings = Array.from({ length: 10 }, (_, i) =>
			callChainShortcut(
				chainTask({ task_id: `t${i}`, target_occurrences: i < 3 ? ["db.py"] : ["db.py", "x.py"] }),
			),
		);
		const validity = assessSuiteValidity(findings);
		expect(validity.verdict).toBe("partly_shortcuttable");
		expect(validity.detail).toContain("excluded from the headline number");
	});

	test("reasons are grouped rather than fragmented by per-task detail", () => {
		const findings = Array.from({ length: 6 }, (_, i) =>
			callChainShortcut(chainTask({ task_id: `t${i}`, target: `sym${i}`, target_occurrences: [] })),
		);
		const validity = assessSuiteValidity(findings);
		expect(validity.reasons).toHaveLength(1);
		expect(validity.reasons[0].tasks).toBe(6);
	});

	test("an empty suite is vacuously clean", () => {
		const validity = assessSuiteValidity([]);
		expect(validity.tasks).toBe(0);
		expect(validity.shortcut_fraction).toBe(0);
		expect(validity.verdict).toBe("cross_file");
	});
});

describe("slicing by chain length", () => {
	test("shortcuttable tasks are excluded from the slices", () => {
		const scores = [
			scoreCallChain(chainTask({ target_occurrences: ["db.py"] }), []),
			scoreCallChain(chainTask(), ["handle", "validate", "persist", "commit"]),
		];
		const slices = sliceByChainLength(scores);
		expect(slices.reduce((sum, s) => sum + s.tasks, 0)).toBe(1);
	});

	test("accuracy is reported per length, in ascending order", () => {
		const short = chainTask({
			task_id: "short",
			valid_paths: [["a", "b", "c"]],
			step_files: { a: "x.py", b: "y.py", c: "z.py" },
		});
		const long = chainTask({
			task_id: "long",
			valid_paths: [["a", "b", "c", "d", "e"]],
			step_files: { a: "x.py", b: "y.py", c: "z.py", d: "w.py", e: "v.py" },
		});
		const slices = sliceByChainLength([
			scoreCallChain(short, ["a", "b", "c"]),
			scoreCallChain(long, ["a", "b", "wrong", "d", "e"]),
		]);
		expect(slices.map((s) => s.length)).toEqual([3, 5]);
		expect(slices[0].exact_accuracy).toBe(1);
		expect(slices[1].exact_accuracy).toBe(0);
		expect(slices[1].mean_prefix).toBeGreaterThan(0);
	});

	test("no eligible scores yields no slices", () => {
		expect(sliceByChainLength([])).toEqual([]);
	});
});
