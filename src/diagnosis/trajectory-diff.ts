/**
 * Semantic diffing between healthy and failing trajectories (item 69).
 *
 * "What did the failing run do differently?" is the right question and the
 * usual implementation answers a different one. Two failure modes account for
 * almost all of it:
 *
 * 1. **Aligning by index.** Trajectories differ in length. Compare step 7 to
 *    step 7 and a single extra retry near the beginning makes every subsequent
 *    step look changed. Alignment here is a Needleman–Wunsch pass over step
 *    *signatures*, so an insertion costs one gap rather than shifting the rest
 *    of the comparison into noise.
 *
 * 2. **Using one healthy baseline.** Against a single reference run, every
 *    difference looks significant — and most differences between any two runs
 *    of the same agent are noise: independent reads in a different order,
 *    different timings, a retry that happened to succeed first time. A
 *    difference that also appears in half the healthy runs is not a cause.
 *    `diffAgainstBaselines` therefore scores each difference by how many
 *    healthy runs share it, and with a single baseline it says so and caps what
 *    can be concluded rather than reporting confident nonsense.
 *
 * "Semantic" means the comparison is over normalized step signatures — tool
 * name, argument *shape*, and outcome — not over rendered text. Two reads of
 * different files are the same step semantically; a read that returned an error
 * is not the same as one that succeeded. Comparing text would make the first
 * pair different and the second pair identical, which is backwards.
 *
 * Pure: no I/O.
 */

export type TrajectoryStep = {
	id: string;
	/** Tool or operation invoked. */
	action: string;
	/** Arguments; only their shape and a coarse class of value are compared. */
	arguments?: Record<string, unknown>;
	outcome: "ok" | "error";
	error_class?: string;
	ts_ms?: number;
};

export type Trajectory = {
	id: string;
	steps: TrajectoryStep[];
};

/**
 * Coarse value class used in a signature.
 *
 * Values themselves are excluded: two reads of different files are the same
 * *kind* of step, and a diff that flags every distinct path produces one
 * difference per step and explains nothing. What matters is a change in shape —
 * an argument that became a list, or went missing.
 */
function valueClass(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `array[${value.length === 0 ? "empty" : "nonempty"}]`;
	switch (typeof value) {
		case "string":
			return value.length === 0 ? "string[empty]" : "string";
		case "number":
			return Number.isInteger(value) ? "int" : "float";
		case "boolean":
			return "bool";
		case "object":
			return `object[${Object.keys(value as object).length}]`;
		default:
			return typeof value;
	}
}

/** Normalized argument shape: sorted `key:class` pairs. */
export function argumentShape(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	return Object.keys(args)
		.sort()
		.map((key) => `${key}:${valueClass(args[key])}`)
		.join(",");
}

/**
 * The signature two steps are compared on.
 *
 * Includes the outcome, because "read the config" and "failed to read the
 * config" are the same action and very much not the same step. Excludes
 * timestamps, which differ between every pair of runs and carry no semantics.
 */
export function stepSignature(step: TrajectoryStep): string {
	const shape = argumentShape(step.arguments);
	const outcome = step.outcome === "error" ? `error:${step.error_class ?? "unknown"}` : "ok";
	return `${step.action}(${shape})->${outcome}`;
}

/** Signature ignoring the outcome, for detecting "same call, different result". */
export function actionSignature(step: TrajectoryStep): string {
	return `${step.action}(${argumentShape(step.arguments)})`;
}

export type AlignmentOp = "match" | "substitute" | "insert" | "delete";

export type AlignedPair = {
	op: AlignmentOp;
	/** Index in the failing trajectory, or `null` for a deletion. */
	failing_index: number | null;
	/** Index in the healthy trajectory, or `null` for an insertion. */
	healthy_index: number | null;
};

const MATCH_SCORE = 2;
const MISMATCH_SCORE = -1;
const GAP_SCORE = -2;

/**
 * Needleman–Wunsch global alignment over step signatures.
 *
 * Global rather than local because the question is "how does this whole run
 * differ", and a local alignment would happily report the one matching
 * subsequence and ignore everything around it. The gap penalty exceeds the
 * mismatch penalty so the alignment prefers to call a changed step *changed*
 * rather than an insertion plus a deletion, which is both cheaper to read and
 * usually what happened.
 */
