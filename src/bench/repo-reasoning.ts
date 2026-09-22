/**
 * RepoReasoner-style cross-file call-chain and stateful-execution tasks
 * (item 82).
 *
 * These tasks are meant to test whether a system can follow control and data
 * across file boundaries. Whether they actually test that is a separate
 * question, and it is the one this module spends most of its effort on, because
 * the failure is silent: a "cross-file reasoning" suite where the answer is
 * inferable from the entry point alone measures string matching and reports it
 * as reasoning.
 *
 * So the central construct here is the **shortcut check**. Before any accuracy
 * is quoted, every task is examined for whether its answer could be reached
 * without traversing the chain: a target symbol that appears in exactly one
 * file, a state variable that is never modified along the path, a chain whose
 * every step is in the same file. Shortcuttable tasks are excluded from the
 * headline number and reported separately, and a suite that is mostly
 * shortcuttable is not a cross-file benchmark whatever it is called.
 *
 * Two further decisions:
 *
 * - **Several call paths can be correct.** Dynamic dispatch, overrides, and
 *   optional middleware mean the ground truth is a *set* of valid paths, and a
 *   system naming any of them is right. Scoring against one canonical path
 *   would penalize systems that understood the code better than the annotator.
 *
 * - **State is scored per variable, not as a whole.** A prediction that gets
 *   seven of eight variables right is not as wrong as one that gets none, and
 *   whole-state equality — the obvious implementation — says it is.
 *
 * Pure: no I/O, no execution.
 */

export type CallEdge = { from: string; to: string; file: string };

export type CallChainTask = {
	task_id: string;
	/** Where execution starts, as `file::symbol`. */
	entry: string;
	/** The symbol whose reachability is being asked about. */
	target: string;
	/** Every path from entry to target that is genuinely valid. */
	valid_paths: string[][];
	/** Files the target symbol appears in anywhere in the repository. */
	target_occurrences: string[];
	/** Files each path step lives in, for the same-file check. */
	step_files: Record<string, string>;
};

export type StateVariable = { name: string; value: string };

export type StatefulTask = {
	task_id: string;
	/** The call path the state flows along. */
	path: string[];
	initial_state: StateVariable[];
	/** State at the point being asked about. */
	expected_state: StateVariable[];
	/** Variables actually written somewhere along the path. */
	mutated_variables: string[];
};

export type ShortcutFinding = {
	task_id: string;
	shortcuttable: boolean;
	reasons: string[];
};

/** A chain shorter than this cannot demonstrate cross-file traversal. */
export const MIN_INFORMATIVE_PATH_LENGTH = 3;

/**
 * Can this call-chain task be answered without following the chain?
 *
 * Three ways it can be, each of which has appeared in a real benchmark:
 * the target occurs in exactly one file (grep answers it), every step of every
 * valid path is in the same file (nothing crosses a boundary), or the shortest
 * valid path is too short to require traversal at all.
 */
export function callChainShortcut(task: CallChainTask): ShortcutFinding {
	const reasons: string[] = [];

	if (task.target_occurrences.length <= 1) {
		reasons.push(
			`'${task.target}' occurs in ${task.target_occurrences.length} file(s); a repository-wide search answers this without following anything`,
		);
	}

	const crossesFiles = task.valid_paths.some((path) => {
		const files = new Set(path.map((step) => task.step_files[step]).filter(Boolean));
		return files.size > 1;
	});
	if (!crossesFiles && task.valid_paths.length > 0) {
		reasons.push("every step of every valid path is in one file; nothing crosses a boundary");
	}

	const shortest = Math.min(...task.valid_paths.map((p) => p.length), Number.POSITIVE_INFINITY);
	if (Number.isFinite(shortest) && shortest < MIN_INFORMATIVE_PATH_LENGTH) {
		reasons.push(
			`the shortest valid path has ${shortest} step(s), below the ${MIN_INFORMATIVE_PATH_LENGTH} needed to require traversal`,
		);
	}

	return { task_id: task.task_id, shortcuttable: reasons.length > 0, reasons };
}

/**
 * Can this stateful task be answered without executing anything?
 *
 * If no variable the question asks about is ever written along the path, the
 * answer is the initial state and copying it scores perfectly.
 */
