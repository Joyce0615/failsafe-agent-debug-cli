/**
 * Change-point detection across model, prompt, tool, policy, and dependency
 * revisions (item 72).
 *
 * "The failure rate jumped on Tuesday and we shipped a new model on Tuesday"
 * is the shape of almost every regression investigation, and it is wrong more
 * often than it is right for a reason that has nothing to do with the
 * statistics: **deploys bundle revisions**. A Tuesday release contains a model
 * change, two prompt edits, a tool version bump, and nine dependency updates.
 * Attributing the jump to the model is a choice, not a finding, and the honest
 * output is that five revisions are confounded and the data cannot separate
 * them.
 *
 * So this module does three things and refuses to do a fourth:
 *
 * 1. **Detects change points** by binary segmentation with a penalized
 *    mean-shift cost. The penalty is what stops the search from carving noise
 *    into fifty segments — without it, every additional split reduces the cost
 *    and the algorithm happily reports a change point between every pair of
 *    adjacent observations.
 *
 * 2. **Refuses on short series.** A change point in six observations is a
 *    coin flip with error bars. `MIN_SERIES_LENGTH` and a minimum segment size
 *    are enforced and the refusal is explicit.
 *
 * 3. **Attributes only when attribution is possible.** A change point with one
 *    candidate revision in its window gets that revision. A change point with
 *    several gets `confounded` and all of them, and the report says what would
 *    be needed to separate them — which is a staggered rollout, not more
 *    analysis of the same data.
 *
 * It refuses to rank confounded candidates. Ordering five simultaneous
 * revisions by plausibility produces a leader that gets investigated first, and
 * the ordering has no evidential basis whatsoever.
 *
 * Pure: no I/O.
 */

