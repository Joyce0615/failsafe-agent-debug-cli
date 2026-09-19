/**
 * SWE-Explore-style comparative benchmark harness (item 80).
 *
 * Item 50 built the *scorer*: given one exploration trace and its ground truth,
 * what were the coverage, path-traversal, ranking, and efficiency numbers. That
 * is necessary and not sufficient, because a benchmark is used to compare
 * systems, and comparing systems is where the arithmetic stops being honest.
 *
 * This module is the harness, and it exists to make three specific claims
 * impossible to make accidentally.
 *
 * 1. **"System A scores 0.63 and system B scores 0.60, so A is better."** On
 *    thirty instances that difference is noise. Every comparison here is
 *    *paired* — the same instances, differences taken per instance — and
 *    reported as a bootstrap confidence interval on the mean difference. A CI
 *    containing zero means the benchmark cannot tell the two apart, and
 *    `verdict` says exactly that instead of ranking them anyway.
 *
 * 2. **"Our F1 is 0.8."** F1 over retrieved files is trivially gamed by reading
 *    everything (recall 1) or by reading one certainly-relevant file
 *    (precision 1). `readEverythingBaseline` and `singleGuessBaseline` compute
 *    what those degenerate strategies score on the same suite, and a system
 *    that does not beat them has demonstrated nothing.
 *
 * 3. **"The mean improved."** A mean improvement can come from one instance
 *    moving a long way while most got worse. `winLossTie` reports the per-instance
 *    table next to every mean, which is the thing a mean is best at hiding.
 *
 * Pure and deterministic: the bootstrap uses a seeded PRNG so a reported
 * interval reproduces exactly.
 */
import {
	type ExplorationCase,
	type ExplorationScore,
	type ExplorationTrace,
	scoreExploration,
} from "./exploration.js";
import { mulberry32 } from "./trace-analytics.js";

/** Metrics a comparison can be run on. */
export const COMPARISON_METRICS = [
	"file_f1",
	"file_recall",
	"file_precision",
	"function_f1",
	"test_recall",
	"rank_mrr",
	"read_precision",
] as const;
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

/** Extract one metric from a scored instance. */
export function metricOf(score: ExplorationScore, metric: ComparisonMetric): number {
	switch (metric) {
		case "file_f1":
			return score.files.f1;
		case "file_recall":
			return score.files.recall;
		case "file_precision":
			return score.files.precision;
		case "function_f1":
			return score.functions.f1;
		case "test_recall":
			return score.tests.recall;
		case "rank_mrr":
			return score.ranking.mean_reciprocal_rank;
		case "read_precision":
			return score.efficiency.read_precision;
	}
}

export type SystemRun = {
	system: string;
	/** One trace per case, keyed by `case_id`. */
	traces: ExplorationTrace[];
};

export type ScoredSystem = {
	system: string;
	/** Scores in suite order; a case with no trace is scored as an empty trace. */
	scores: ExplorationScore[];
	/** Cases the system supplied no trace for. */
	missing: string[];
};

/**
 * Score one system over the whole suite.
 *
 * A case with no trace is scored as an *empty exploration* rather than skipped.
 * Skipping would let a system improve its mean by declining the instances it
 * finds hard, which is the oldest trick in benchmarking.
 */
export function scoreSystem(cases: ExplorationCase[], run: SystemRun): ScoredSystem {
	const byId = new Map(run.traces.map((t) => [t.case_id, t]));
	const missing: string[] = [];
	const scores = cases.map((testCase) => {
		const trace = byId.get(testCase.case_id);
		if (!trace) missing.push(testCase.case_id);
		return scoreExploration(
			testCase,
			trace ?? { case_id: testCase.case_id, steps: [], ranked_files: [], patch_resolved: false },
		);
	});
	return { system: run.system, scores, missing };
}

/**
 * A system that reads every file in the repository.
 *
 * Recall 1, precision ~0. Included because an F1 that does not beat this is not
 * evidence of retrieval ability, and because a surprising number of "improved
 * recall" results are this strategy with extra steps.
 */
export function readEverythingBaseline(
	cases: ExplorationCase[],
	repositoryFiles: Record<string, string[]>,
): SystemRun {
	return {
		system: "read_everything",
		traces: cases.map((testCase) => {
			const files = repositoryFiles[testCase.case_id] ?? testCase.relevant.files;
			return {
				case_id: testCase.case_id,
				steps: files.map((file, index) => ({ index, kind: "read" as const, target: file })),
				ranked_files: files,
				patch_resolved: false,
			};
		}),
	};
}

/**
 * A system that reads exactly one file: the first relevant one.
 *
 * Precision 1, recall tiny. The mirror image of the above, and the reason
 * precision alone is not a result either.
 */