export function statefulShortcut(task: StatefulTask): ShortcutFinding {
	const reasons: string[] = [];
	const mutated = new Set(task.mutated_variables);
	const asked = task.expected_state.map((v) => v.name);

	if (asked.every((name) => !mutated.has(name))) {
		reasons.push(
			"no variable in the expected state is written along the path; copying the initial state answers this exactly",
		);
	}
	const initial = new Map(task.initial_state.map((v) => [v.name, v.value]));
	if (task.expected_state.every((v) => initial.get(v.name) === v.value)) {
		reasons.push("the expected state is identical to the initial state");
	}
	if (task.path.length < MIN_INFORMATIVE_PATH_LENGTH) {
		reasons.push(`the path has ${task.path.length} step(s), too few to require execution`);
	}

	return { task_id: task.task_id, shortcuttable: reasons.length > 0, reasons };
}

export type CallChainScore = {
	task_id: string;
	/** The prediction matched one of the valid paths exactly. */
	exact: boolean;
	/** Fraction of the best-matching valid path reproduced before diverging. */
	prefix: number;
	/** Edge-level precision against the best-matching valid path. */
	edge_precision: number;
	edge_recall: number;
	/** Steps predicted that appear in no valid path at all. */
	fabricated_steps: number;
	/** Length of the shortest valid path, for slicing by difficulty. */
	path_length: number;
	shortcuttable: boolean;
};

function edgesOf(path: string[]): string[] {
	return path.slice(0, -1).map((step, i) => `${step}->${path[i + 1]}`);
}

/**
 * Score a predicted call path.
 *
 * Compared against the *best-matching* valid path rather than a canonical one,
 * because dynamic dispatch means several are correct and penalizing a system
 * for choosing a different valid path would reward matching the annotator
 * rather than understanding the code.
 */
export function scoreCallChain(task: CallChainTask, predicted: string[]): CallChainScore {
	const shortcut = callChainShortcut(task);
	const predictedEdges = new Set(edgesOf(predicted));
	const allValidSteps = new Set(task.valid_paths.flat());

	let best = {
		exact: false,
		prefix: 0,
		precision: 0,
		recall: 0,
	};

	for (const path of task.valid_paths) {
		const exact = path.length === predicted.length && path.every((s, i) => s === predicted[i]);
		let prefix = 0;
		while (prefix < path.length && predicted[prefix] === path[prefix]) prefix++;

		const validEdges = new Set(edgesOf(path));
		let matched = 0;
		for (const edge of predictedEdges) if (validEdges.has(edge)) matched++;
		const precision = predictedEdges.size > 0 ? matched / predictedEdges.size : 0;
		const recall = validEdges.size > 0 ? matched / validEdges.size : predicted.length === 0 ? 1 : 0;

		const score = (exact ? 10 : 0) + prefix / Math.max(1, path.length) + precision + recall;
		const bestScore = (best.exact ? 10 : 0) + best.prefix + best.precision + best.recall;
		if (score > bestScore) {
			best = { exact, prefix: prefix / Math.max(1, path.length), precision, recall };
		}
	}

	return {
		task_id: task.task_id,
		exact: best.exact,
		prefix: best.prefix,
		edge_precision: best.precision,
		edge_recall: best.recall,
		fabricated_steps: predicted.filter((s) => !allValidSteps.has(s)).length,
		path_length:
			Math.min(...task.valid_paths.map((p) => p.length), 0) || task.valid_paths[0]?.length || 0,
		shortcuttable: shortcut.shortcuttable,
	};
}

export type StatefulScore = {
	task_id: string;
	/** Variables predicted correctly. */
	correct_variables: number;
	total_variables: number;
	/** Per-variable accuracy: the metric that distinguishes 7/8 from 0/8. */
	variable_accuracy: number;
	/** Whole-state equality, reported alongside but never instead. */
	exact_state: boolean;
	/** Variables predicted that the question did not ask about. */
	extra_variables: number;
	/** Variables the question asked about that were not predicted. */
	missing_variables: number;
	/**
	 * Accuracy restricted to variables actually written along the path. This is
	 * the number that reflects execution reasoning; the rest is copying.
	 */
	mutated_variable_accuracy: number | null;
	shortcuttable: boolean;
};

/**
 * Score a predicted state.
 *
 * `mutated_variable_accuracy` is the one to read. Overall variable accuracy is
 * inflated by every variable the path never touches, which a system scores
 * correctly by copying the input, and on a typical task those are most of them.
 */
