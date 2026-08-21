/**
 * Repository exploration quality (item 50).
 *
 * SWE-Explore-Bench asks what an agent *reads and ranks before it edits*, which
 * is a different question from whether the patch worked. The two come apart in
 * both directions: an agent can read exactly the right files and still write a
 * bad patch, and it can stumble onto a passing patch having understood nothing.
 * Scoring only the patch hides both, and hides the one that matters for
 * improving a debugger — an agent that never read the relevant code has no
 * mechanism for being right except luck.
 *
 * So exploration is scored on its own terms, in five parts:
 *
 * 1. **Coverage** — precision/recall/F1 over relevant files, functions, and
 *    tests, each scored separately because reading the right file and reading
 *    the right function inside it are different competencies.
 * 2. **Dependency paths** — whether the agent actually traversed the chains
 *    that connect the symptom to the cause, and whether it did so in order.
 *    Reading both ends of a chain without the middle is not understanding it.
 * 3. **Ranking** — where the relevant files landed in the agent's final ranked
 *    list (MRR and recall@k), because "read 200 files, one of them mattered" is
 *    not exploration.
 * 4. **Efficiency** — the share of reads that were relevant, how long it took
 *    to reach the first relevant read, and how much was re-read.
 * 5. **Independence from patch success** — a contingency table over
 *    (explored well, patch passed), plus the two off-diagonal counts. A
 *    benchmark that cannot show `explored_poorly_but_passed` cannot tell you
 *    whether the corpus is guessable.
 *
 * Pure: no fs, network, or clock.
 */
import { z } from "zod";

export const EXPLORATION_BENCH_VERSION = "0.1";

/** What an agent did during exploration. */
export const EXPLORATION_ACTIONS = ["list", "search", "read", "rank"] as const;
export const ExplorationActionKindSchema = z.enum(EXPLORATION_ACTIONS);
export type ExplorationActionKind = z.infer<typeof ExplorationActionKindSchema>;

export const ExplorationStepSchema = z.object({
	index: z.number().int().nonnegative(),
	kind: ExplorationActionKindSchema,
	/** Repo-relative path, symbol name, or query, depending on `kind`. */
	target: z.string().min(1),
	/** Symbol read, when the step read a specific function rather than a file. */
	symbol: z.string().optional(),
});
export type ExplorationStep = z.infer<typeof ExplorationStepSchema>;

export const ExplorationTraceSchema = z.object({
	case_id: z.string().min(1),
	steps: z.array(ExplorationStepSchema).default([]),
	/** The agent's final ranking of files it believed relevant, best first. */
	ranked_files: z.array(z.string()).default([]),
	/**
	 * Whether the patch that followed resolved the task. Recorded but never
	 * folded into an exploration score — the separation is the point.
	 */
	patch_resolved: z.boolean().optional(),
});
export type ExplorationTrace = z.infer<typeof ExplorationTraceSchema>;

export const ExplorationCaseSchema = z.object({
	case_id: z.string().min(1),
	relevant: z.object({
		files: z.array(z.string()).default([]),
		functions: z.array(z.string()).default([]),
		tests: z.array(z.string()).default([]),
		/**
		 * Chains of files that connect the symptom to the cause. Each chain must
		 * be traversed in order for the agent to have followed it.
		 */
		dependency_paths: z.array(z.array(z.string().min(1)).min(2)).default([]),
	}),
});
export type ExplorationCase = z.infer<typeof ExplorationCaseSchema>;

export const DEFAULT_RANK_KS = [1, 5, 10] as const;

export type SetScore = {
	precision: number;
	recall: number;
	f1: number;
	retrieved: number;
	relevant: number;
	matched: number;
};

/**
 * Precision/recall over two sets.
 *
 * An empty ground truth yields recall 1 (nothing was required) but precision 0
 * when anything was retrieved — reading files that were never relevant is not
 * free just because the case had no requirements.
 */