export function align(failing: string[], healthy: string[]): AlignedPair[] {
	const n = failing.length;
	const m = healthy.length;
	const score: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

	for (let i = 1; i <= n; i++) score[i][0] = i * GAP_SCORE;
	for (let j = 1; j <= m; j++) score[0][j] = j * GAP_SCORE;

	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const diagonal =
				score[i - 1][j - 1] + (failing[i - 1] === healthy[j - 1] ? MATCH_SCORE : MISMATCH_SCORE);
			score[i][j] = Math.max(diagonal, score[i - 1][j] + GAP_SCORE, score[i][j - 1] + GAP_SCORE);
		}
	}

	const pairs: AlignedPair[] = [];
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0) {
			const same = failing[i - 1] === healthy[j - 1];
			const diagonal = score[i - 1][j - 1] + (same ? MATCH_SCORE : MISMATCH_SCORE);
			if (score[i][j] === diagonal) {
				pairs.push({
					op: same ? "match" : "substitute",
					failing_index: i - 1,
					healthy_index: j - 1,
				});
				i--;
				j--;
				continue;
			}
		}
		if (i > 0 && score[i][j] === score[i - 1][j] + GAP_SCORE) {
			pairs.push({ op: "insert", failing_index: i - 1, healthy_index: null });
			i--;
			continue;
		}
		pairs.push({ op: "delete", failing_index: null, healthy_index: j - 1 });
		j--;
	}
	return pairs.reverse();
}

export const DIFFERENCE_KINDS = [
	"only_in_failing",
	"only_in_healthy",
	"changed_arguments",
	"changed_outcome",
	"changed_action",
] as const;
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number];

export type Difference = {
	kind: DifferenceKind;
	/** Position in the failing trajectory this difference is anchored to. */
	at_failing_index: number | null;
	failing_step?: TrajectoryStep;
	healthy_step?: TrajectoryStep;
	description: string;
};

/** Classify one aligned pair into a difference, or `null` when they match. */
function classify(
	pair: AlignedPair,
	failing: TrajectoryStep[],
	healthy: TrajectoryStep[],
): Difference | null {
	if (pair.op === "match") return null;

	if (pair.op === "insert") {
		const step = failing[pair.failing_index!];
		return {
			kind: "only_in_failing",
			at_failing_index: pair.failing_index,
			failing_step: step,
			description: `the failing run performed '${step.action}', which the healthy run did not`,
		};
	}
	if (pair.op === "delete") {
		const step = healthy[pair.healthy_index!];
		return {
			kind: "only_in_healthy",
			at_failing_index: null,
			healthy_step: step,
			description: `the healthy run performed '${step.action}', which the failing run skipped`,
		};
	}

	const f = failing[pair.failing_index!];
	const h = healthy[pair.healthy_index!];
	if (f.action !== h.action) {
		return {
			kind: "changed_action",
			at_failing_index: pair.failing_index,
			failing_step: f,
			healthy_step: h,
			description: `'${h.action}' in the healthy run became '${f.action}' in the failing one`,
		};
	}
	if (actionSignature(f) === actionSignature(h)) {
		return {
			kind: "changed_outcome",
			at_failing_index: pair.failing_index,
			failing_step: f,
			healthy_step: h,
			description: `the same call to '${f.action}' returned ${h.outcome} in the healthy run and ${f.outcome}${f.error_class ? ` (${f.error_class})` : ""} in the failing one`,
		};
	}
	return {
		kind: "changed_arguments",
		at_failing_index: pair.failing_index,
		failing_step: f,
		healthy_step: h,
		description: `'${f.action}' was called with a different argument shape: '${argumentShape(h.arguments)}' became '${argumentShape(f.arguments)}'`,
	};
}

export type PairwiseDiff = {
	healthy_id: string;
	alignment: AlignedPair[];
	differences: Difference[];
	/** Fraction of aligned positions that matched. */
	similarity: number;
};

/** Diff a failing trajectory against one healthy trajectory. */
export function diffPair(failing: Trajectory, healthy: Trajectory): PairwiseDiff {
	const alignment = align(failing.steps.map(stepSignature), healthy.steps.map(stepSignature));
	const differences = alignment
		.map((pair) => classify(pair, failing.steps, healthy.steps))
		.filter((d): d is Difference => d !== null);
	const matches = alignment.filter((p) => p.op === "match").length;
	return {
		healthy_id: healthy.id,
		alignment,
		differences,
		similarity: alignment.length > 0 ? matches / alignment.length : 1,
	};
}

/** Baselines below this cannot separate a cause from ordinary run-to-run noise. */
export const MIN_BASELINES = 3;
/** A difference shared by this fraction of baselines is noise, not a signal. */
export const NOISE_THRESHOLD = 0.5;

export type ScoredDifference = Difference & {
	/** Healthy runs that also differ this way from the others. */
	shared_with_healthy: number;
	total_baselines: number;
	/** 1 when unique to the failing run, 0 when every baseline shares it. */
	discriminativeness: number;
	is_noise: boolean;
};