export function singleGuessBaseline(cases: ExplorationCase[]): SystemRun {
	return {
		system: "single_guess",
		traces: cases.map((testCase) => ({
			case_id: testCase.case_id,
			steps: testCase.relevant.files.slice(0, 1).map((file, index) => ({
				index,
				kind: "read" as const,
				target: file,
			})),
			ranked_files: testCase.relevant.files.slice(0, 1),
			patch_resolved: false,
		})),
	};
}

export type WinLossTie = {
	wins: number;
	losses: number;
	ties: number;
	/** Instances where the difference exceeded `tie_threshold`. */
	decisive: number;
	tie_threshold: number;
};

/**
 * Per-instance outcome table.
 *
 * Reported next to every mean because a mean improvement can come from one
 * instance moving a long way while most got worse, and the table is the only
 * place that shows up.
 */
export function winLossTie(a: number[], b: number[], tieThreshold = 0.01): WinLossTie {
	let wins = 0;
	let losses = 0;
	let ties = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const diff = a[i] - b[i];
		if (Math.abs(diff) <= tieThreshold) ties++;
		else if (diff > 0) wins++;
		else losses++;
	}
	return { wins, losses, ties, decisive: wins + losses, tie_threshold: tieThreshold };
}

export type PairedComparison = {
	metric: ComparisonMetric;
	system_a: string;
	system_b: string;
	instances: number;
	mean_a: number;
	mean_b: number;
	mean_difference: number;
	/** Bootstrap confidence interval on the paired mean difference. */
	ci_lower: number;
	ci_upper: number;
	confidence: number;
	win_loss_tie: WinLossTie;
	/**
	 * `a_better` / `b_better` only when the interval excludes zero.
	 * `indistinguishable` otherwise — which is a result, not a failure to rank.
	 */
	verdict: "a_better" | "b_better" | "indistinguishable" | "insufficient_instances";
	detail: string;
};

/** Below this, a bootstrap interval is too wide to mean anything. */
export const MIN_COMPARISON_INSTANCES = 10;
export const DEFAULT_BOOTSTRAP_SAMPLES = 2000;

/**
 * Paired bootstrap comparison of two systems on one metric.
 *
 * Paired because the instances are the same: per-instance differences remove
 * the variance caused by some bugs being harder than others, which on a
 * thirty-instance suite is most of the variance there is. An unpaired
 * comparison of the same data would report a much wider interval and would be
 * answering a question nobody asked.
 */
export function comparePaired(
	a: ScoredSystem,
	b: ScoredSystem,
	metric: ComparisonMetric,
	opts: { confidence?: number; samples?: number; seed?: number; tie_threshold?: number } = {},
): PairedComparison {
	const confidence = opts.confidence ?? 0.95;
	const samples = opts.samples ?? DEFAULT_BOOTSTRAP_SAMPLES;
	const rand = mulberry32(opts.seed ?? 1);

	const valuesA = a.scores.map((s) => metricOf(s, metric));
	const valuesB = b.scores.map((s) => metricOf(s, metric));
	const n = Math.min(valuesA.length, valuesB.length);
	const differences = Array.from({ length: n }, (_, i) => valuesA[i] - valuesB[i]);

	const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((x, y) => x + y, 0) / xs.length);
	const meanA = mean(valuesA);
	const meanB = mean(valuesB);
	const meanDiff = mean(differences);
	const table = winLossTie(valuesA, valuesB, opts.tie_threshold);

	if (n < MIN_COMPARISON_INSTANCES) {
		return {
			metric,
			system_a: a.system,
			system_b: b.system,
			instances: n,
			mean_a: meanA,
			mean_b: meanB,
			mean_difference: meanDiff,
			ci_lower: Number.NaN,
			ci_upper: Number.NaN,
			confidence,
			win_loss_tie: table,
			verdict: "insufficient_instances",
			detail: `${n} instance(s); at least ${MIN_COMPARISON_INSTANCES} are needed before a difference can be distinguished from noise`,
		};
	}

	const bootstrapMeans: number[] = [];
	for (let s = 0; s < samples; s++) {
		let total = 0;
		for (let i = 0; i < n; i++) total += differences[Math.floor(rand() * n)];
		bootstrapMeans.push(total / n);
	}
	bootstrapMeans.sort((x, y) => x - y);
	const tail = (1 - confidence) / 2;
	const lower = bootstrapMeans[Math.floor(tail * samples)];
	const upper = bootstrapMeans[Math.min(samples - 1, Math.ceil((1 - tail) * samples) - 1)];

	const verdict: PairedComparison["verdict"] =
		lower > 0 ? "a_better" : upper < 0 ? "b_better" : "indistinguishable";

	return {
		metric,
		system_a: a.system,
		system_b: b.system,
		instances: n,
		mean_a: meanA,
		mean_b: meanB,
		mean_difference: meanDiff,
		ci_lower: lower,
		ci_upper: upper,
		confidence,
		win_loss_tie: table,
		verdict,
		detail:
			verdict === "indistinguishable"
				? `the ${confidence * 100}% interval on the paired difference is [${lower.toFixed(4)}, ${upper.toFixed(4)}] and contains zero: on ${n} instances this benchmark cannot tell '${a.system}' and '${b.system}' apart, whatever the means say`
				: `the ${confidence * 100}% interval [${lower.toFixed(4)}, ${upper.toFixed(4)}] excludes zero over ${n} instances (${table.wins} wins, ${table.losses} losses, ${table.ties} ties)`,
	};
}