export function setScore(retrieved: Iterable<string>, relevant: Iterable<string>): SetScore {
	const got = new Set(retrieved);
	const want = new Set(relevant);
	let matched = 0;
	for (const item of got) {
		if (want.has(item)) matched++;
	}
	const precision = got.size > 0 ? matched / got.size : 0;
	const recall = want.size > 0 ? matched / want.size : 1;
	return {
		precision,
		recall,
		f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
		retrieved: got.size,
		relevant: want.size,
		matched,
	};
}

export type PathScore = {
	/** Chains where every hop was read, in order. */
	traversed_in_order: number;
	/** Chains where every hop was read, in any order. */
	traversed_any_order: number;
	total: number;
	/** Mean fraction of hops read per chain. */
	mean_hop_coverage: number;
	in_order_rate: number;
};

/**
 * Score dependency-path traversal.
 *
 * `traversed_any_order` and `traversed_in_order` are reported separately
 * because reading both ends of a chain without following it is a common and
 * misleading pattern: the coverage numbers look right and the agent never saw
 * how the two ends connect.
 */
export function pathScore(readOrder: string[], chains: string[][]): PathScore {
	const firstRead = new Map<string, number>();
	readOrder.forEach((file, i) => {
		if (!firstRead.has(file)) firstRead.set(file, i);
	});

	let inOrder = 0;
	let anyOrder = 0;
	let hopCoverage = 0;
	for (const chain of chains) {
		const positions = chain.map((hop) => firstRead.get(hop));
		const readHops = positions.filter((p) => p !== undefined).length;
		hopCoverage += chain.length > 0 ? readHops / chain.length : 0;
		if (readHops !== chain.length) continue;
		anyOrder++;
		const ordered = positions.every(
			(p, i) => i === 0 || (p as number) > (positions[i - 1] as number),
		);
		if (ordered) inOrder++;
	}

	return {
		traversed_in_order: inOrder,
		traversed_any_order: anyOrder,
		total: chains.length,
		mean_hop_coverage: chains.length > 0 ? hopCoverage / chains.length : 1,
		in_order_rate: chains.length > 0 ? inOrder / chains.length : 1,
	};
}

export type RankScore = {
	mean_reciprocal_rank: number;
	recall_at_k: Record<number, number>;
	ranked: number;
};

/** Ranking quality of the agent's final file list against the relevant set. */
export function rankScore(
	ranked: string[],
	relevant: string[],
	ks: readonly number[] = DEFAULT_RANK_KS,
): RankScore {
	const want = new Set(relevant);
	const firstHit = ranked.findIndex((f) => want.has(f));
	const recall: Record<number, number> = {};
	for (const k of ks) {
		const hits = ranked.slice(0, k).filter((f) => want.has(f)).length;
		recall[k] = want.size > 0 ? hits / want.size : 1;
	}
	return {
		mean_reciprocal_rank: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
		recall_at_k: recall,
		ranked: ranked.length,
	};
}

export type EfficiencyScore = {
	total_reads: number;
	distinct_reads: number;
	relevant_reads: number;
	/** Share of distinct reads that were relevant. */
	read_precision: number;
	/** Index of the first read that hit a relevant file; `null` if never. */
	steps_to_first_relevant: number | null;
	/** Reads of a file already read. */
	redundant_reads: number;
};

export function efficiencyScore(readOrder: string[], relevant: string[]): EfficiencyScore {
	const want = new Set(relevant);
	const seen = new Set<string>();
	let redundant = 0;
	let firstRelevant: number | null = null;
	readOrder.forEach((file, i) => {
		if (seen.has(file)) redundant++;
		seen.add(file);
		if (firstRelevant === null && want.has(file)) firstRelevant = i;
	});
	let relevantReads = 0;
	for (const file of seen) {
		if (want.has(file)) relevantReads++;
	}
	return {
		total_reads: readOrder.length,
		distinct_reads: seen.size,
		relevant_reads: relevantReads,
		read_precision: seen.size > 0 ? relevantReads / seen.size : 0,
		steps_to_first_relevant: firstRelevant,
		redundant_reads: redundant,
	};
}