export type TrajectoryDiffReport = {
	failing_id: string;
	baselines: number;
	pairwise: PairwiseDiff[];
	/** Differences ordered by how well they discriminate. */
	differences: ScoredDifference[];
	/**
	 * The earliest discriminating difference. Distinct from the first
	 * *difference*, which is frequently noise, and the distinction is the point
	 * of having more than one baseline.
	 */
	divergence_point: ScoredDifference | null;
	/** The earliest difference of any kind, for comparison. */
	first_difference: ScoredDifference | null;
	caveats: string[];
};

function differenceKey(difference: Difference): string {
	const action = difference.failing_step?.action ?? difference.healthy_step?.action ?? "?";
	return `${difference.kind}|${action}`;
}

/**
 * Diff a failing trajectory against several healthy ones.
 *
 * Discriminativeness is computed by asking how many *other* healthy runs also
 * exhibit each difference relative to the first baseline. A difference the
 * baselines disagree about among themselves is run-to-run variation and is
 * marked as noise rather than quietly ranked below the real one — a reader
 * scanning a ranked list will treat position four as meaningful.
 */
export function diffAgainstBaselines(
	failing: Trajectory,
	healthy: Trajectory[],
): TrajectoryDiffReport {
	const caveats: string[] = [];
	if (healthy.length === 0) {
		return {
			failing_id: failing.id,
			baselines: 0,
			pairwise: [],
			differences: [],
			divergence_point: null,
			first_difference: null,
			caveats: ["no healthy baseline supplied: nothing can be said about what differed"],
		};
	}
	if (healthy.length < MIN_BASELINES) {
		caveats.push(
			`only ${healthy.length} healthy baseline(s); at least ${MIN_BASELINES} are needed to separate a cause from ordinary run-to-run variation, so no difference here can be called discriminating`,
		);
	}

	const pairwise = healthy.map((h) => diffPair(failing, h));

	// Baseline-to-baseline variation: the differences healthy runs show among
	// themselves are the noise floor.
	const reference = healthy[0];
	const noiseKeys = new Map<string, number>();
	for (const other of healthy.slice(1)) {
		for (const difference of diffPair(other, reference).differences) {
			const key = differenceKey(difference);
			noiseKeys.set(key, (noiseKeys.get(key) ?? 0) + 1);
		}
	}
	const baselinePairs = Math.max(1, healthy.length - 1);

	// A difference counts once, at its earliest anchor, across all baselines.
	const merged = new Map<string, Difference>();
	for (const pair of pairwise) {
		for (const difference of pair.differences) {
			const key = differenceKey(difference);
			const existing = merged.get(key);
			if (
				!existing ||
				(difference.at_failing_index ?? Number.POSITIVE_INFINITY) <
					(existing.at_failing_index ?? Number.POSITIVE_INFINITY)
			) {
				merged.set(key, difference);
			}
		}
	}

	const scored: ScoredDifference[] = [...merged.entries()].map(([key, difference]) => {
		const shared = noiseKeys.get(key) ?? 0;
		const discriminativeness =
			healthy.length < MIN_BASELINES ? 0 : Math.max(0, 1 - shared / baselinePairs);
		return {
			...difference,
			shared_with_healthy: shared,
			total_baselines: healthy.length,
			discriminativeness,
			is_noise: healthy.length >= MIN_BASELINES && shared / baselinePairs > NOISE_THRESHOLD,
		};
	});

	scored.sort(
		(a, b) =>
			b.discriminativeness - a.discriminativeness ||
			(a.at_failing_index ?? Number.POSITIVE_INFINITY) -
				(b.at_failing_index ?? Number.POSITIVE_INFINITY) ||
			a.kind.localeCompare(b.kind),
	);

	const byPosition = [...scored].sort(
		(a, b) =>
			(a.at_failing_index ?? Number.POSITIVE_INFINITY) -
				(b.at_failing_index ?? Number.POSITIVE_INFINITY) || a.kind.localeCompare(b.kind),
	);
	const firstDifference = byPosition[0] ?? null;
	const divergence = byPosition.find((d) => !d.is_noise && d.discriminativeness > 0) ?? null;

	if (divergence && firstDifference && divergence !== firstDifference) {
		caveats.push(
			`the first difference (${firstDifference.kind} at step ${firstDifference.at_failing_index}) also appears between healthy runs and is not the divergence point`,
		);
	}
	if (scored.length > 0 && scored.every((d) => d.is_noise)) {
		caveats.push(
			"every difference also occurs between healthy runs: this failing trajectory is not distinguishable from a healthy one by its shape",
		);
	}

	return {
		failing_id: failing.id,
		baselines: healthy.length,
		pairwise,
		differences: scored,
		divergence_point: divergence,
		first_difference: firstDifference,
		caveats,
	};
}