export type LeaderboardRow = {
	system: string;
	mean: number;
	/** Instances with no trace supplied; scored as empty explorations. */
	missing: number;
	/** Comparison against the strongest baseline on this metric. */
	beats_baselines: boolean;
	baseline_margin: number;
};

export type SuiteReport = {
	metric: ComparisonMetric;
	instances: number;
	rows: LeaderboardRow[];
	baselines: LeaderboardRow[];
	comparisons: PairedComparison[];
	caveats: string[];
};

/**
 * Score every system, compare each against the baselines, and rank.
 *
 * Ranking by mean is done — a leaderboard has to have an order — but every
 * adjacent pair is also compared properly, and the caveats say when the order
 * is not supported by the intervals. A leaderboard whose top two are
 * statistically indistinguishable is a leaderboard with one winner and a tie,
 * and printing them as first and second misrepresents the result.
 */
export function suiteReport(
	cases: ExplorationCase[],
	runs: SystemRun[],
	metric: ComparisonMetric,
	opts: {
		repository_files?: Record<string, string[]>;
		seed?: number;
		confidence?: number;
	} = {},
): SuiteReport {
	const baselineRuns = [
		readEverythingBaseline(cases, opts.repository_files ?? {}),
		singleGuessBaseline(cases),
	];
	const scoredBaselines = baselineRuns.map((run) => scoreSystem(cases, run));
	const scoredSystems = runs.map((run) => scoreSystem(cases, run));

	const meanOf = (system: ScoredSystem) =>
		system.scores.length === 0
			? 0
			: system.scores.reduce((sum, s) => sum + metricOf(s, metric), 0) / system.scores.length;

	const bestBaseline = scoredBaselines.reduce(
		(best, candidate) => (meanOf(candidate) > meanOf(best) ? candidate : best),
		scoredBaselines[0],
	);

	const row = (system: ScoredSystem): LeaderboardRow => ({
		system: system.system,
		mean: meanOf(system),
		missing: system.missing.length,
		beats_baselines: meanOf(system) > meanOf(bestBaseline),
		baseline_margin: meanOf(system) - meanOf(bestBaseline),
	});

	const rows = scoredSystems
		.map(row)
		.sort((a, b) => b.mean - a.mean || a.system.localeCompare(b.system));

	const comparisons: PairedComparison[] = [];
	const byName = new Map(scoredSystems.map((s) => [s.system, s]));
	for (let i = 1; i < rows.length; i++) {
		const a = byName.get(rows[i - 1].system)!;
		const b = byName.get(rows[i].system)!;
		comparisons.push(comparePaired(a, b, metric, { seed: opts.seed, confidence: opts.confidence }));
	}
	for (const system of scoredSystems) {
		comparisons.push(
			comparePaired(system, bestBaseline, metric, { seed: opts.seed, confidence: opts.confidence }),
		);
	}

	const caveats: string[] = [];
	const indistinguishable = comparisons.filter(
		(c) => c.verdict === "indistinguishable" && c.system_b !== bestBaseline.system,
	);
	if (indistinguishable.length > 0) {
		caveats.push(
			`${indistinguishable.length} adjacent pair(s) on this leaderboard are statistically indistinguishable; the ordering between them reflects sampling, not capability`,
		);
	}
	const notBeatingBaselines = rows.filter((r) => !r.beats_baselines);
	if (notBeatingBaselines.length > 0) {
		caveats.push(
			`${notBeatingBaselines.length} system(s) do not beat the '${bestBaseline.system}' baseline on '${metric}'; a score that a degenerate strategy matches is not evidence of retrieval ability`,
		);
	}
	const withMissing = scoredSystems.filter((s) => s.missing.length > 0);
	if (withMissing.length > 0) {
		caveats.push(
			`${withMissing.length} system(s) omitted traces for some instances; those are scored as empty explorations rather than skipped, so declining a hard case cannot raise a mean`,
		);
	}
	if (cases.length < MIN_COMPARISON_INSTANCES) {
		caveats.push(
			`the suite has ${cases.length} instance(s); no comparison on it can distinguish a real difference from noise`,
		);
	}

	return {
		metric,
		instances: cases.length,
		rows,
		baselines: scoredBaselines.map(row),
		comparisons,
		caveats,
	};
}
