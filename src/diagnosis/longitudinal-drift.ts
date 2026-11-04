/**
 * Longitudinal diagnostic drift reports (item 30).
 *
 * The item asks for one thing across six dimensions — attribution,
 * remediation, abstention, privacy loss, cost, and latency — tracked
 * across providers and releases with STATISTICALLY SUPPORTED regression
 * explanations, published as a report. Nothing in the repo composed these
 * before this module: `change-point.ts` (item 72) detects and attributes a
 * jump in ONE metric series to a revision but has no notion of "six
 * tracked dimensions" or "regression" (a jump is just a jump — whether it is
 * good or bad depends on the metric). `cross-provider-replay.ts` (item 101)
 * diffs diagnosis/remediation drift between pinned providers for ONE
 * failure, not a time series. `fix-ledger.ts` (item 78) tracks
 * attempts/outcomes over time but has no change-point detection and no
 * cross-dimension report. `grep -rln "longitudinal" src/` before this
 * module matched only `fix-ledger.ts`'s own doc comment, and `grep -n
 * "DRIFT_DIMENSIONS\|publish.*report" src/diagnosis/ src/export/` matched
 * nothing.
 *
 * This module supplies exactly the missing glue and reuses the statistics
 * unmodified:
 *
 * 1. **Per-dimension change-point detection and attribution is
 *    `analyzeChangePoints` (item 72), called once per dimension, unmodified.**
 *    Every refusal (`refused_reason` on a short series), every `confounded`
 *    verdict, and every caveat it already produces passes through untouched —
 *    this module adds nothing that could override a statistical refusal with
 *    an opinion.
 * 2. **"Regression" is dimension-specific, not assumed.** A rising
 *    `cost`/`latency`/`privacy_loss` is worse; a rising
 *    `attribution`/`remediation` agreement rate or an *abstention* rate
 *    dropping is BETTER (abstaining more when uncertain is the safer
 *    direction; `DIMENSION_DIRECTION` therefore marks `abstention` as
 *    `up_is_worse` too — unexplained abstention growth is itself a thing
 *    worth flagging, so it is tracked the same way as cost). Each tracked
 *    `ChangePoint` is classified `regression` only when its `delta` moves in
 *    the direction that dimension's own `up_is_worse`/`down_is_worse` tag
 *    calls worse; an improving jump is still reported (so a caller can see
 *    the whole series) but is never counted toward `regressed_dimensions`.
 * 3. **Providers are named, not merged.** Observations for a dimension may
 *    come from several providers; distinct provider names present in a
 *    dimension's series are listed in that dimension's caveats so a reader
 *    knows whether a change point reflects a single provider's behavior or
 *    the whole mix.
 * 4. **An absent dimension is `null`, not an empty/zero report.** A caller
 *    that never recorded `privacy_loss` observations gets `null` for that
 *    dimension rather than a `refused_reason` that implies data existed and
 *    was simply too short — "never measured" and "measured too little" are
 *    different facts.
 *
 * Pure: compares already-collected observations, exactly like
 * `change-point.ts` and `cross-provider-replay.ts` before it. Does not call
 * any provider, store, or remediation logic itself.
 */
import {
	type ChangePoint,
	type ChangePointReport,
	type Revision,
	analyzeChangePoints,
} from "./change-point.js";

export const DRIFT_DIMENSIONS = [
	"attribution",
	"remediation",
	"abstention",
	"privacy_loss",
	"cost",
	"latency",
] as const;
export type DriftDimension = (typeof DRIFT_DIMENSIONS)[number];

/**
 * Which direction counts as worse for each dimension. `attribution` and
 * `remediation` are tracked as agreement/success RATES, so a drop is worse;
 * `abstention`, `privacy_loss`, `cost`, and `latency` are tracked as
 * quantities where a rise is worse.
 */
export const DIMENSION_DIRECTION: Record<DriftDimension, "up_is_worse" | "down_is_worse"> = {
	attribution: "down_is_worse",
	remediation: "down_is_worse",
	abstention: "up_is_worse",
	privacy_loss: "up_is_worse",
	cost: "up_is_worse",
	latency: "up_is_worse",
};