export function scoreStateful(task: StatefulTask, predicted: StateVariable[]): StatefulScore {
	const shortcut = statefulShortcut(task);
	const expected = new Map(task.expected_state.map((v) => [v.name, v.value]));
	const got = new Map(predicted.map((v) => [v.name, v.value]));
	const mutated = new Set(task.mutated_variables);

	let correct = 0;
	for (const [name, value] of expected) {
		if (got.get(name) === value) correct++;
	}

	const mutatedAsked = [...expected.keys()].filter((name) => mutated.has(name));
	const mutatedCorrect = mutatedAsked.filter((name) => got.get(name) === expected.get(name)).length;

	return {
		task_id: task.task_id,
		correct_variables: correct,
		total_variables: expected.size,
		variable_accuracy: expected.size > 0 ? correct / expected.size : 0,
		exact_state: correct === expected.size && got.size === expected.size,
		extra_variables: [...got.keys()].filter((name) => !expected.has(name)).length,
		missing_variables: [...expected.keys()].filter((name) => !got.has(name)).length,
		mutated_variable_accuracy:
			mutatedAsked.length > 0 ? mutatedCorrect / mutatedAsked.length : null,
		shortcuttable: shortcut.shortcuttable,
	};
}

export type SuiteValidity = {
	tasks: number;
	shortcuttable: number;
	shortcut_fraction: number;
	/** Reasons, with how many tasks each applies to. */
	reasons: Array<{ reason: string; tasks: number }>;
	verdict: "cross_file" | "partly_shortcuttable" | "not_a_cross_file_benchmark";
	detail: string;
};

/** Above this fraction of shortcuttable tasks, the suite does not test traversal. */
export const SHORTCUT_FAILURE_FRACTION = 0.5;
export const SHORTCUT_WARNING_FRACTION = 0.1;

/**
 * Assess whether a suite tests what it claims to.
 *
 * Run before quoting any accuracy. A suite that is half shortcuttable produces
 * a number nobody should describe as cross-file reasoning, and this is the only
 * place that can say so.
 */
export function assessSuiteValidity(findings: ShortcutFinding[]): SuiteValidity {
	const shortcuttable = findings.filter((f) => f.shortcuttable);
	const fraction = findings.length > 0 ? shortcuttable.length / findings.length : 0;

	const counts = new Map<string, number>();
	for (const finding of shortcuttable) {
		for (const reason of finding.reasons) {
			// Group by the leading clause so per-task specifics do not fragment it.
			const key = reason
				.split(";")[0]
				.replace(/'[^']*'/g, "'…'")
				.replace(/\d+/g, "N");
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}

	const verdict: SuiteValidity["verdict"] =
		fraction > SHORTCUT_FAILURE_FRACTION
			? "not_a_cross_file_benchmark"
			: fraction > SHORTCUT_WARNING_FRACTION
				? "partly_shortcuttable"
				: "cross_file";

	return {
		tasks: findings.length,
		shortcuttable: shortcuttable.length,
		shortcut_fraction: fraction,
		reasons: [...counts.entries()]
			.map(([reason, tasks]) => ({ reason, tasks }))
			.sort((a, b) => b.tasks - a.tasks || a.reason.localeCompare(b.reason)),
		verdict,
		detail:
			verdict === "not_a_cross_file_benchmark"
				? `${(fraction * 100).toFixed(0)}% of tasks are answerable without following anything; an accuracy on this suite is not evidence of cross-file reasoning`
				: verdict === "partly_shortcuttable"
					? `${(fraction * 100).toFixed(0)}% of tasks are shortcuttable and are excluded from the headline number`
					: "no task is answerable without traversal",
	};
}

export type ChainLengthSlice = {
	length: number;
	tasks: number;
	exact_accuracy: number;
	mean_prefix: number;
};

/**
 * Accuracy by chain length.
 *
 * Accuracy at length two says nothing about length six, and a suite whose
 * headline is carried by short chains looks the same as one that handles long
 * ones until this is computed.
 */
export function sliceByChainLength(scores: CallChainScore[]): ChainLengthSlice[] {
	const groups = new Map<number, CallChainScore[]>();
	for (const score of scores) {
		if (score.shortcuttable) continue;
		const list = groups.get(score.path_length);
		if (list) list.push(score);
		else groups.set(score.path_length, [score]);
	}
	return [...groups.entries()]
		.map(([length, group]) => ({
			length,
			tasks: group.length,
			exact_accuracy: group.filter((s) => s.exact).length / group.length,
			mean_prefix: group.reduce((sum, s) => sum + s.prefix, 0) / group.length,
		}))
		.sort((a, b) => a.length - b.length);
}