export const REVISION_KINDS = ["model", "prompt", "tool", "policy", "dependency"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export type Revision = {
	id: string;
	kind: RevisionKind;
	at_ms: number;
	/** e.g. `gpt-x@2026-01 → gpt-x@2026-03`, `left-pad 1.2 → 1.3`. */
	description: string;
	/** Deploy or release this revision shipped in, when known. */
	release?: string;
};

export type Observation = {
	at_ms: number;
	/** The metric: failure rate, latency, cost — whatever is being watched. */
	value: number;
};

/** Below this, change-point detection is not meaningful. */
export const MIN_SERIES_LENGTH = 20;
/** Segments shorter than this cannot support a mean estimate. */
export const MIN_SEGMENT_LENGTH = 5;
/** Penalty multiplier on the BIC-style cost for admitting another split. */
export const SPLIT_PENALTY = 2;

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sum of squared deviations from the segment mean. */
function segmentCost(values: number[]): number {
	if (values.length === 0) return 0;
	const m = mean(values);
	return values.reduce((sum, v) => sum + (v - m) ** 2, 0);
}

export type ChangePoint = {
	/** Index of the first observation *after* the change. */
	index: number;
	at_ms: number;
	before_mean: number;
	after_mean: number;
	/** after − before. Sign matters: a drop and a jump are different events. */
	delta: number;
	/** Delta in units of the pooled standard deviation. */
	effect_size: number;
	/** Cost reduction from admitting this split, net of the penalty. */
	gain: number;
};

/**
 * Detect change points by penalized binary segmentation.
 *
 * Recursive, splitting a segment only when the best split's cost reduction
 * exceeds the penalty. `SPLIT_PENALTY * variance * log(n)` is a BIC-flavoured
 * criterion; the exact constant matters less than the fact that one exists,
 * since an unpenalized search will always find another change point.
 */
export function detectChangePoints(
	series: Observation[],
	opts: { min_segment?: number; penalty?: number } = {},
): ChangePoint[] {
	const minSegment = opts.min_segment ?? MIN_SEGMENT_LENGTH;
	const penaltyScale = opts.penalty ?? SPLIT_PENALTY;
	const values = series.map((o) => o.value);
	if (values.length < 2 * minSegment) return [];

	const overallVariance = segmentCost(values) / Math.max(1, values.length - 1);
	const penalty = penaltyScale * overallVariance * Math.log(Math.max(2, values.length));

	const points: ChangePoint[] = [];

	const search = (start: number, end: number): void => {
		const length = end - start;
		if (length < 2 * minSegment) return;

		const whole = segmentCost(values.slice(start, end));
		let bestIndex = -1;
		let bestGain = 0;

		for (let split = start + minSegment; split <= end - minSegment; split++) {
			const left = segmentCost(values.slice(start, split));
			const right = segmentCost(values.slice(split, end));
			const gain = whole - (left + right) - penalty;
			if (gain > bestGain) {
				bestGain = gain;
				bestIndex = split;
			}
		}
		if (bestIndex < 0) return;

		const before = values.slice(start, bestIndex);
		const after = values.slice(bestIndex, end);
		const pooledVariance =
			(segmentCost(before) + segmentCost(after)) / Math.max(1, before.length + after.length - 2);
		const sd = Math.sqrt(Math.max(pooledVariance, Number.EPSILON));

		points.push({
			index: bestIndex,
			at_ms: series[bestIndex].at_ms,
			before_mean: mean(before),
			after_mean: mean(after),
			delta: mean(after) - mean(before),
			effect_size: (mean(after) - mean(before)) / sd,
			gain: bestGain,
		});

		search(start, bestIndex);
		search(bestIndex, end);
	};

	search(0, values.length);
	return points.sort((a, b) => a.index - b.index);
}

export type Attribution = {
	change_point: ChangePoint;
	/** Revisions inside the attribution window, in time order. */
	candidates: Revision[];
	/**
	 * `attributed` — exactly one candidate.
	 * `confounded` — several, and the data cannot separate them.
	 * `unexplained` — none; the change has no candidate revision at all.
	 */
	verdict: "attributed" | "confounded" | "unexplained";
	/** Set only when the verdict is `attributed`. */
	revision?: Revision;
	/** What would be needed to resolve a confound. Never "more analysis". */
	resolution?: string;
	detail: string;
};

/** How far before a change point a revision may sit and still be a candidate. */
export const DEFAULT_ATTRIBUTION_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Attribute change points to revisions.
 *
 * A revision after the change point is never a candidate: causes precede
 * effects, and a window centred on the change point would admit the release
 * that shipped in response to it, which is the most seductive wrong answer
 * available.
 */
export function attributeChangePoints(
	points: ChangePoint[],
	revisions: Revision[],
	windowMs: number = DEFAULT_ATTRIBUTION_WINDOW_MS,
): Attribution[] {
	return points.map((point) => {
		const candidates = revisions
			.filter((r) => r.at_ms <= point.at_ms && point.at_ms - r.at_ms <= windowMs)
			.sort((a, b) => a.at_ms - b.at_ms || a.id.localeCompare(b.id));

		if (candidates.length === 0) {
			return {
				change_point: point,
				candidates,
				verdict: "unexplained",
				detail: `no revision shipped in the ${Math.round(windowMs / 60_000)} minutes before this change; whatever moved was not a revision this system knows about`,
			};
		}
		if (candidates.length === 1) {
			return {
				change_point: point,
				candidates,
				verdict: "attributed",
				revision: candidates[0],
				detail: `exactly one revision (${candidates[0].kind}: ${candidates[0].description}) shipped in the window`,
			};
		}

		const kinds = [...new Set(candidates.map((c) => c.kind))].sort();
		const releases = [...new Set(candidates.map((c) => c.release).filter(Boolean))];
		return {
			change_point: point,
			candidates,
			verdict: "confounded",
			resolution:
				releases.length === 1
					? `these revisions shipped together in release '${releases[0]}'; separating them requires a staggered rollout, not further analysis of this data`
					: "separating these requires deploying them independently; no analysis of a bundled release can distinguish them",
			detail: `${candidates.length} revisions across ${kinds.length} kind(s) (${kinds.join(", ")}) shipped in the window; the data cannot say which one moved the metric`,
		};
	});
}

export type ChangePointReport = {
	observations: number;
	change_points: ChangePoint[];
	attributions: Attribution[];
	/** Set when detection was refused. */
	refused_reason?: string;
	counts: { attributed: number; confounded: number; unexplained: number };
	caveats: string[];
};

/**
 * Detect and attribute in one pass.
 *
 * Refuses on a short series rather than reporting a change point it cannot
 * support: with fifteen observations the segmentation will find *something*,
 * and that something will be presented to a person who has no way to know it is
 * noise.
 */
export function analyzeChangePoints(
	series: Observation[],
	revisions: Revision[],
	opts: { window_ms?: number; min_segment?: number; penalty?: number } = {},
): ChangePointReport {
	const sorted = [...series].sort((a, b) => a.at_ms - b.at_ms);

	if (sorted.length < MIN_SERIES_LENGTH) {
		return {
			observations: sorted.length,
			change_points: [],
			attributions: [],
			refused_reason: `${sorted.length} observations; at least ${MIN_SERIES_LENGTH} are needed before a change point can be distinguished from noise`,
			counts: { attributed: 0, confounded: 0, unexplained: 0 },
			caveats: [
				`${sorted.length} observations; at least ${MIN_SERIES_LENGTH} are needed before a change point can be distinguished from noise`,
			],
		};
	}

	const points = detectChangePoints(sorted, opts);
	const attributions = attributeChangePoints(
		points,
		revisions,
		opts.window_ms ?? DEFAULT_ATTRIBUTION_WINDOW_MS,
	);

	const counts = {
		attributed: attributions.filter((a) => a.verdict === "attributed").length,
		confounded: attributions.filter((a) => a.verdict === "confounded").length,
		unexplained: attributions.filter((a) => a.verdict === "unexplained").length,
	};

	const caveats: string[] = [];
	if (points.length === 0) {
		caveats.push(
			"no change point cleared the penalty: the series is consistent with a single stable regime",
		);
	}
	if (counts.confounded > 0) {
		caveats.push(
			`${counts.confounded} change point(s) have several simultaneous candidate revisions; ranking them by plausibility would produce a leader with no evidential basis, so none is offered`,
		);
	}
	if (counts.unexplained > 0) {
		caveats.push(
			`${counts.unexplained} change point(s) have no candidate revision at all: something outside the tracked revision set moved the metric`,
		);
	}
	const revisionsWithoutChange = revisions.filter(
		(r) =>
			!points.some(
				(p) =>
					p.at_ms >= r.at_ms &&
					p.at_ms - r.at_ms <= (opts.window_ms ?? DEFAULT_ATTRIBUTION_WINDOW_MS),
			),
	).length;
	if (revisionsWithoutChange > 0) {
		caveats.push(
			`${revisionsWithoutChange} of ${revisions.length} revision(s) produced no detectable change; this is the base rate against which any attribution should be read`,
		);
	}

	return { observations: sorted.length, change_points: points, attributions, counts, caveats };
}

/**
 * Per-kind attribution tally.
 *
 * Counts only `attributed` verdicts. Including confounded ones would let a
 * revision kind accumulate credit for changes nobody could attribute to it,
 * which is exactly how "the model is always the problem" becomes folklore.
 */
export function attributionsByKind(
	attributions: Attribution[],
): Array<{ kind: RevisionKind; attributed: number; appeared_confounded: number }> {
	return REVISION_KINDS.map((kind) => ({
		kind,
		attributed: attributions.filter((a) => a.verdict === "attributed" && a.revision?.kind === kind)
			.length,
		appeared_confounded: attributions.filter(
			(a) => a.verdict === "confounded" && a.candidates.some((c) => c.kind === kind),
		).length,
	})).filter((row) => row.attributed > 0 || row.appeared_confounded > 0);
}