export type ExplorationScore = {
	case_id: string;
	files: SetScore;
	functions: SetScore;
	tests: SetScore;
	paths: PathScore;
	ranking: RankScore;
	efficiency: EfficiencyScore;
	/** Recorded, never folded into any exploration metric. */
	patch_resolved?: boolean;
	/** File recall at or above the threshold. */
	explored_well: boolean;
};

/** File recall at which exploration counts as adequate for the contingency table. */
export const WELL_EXPLORED_RECALL = 0.7;

/** Files the trace actually opened, in order. */
export function readOrderOf(trace: ExplorationTrace): string[] {
	return trace.steps.filter((s) => s.kind === "read").map((s) => s.target);
}

export function scoreExploration(
	testCase: ExplorationCase,
	trace: ExplorationTrace,
	opts: { ks?: readonly number[] } = {},
): ExplorationScore {
	const reads = readOrderOf(trace);
	const symbols = trace.steps
		.filter((s) => s.kind === "read" && s.symbol !== undefined)
		.map((s) => s.symbol as string);
	// Tests are recognized by being read at all; the ground truth names which
	// test files mattered, so a plain read of a test file counts.
	const files = setScore(reads, testCase.relevant.files);

	return {
		case_id: testCase.case_id,
		files,
		functions: setScore(symbols, testCase.relevant.functions),
		tests: setScore(reads, testCase.relevant.tests),
		paths: pathScore(reads, testCase.relevant.dependency_paths),
		ranking: rankScore(trace.ranked_files, testCase.relevant.files, opts.ks),
		efficiency: efficiencyScore(reads, testCase.relevant.files),
		...(trace.patch_resolved !== undefined ? { patch_resolved: trace.patch_resolved } : {}),
		explored_well: files.recall >= WELL_EXPLORED_RECALL,
	};
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export type Contingency = {
	/** Cases where the patch outcome is known. */
	cases: number;
	explored_well_and_passed: number;
	explored_well_but_failed: number;
	explored_poorly_but_passed: number;
	explored_poorly_and_failed: number;
	/**
	 * Phi coefficient between exploration quality and patch success, in
	 * [-1, 1]. Near zero means the two are unrelated in this corpus — which is
	 * information about the corpus, not a defect in the metric.
	 */
	phi: number;
};

/**
 * Contingency between exploration quality and patch success.
 *
 * Reported, never combined. `explored_poorly_but_passed` is the number that
 * says whether the corpus is guessable; `explored_well_but_failed` is the one
 * that says exploration alone is not sufficient. Averaging them into a single
 * "quality" figure would erase both.
 */
export function contingency(scores: ExplorationScore[]): Contingency {
	const known = scores.filter((s) => s.patch_resolved !== undefined);
	let a = 0;
	let b = 0;
	let c = 0;
	let d = 0;
	for (const s of known) {
		if (s.explored_well && s.patch_resolved) a++;
		else if (s.explored_well) b++;
		else if (s.patch_resolved) c++;
		else d++;
	}
	const denominator = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
	return {
		cases: known.length,
		explored_well_and_passed: a,
		explored_well_but_failed: b,
		explored_poorly_but_passed: c,
		explored_poorly_and_failed: d,
		phi: denominator > 0 ? (a * d - b * c) / denominator : 0,
	};
}

export type ExplorationReport = {
	schema_version: typeof EXPLORATION_BENCH_VERSION;
	cases: number;
	files: { mean_precision: number; mean_recall: number; mean_f1: number };
	functions: { mean_precision: number; mean_recall: number; mean_f1: number };
	tests: { mean_precision: number; mean_recall: number; mean_f1: number };
	paths: { in_order_rate: number; any_order_rate: number; mean_hop_coverage: number };
	ranking: { mean_reciprocal_rank: number; recall_at_k: Record<number, number> };
	efficiency: {
		mean_read_precision: number;
		mean_distinct_reads: number;
		mean_redundant_reads: number;
		/** Mean over cases that reached a relevant file at all. */
		mean_steps_to_first_relevant: number;
		/** Cases that never opened a relevant file. */
		never_reached_relevant: number;
	};
	patch_independence: Contingency;
};

function meanSet(scores: ExplorationScore[], pick: (s: ExplorationScore) => SetScore) {
	return {
		mean_precision: mean(scores.map((s) => pick(s).precision)),
		mean_recall: mean(scores.map((s) => pick(s).recall)),
		mean_f1: mean(scores.map((s) => pick(s).f1)),
	};
}

export function explorationReport(
	scores: ExplorationScore[],
	ks: readonly number[] = DEFAULT_RANK_KS,
): ExplorationReport {
	const reached = scores.filter((s) => s.efficiency.steps_to_first_relevant !== null);
	const recallAtK: Record<number, number> = {};
	for (const k of ks) {
		recallAtK[k] = mean(scores.map((s) => s.ranking.recall_at_k[k] ?? 0));
	}
	return {
		schema_version: EXPLORATION_BENCH_VERSION,
		cases: scores.length,
		files: meanSet(scores, (s) => s.files),
		functions: meanSet(scores, (s) => s.functions),
		tests: meanSet(scores, (s) => s.tests),
		paths: {
			in_order_rate: mean(scores.map((s) => s.paths.in_order_rate)),
			any_order_rate: mean(
				scores.map((s) => (s.paths.total > 0 ? s.paths.traversed_any_order / s.paths.total : 1)),
			),
			mean_hop_coverage: mean(scores.map((s) => s.paths.mean_hop_coverage)),
		},
		ranking: {
			mean_reciprocal_rank: mean(scores.map((s) => s.ranking.mean_reciprocal_rank)),
			recall_at_k: recallAtK,
		},
		efficiency: {
			mean_read_precision: mean(scores.map((s) => s.efficiency.read_precision)),
			mean_distinct_reads: mean(scores.map((s) => s.efficiency.distinct_reads)),
			mean_redundant_reads: mean(scores.map((s) => s.efficiency.redundant_reads)),
			mean_steps_to_first_relevant: mean(
				reached.map((s) => s.efficiency.steps_to_first_relevant as number),
			),
			never_reached_relevant: scores.length - reached.length,
		},
		patch_independence: contingency(scores),
	};
}

export type ExplorationIssue = { case_id: string; problem: string };

/**
 * Reject corpora whose ground truth cannot support the metrics.
 *
 * The dependency-path checks matter most: a chain naming files that are not in
 * the relevant set scores traversal against files the agent was never told
 * mattered, which produces numbers that look meaningful and are not.
 */
export function validateExplorationCases(cases: ExplorationCase[]): ExplorationIssue[] {
	const issues: ExplorationIssue[] = [];
	const seen = new Set<string>();
	for (const c of cases) {
		if (seen.has(c.case_id)) issues.push({ case_id: c.case_id, problem: "duplicate case_id" });
		seen.add(c.case_id);

		if (c.relevant.files.length === 0) {
			issues.push({ case_id: c.case_id, problem: "no relevant files: coverage is unscoreable" });
		}
		const relevantFiles = new Set(c.relevant.files);
		for (const [i, chain] of c.relevant.dependency_paths.entries()) {
			for (const hop of chain) {
				if (!relevantFiles.has(hop)) {
					issues.push({
						case_id: c.case_id,
						problem: `dependency_paths[${i}] names '${hop}', which is not in relevant.files`,
					});
				}
			}
			if (new Set(chain).size !== chain.length) {
				issues.push({
					case_id: c.case_id,
					problem: `dependency_paths[${i}] repeats a file; in-order traversal is undefined`,
				});
			}
		}
	}
	return issues;
}

export function scoreExplorationCases(
	cases: ExplorationCase[],
	traces: ExplorationTrace[],
	opts: { ks?: readonly number[] } = {},
): ExplorationScore[] {
	const byId = new Map(traces.map((t) => [t.case_id, t]));
	return cases.map((c) =>
		scoreExploration(
			c,
			byId.get(c.case_id) ?? ExplorationTraceSchema.parse({ case_id: c.case_id }),
			opts,
		),
	);
}