export type DriftObservation = {
	at_ms: number;
	value: number;
	provider: string;
};

export type LongitudinalSeries = Record<DriftDimension, DriftObservation[]>;

export type DimensionDriftReport = ChangePointReport & {
	dimension: DriftDimension;
	direction: "up_is_worse" | "down_is_worse";
	/** The subset of change_points whose delta moved in the worse direction for this dimension. */
	regressions: Array<ChangePointReport["attributions"][number]>;
	providers: string[];
};

export type LongitudinalDriftReport = {
	by_dimension: Record<DriftDimension, DimensionDriftReport | null>;
	regressed_dimensions: DriftDimension[];
};

function isRegression(point: ChangePoint, direction: "up_is_worse" | "down_is_worse"): boolean {
	return direction === "up_is_worse" ? point.delta > 0 : point.delta < 0;
}

function buildDimensionReport(
	dimension: DriftDimension,
	observations: DriftObservation[],
	revisions: Revision[],
): DimensionDriftReport | null {
	if (observations.length === 0) return null;

	const direction = DIMENSION_DIRECTION[dimension];
	const series = observations.map((o) => ({ at_ms: o.at_ms, value: o.value }));
	const changePointReport = analyzeChangePoints(series, revisions);

	const regressions = changePointReport.attributions.filter((a) =>
		isRegression(a.change_point, direction),
	);

	const providers = [...new Set(observations.map((o) => o.provider))].sort();
	const caveats = [...changePointReport.caveats];
	if (providers.length > 0) {
		caveats.push(
			`observations drawn from ${providers.length} provider(s): ${providers.join(", ")}`,
		);
	}

	return {
		...changePointReport,
		caveats,
		dimension,
		direction,
		regressions,
		providers,
	};
}

export type LongitudinalDriftInput = {
	series: LongitudinalSeries;
	revisions: Revision[];
};

/**
 * Build the full longitudinal drift report: one `analyzeChangePoints` pass
 * per dimension (item 72, unmodified), classified into regressions by each
 * dimension's own worse-direction.
 */
export function buildLongitudinalDriftReport(
	input: LongitudinalDriftInput,
): LongitudinalDriftReport {
	const by_dimension = {} as Record<DriftDimension, DimensionDriftReport | null>;
	const regressed_dimensions: DriftDimension[] = [];

	for (const dimension of DRIFT_DIMENSIONS) {
		const report = buildDimensionReport(dimension, input.series[dimension], input.revisions);
		by_dimension[dimension] = report;
		if (report && report.regressions.length > 0) {
			regressed_dimensions.push(dimension);
		}
	}

	return { by_dimension, regressed_dimensions };
}

/** Render a report for a human publishing a longitudinal drift update. */
export function renderLongitudinalDriftReport(report: LongitudinalDriftReport): string {
	const lines: string[] = ["# Longitudinal Diagnostic Drift Report", ""];

	if (report.regressed_dimensions.length > 0) {
		lines.push(`**Regressed dimensions:** ${report.regressed_dimensions.join(", ")}`, "");
	} else {
		lines.push("No dimension regressed.", "");
	}

	for (const dimension of DRIFT_DIMENSIONS) {
		const dim = report.by_dimension[dimension];
		lines.push(`## ${dimension}`, "");
		if (!dim) {
			lines.push("_No observations recorded for this dimension._", "");
			continue;
		}
		if (dim.refused_reason) {
			lines.push(`**Refused:** ${dim.refused_reason}`, "");
			continue;
		}
		lines.push(
			`- change points: ${dim.change_points.length}`,
			`- regressions: ${dim.regressions.length}`,
			`- providers: ${dim.providers.join(", ") || "(none)"}`,
		);
		for (const caveat of dim.caveats) lines.push(`  - caveat: ${caveat}`);
		lines.push("");
	}

	return lines.join("\n");
}
