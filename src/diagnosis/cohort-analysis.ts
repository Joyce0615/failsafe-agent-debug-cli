/**
 * Correlating failures with feature flags, rollouts, regions, tenants, and
 * hardware (item 73).
 *
 * The mechanic is easy: split the population by a dimension, compare failure
 * rates, report the ones that differ. Every part of what makes that answer
 * trustworthy is in the guards, and there are four of them.
 *
 * 1. **Simpson's paradox is checked, not hoped away.** A flag enabled first in
 *    a region that was already unhealthy looks harmful in aggregate and is
 *    harmless within every region. This is not a rare curiosity — staged
 *    rollouts *create* the correlation between the flag and the cohort it
 *    started in, so the paradox is the expected case for exactly the dimension
 *    people most want to test. `stratify` recomputes the effect within each
 *    level of a suspected confounder and reports when the direction reverses or
 *    the effect disappears.
 *
 * 2. **Multiple comparisons are counted.** Scanning two hundred tenants at
 *    p < 0.05 finds ten "significant" ones in a perfectly healthy system. The
 *    number of comparisons is recorded and a Benjamini–Hochberg step-up
 *    procedure controls the false-discovery rate, which is the right control
 *    here: the output is a shortlist to investigate, not a single confirmatory
 *    test, and Bonferroni over two hundred tenants would find nothing ever.
 *
 * 3. **Small cells are refused.** A tenant with three requests and two failures
 *    is not a 67% failure rate; it is three requests. Cells below a minimum are
 *    excluded from testing and reported as untested rather than silently
 *    dropped, because "we found nothing wrong with tenant X" and "we could not
 *    look at tenant X" are different statements.
 *
 * 4. **Effect size travels with significance.** With a million samples a 0.1%
 *    difference is significant and irrelevant. Every finding carries the risk
 *    difference and risk ratio so the reader can see the size of the thing.
 *
 * Pure: no I/O.
 */

export const COHORT_DIMENSIONS = [
	"feature_flag",
	"rollout",
	"region",
	"tenant",
	"hardware",
] as const;
export type CohortDimension = (typeof COHORT_DIMENSIONS)[number];

/** One observed request/run, labelled with whatever dimensions are known. */
export type CohortSample = {
	id: string;
	failed: boolean;
	/** Dimension → value, e.g. `{ region: "eu-west-1", feature_flag: "on" }`. */
	labels: Partial<Record<CohortDimension, string>>;
};

/** Samples below this cannot support a rate estimate. */
export const MIN_CELL_SIZE = 30;
/** Target false-discovery rate for the Benjamini–Hochberg procedure. */
export const DEFAULT_FDR = 0.05;

export type Cell = {
	value: string;
	total: number;
	failures: number;
	rate: number;
};

/** Normal CDF via the Abramowitz–Stegun erf approximation. */
function normalCdf(z: number): number {
	const t = 1 / (1 + 0.2316419 * Math.abs(z));
	const d = 0.3989423 * Math.exp((-z * z) / 2);
	const p =
		d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
	return z > 0 ? 1 - p : p;
}

/**
 * Two-proportion z-test, two-sided.
 *
 * Returns `null` when the normal approximation does not hold — fewer than five
 * expected events or non-events in either arm. Returning a p-value there would
 * be a number computed from a formula that does not apply, which is worse than
 * no number because it looks the same as a valid one.
 */
export function twoProportionP(
	failuresA: number,
	totalA: number,
	failuresB: number,
	totalB: number,
): number | null {
	if (totalA === 0 || totalB === 0) return null;
	const pooled = (failuresA + failuresB) / (totalA + totalB);
	const expected = [pooled * totalA, (1 - pooled) * totalA, pooled * totalB, (1 - pooled) * totalB];
	if (expected.some((e) => e < 5)) return null;

	const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
	if (se === 0) return null;
	const z = (failuresA / totalA - failuresB / totalB) / se;
	return 2 * (1 - normalCdf(Math.abs(z)));
}

export type Finding = {
	dimension: CohortDimension;
	value: string;
	cell: Cell;
	/** Everything not in this cell. */
	rest: Cell;
	/** cell.rate − rest.rate. Signed: a protective value is a real result. */
	risk_difference: number;
	/** cell.rate / rest.rate. `null` when the comparison rate is zero. */
	risk_ratio: number | null;
	p_value: number;
	/** True after the false-discovery-rate adjustment, not before. */
	significant: boolean;
};

export type UntestedCell = {
	dimension: CohortDimension;
	value: string;
	total: number;
	reason: string;
};

function cellOf(value: string, samples: CohortSample[]): Cell {
	const failures = samples.filter((s) => s.failed).length;
	return {
		value,
		total: samples.length,
		failures,
		rate: samples.length > 0 ? failures / samples.length : 0,
	};
}

export type CohortReport = {
	samples: number;
	overall_rate: number;
	comparisons: number;
	findings: Finding[];
	untested: UntestedCell[];
	fdr: number;
	caveats: string[];
};

/**
 * Test every value of every dimension against the rest of the population.
 *
 * The Benjamini–Hochberg step-up runs over all comparisons together, not per
 * dimension: the researcher-degrees-of-freedom problem does not respect the
 * boundaries of a for-loop, and adjusting within each dimension separately
 * would restore most of the inflation the adjustment exists to remove.
 */
export function analyzeCohorts(
	samples: CohortSample[],
	opts: { min_cell?: number; fdr?: number } = {},
): CohortReport {
	const minCell = opts.min_cell ?? MIN_CELL_SIZE;
	const fdr = opts.fdr ?? DEFAULT_FDR;

	const overallFailures = samples.filter((s) => s.failed).length;
	const candidates: Finding[] = [];
	const untested: UntestedCell[] = [];

	for (const dimension of COHORT_DIMENSIONS) {
		const labelled = samples.filter((s) => s.labels[dimension] !== undefined);
		if (labelled.length === 0) continue;

		const values = [...new Set(labelled.map((s) => s.labels[dimension]!))].sort();
		for (const value of values) {
			const inCell = labelled.filter((s) => s.labels[dimension] === value);
			const outside = labelled.filter((s) => s.labels[dimension] !== value);

			if (inCell.length < minCell) {
				untested.push({
					dimension,
					value,
					total: inCell.length,
					reason: `${inCell.length} samples, below the ${minCell} needed to estimate a rate`,
				});
				continue;
			}
			if (outside.length < minCell) {
				untested.push({
					dimension,
					value,
					total: inCell.length,
					reason: `only ${outside.length} samples outside this cell to compare against`,
				});
				continue;
			}

			const cell = cellOf(value, inCell);
			const rest = cellOf(`not ${value}`, outside);
			const p = twoProportionP(cell.failures, cell.total, rest.failures, rest.total);
			if (p === null) {
				untested.push({
					dimension,
					value,
					total: inCell.length,
					reason: "too few expected events for the normal approximation to hold",
				});
				continue;
			}

			candidates.push({
				dimension,
				value,
				cell,
				rest,
				risk_difference: cell.rate - rest.rate,
				risk_ratio: rest.rate > 0 ? cell.rate / rest.rate : null,
				p_value: p,
				significant: false,
			});
		}
	}

	// Benjamini–Hochberg step-up over every comparison made.
	const ordered = [...candidates].sort((a, b) => a.p_value - b.p_value);
	let cutoff = -1;
	for (let i = 0; i < ordered.length; i++) {
		if (ordered[i].p_value <= ((i + 1) / ordered.length) * fdr) cutoff = i;
	}
	for (let i = 0; i <= cutoff; i++) ordered[i].significant = true;

	const findings = [...candidates].sort(
		(a, b) =>
			Number(b.significant) - Number(a.significant) ||
			Math.abs(b.risk_difference) - Math.abs(a.risk_difference) ||
			a.p_value - b.p_value,
	);

	const caveats: string[] = [];
	if (candidates.length > 1) {
		caveats.push(
			`${candidates.length} comparisons were made; p-values are reported raw and significance is decided by a Benjamini–Hochberg step-up at q=${fdr}, not by comparing each p-value to ${fdr}`,
		);
	}
	if (untested.length > 0) {
		caveats.push(
			`${untested.length} cell(s) were too small to test; "no finding" for those means "not looked at", not "nothing wrong"`,
		);
	}
	const significant = findings.filter((f) => f.significant);
	const tiny = significant.filter((f) => Math.abs(f.risk_difference) < 0.01);
	if (tiny.length > 0) {
		caveats.push(
			`${tiny.length} significant finding(s) have a risk difference under 1 percentage point; at this sample size significance is cheap and the effect sizes are what matter`,
		);
	}

	return {
		samples: samples.length,
		overall_rate: samples.length > 0 ? overallFailures / samples.length : 0,
		comparisons: candidates.length,
		findings,
		untested,
		fdr,
		caveats,
	};
}

export type Stratum = {
	level: string;
	cell: Cell;
	rest: Cell;
	risk_difference: number;
	/** Whether this stratum had enough data to say anything. */
	tested: boolean;
};

export type StratifiedResult = {
	dimension: CohortDimension;
	value: string;
	confounder: CohortDimension;
	crude_risk_difference: number;
	strata: Stratum[];
	/**
	 * Mantel–Haenszel-style pooled effect: the average within-stratum effect,
	 * weighted by stratum size. This is the number that survives confounding.
	 */
	adjusted_risk_difference: number;
	/**
	 * `confirmed` — the effect holds within strata.
	 * `reversed` — the within-stratum effect points the other way (Simpson's
	 *   paradox in its full form).
	 * `explained_away` — the effect vanishes within strata.
	 * `untestable` — no stratum had enough data.
	 */
	verdict: "confirmed" | "reversed" | "explained_away" | "untestable";
	detail: string;
};

/** Fraction of the crude effect that must survive for it to count as confirmed. */
export const CONFOUNDING_TOLERANCE = 0.5;

/**
 * Recompute an effect within levels of a suspected confounder.
 *
 * This is the check staged rollouts make mandatory. Enabling a flag first in
 * one region *creates* an association between the flag and that region, so if
 * the region was already unhealthy the flag inherits its failure rate. The
 * crude comparison then reports a harmful flag that is harmless everywhere you
 * look closely.
 */
export function stratify(
	samples: CohortSample[],
	dimension: CohortDimension,
	value: string,
	confounder: CohortDimension,
	opts: { min_cell?: number } = {},
): StratifiedResult {
	const minCell = opts.min_cell ?? MIN_CELL_SIZE;
	const labelled = samples.filter(
		(s) => s.labels[dimension] !== undefined && s.labels[confounder] !== undefined,
	);

	const crudeCell = cellOf(
		value,
		labelled.filter((s) => s.labels[dimension] === value),
	);
	const crudeRest = cellOf(
		"rest",
		labelled.filter((s) => s.labels[dimension] !== value),
	);
	const crude = crudeCell.rate - crudeRest.rate;

	const levels = [...new Set(labelled.map((s) => s.labels[confounder]!))].sort();
	const strata: Stratum[] = levels.map((level) => {
		const within = labelled.filter((s) => s.labels[confounder] === level);
		const cell = cellOf(
			value,
			within.filter((s) => s.labels[dimension] === value),
		);
		const rest = cellOf(
			"rest",
			within.filter((s) => s.labels[dimension] !== value),
		);
		return {
			level,
			cell,
			rest,
			risk_difference: cell.rate - rest.rate,
			tested: cell.total >= minCell && rest.total >= minCell,
		};
	});

	const tested = strata.filter((s) => s.tested);
	if (tested.length === 0) {
		return {
			dimension,
			value,
			confounder,
			crude_risk_difference: crude,
			strata,
			adjusted_risk_difference: 0,
			verdict: "untestable",
			detail: `no level of '${confounder}' has ${minCell} samples on both sides; the confounder cannot be ruled out or confirmed from this data`,
		};
	}

	const weight = tested.reduce((sum, s) => sum + s.cell.total + s.rest.total, 0);
	const adjusted =
		weight === 0
			? 0
			: tested.reduce((sum, s) => sum + s.risk_difference * (s.cell.total + s.rest.total), 0) /
				weight;

	let verdict: StratifiedResult["verdict"];
	let detail: string;
	if (crude !== 0 && Math.sign(adjusted) !== 0 && Math.sign(adjusted) !== Math.sign(crude)) {
		verdict = "reversed";
		detail = `the crude effect is ${crude.toFixed(3)} but within levels of '${confounder}' it is ${adjusted.toFixed(3)}: the association is produced by the confounder, not by '${dimension}'`;
	} else if (Math.abs(adjusted) < Math.abs(crude) * CONFOUNDING_TOLERANCE) {
		verdict = "explained_away";
		detail = `the crude effect of ${crude.toFixed(3)} shrinks to ${adjusted.toFixed(3)} once '${confounder}' is held constant; most of it was the confounder`;
	} else {
		verdict = "confirmed";
		detail = `the effect survives stratification by '${confounder}' (${crude.toFixed(3)} crude, ${adjusted.toFixed(3)} adjusted)`;
	}

	return {
		dimension,
		value,
		confounder,
		crude_risk_difference: crude,
		strata,
		adjusted_risk_difference: adjusted,
		verdict,
		detail,
	};
}

/**
 * Dimensions worth checking as confounders for a finding.
 *
 * Any other dimension that is *associated* with the finding's dimension — which
 * is what a staged rollout guarantees — is a candidate. Returned rather than
 * automatically applied, because stratifying by everything at once shatters the
 * data into cells too small to say anything.
 */
export function suspectedConfounders(
	samples: CohortSample[],
	dimension: CohortDimension,
	value: string,
): Array<{ confounder: CohortDimension; association: number }> {
	const labelled = samples.filter((s) => s.labels[dimension] !== undefined);
	const inCell = labelled.filter((s) => s.labels[dimension] === value);
	const outside = labelled.filter((s) => s.labels[dimension] !== value);
	if (inCell.length === 0 || outside.length === 0) return [];

	const results: Array<{ confounder: CohortDimension; association: number }> = [];
	for (const confounder of COHORT_DIMENSIONS) {
		if (confounder === dimension) continue;
		const levels = [...new Set(labelled.map((s) => s.labels[confounder]).filter(Boolean))];
		if (levels.length < 2) continue;

		// Total-variation distance between the confounder's distribution inside
		// and outside the cell: how unevenly the cell was assigned.
		let distance = 0;
		for (const level of levels) {
			const inside = inCell.filter((s) => s.labels[confounder] === level).length / inCell.length;
			const out = outside.filter((s) => s.labels[confounder] === level).length / outside.length;
			distance += Math.abs(inside - out);
		}
		results.push({ confounder, association: distance / 2 });
	}

	return results
		.filter((r) => r.association > 0.1)
		.sort((a, b) => b.association - a.association || a.confounder.localeCompare(b.confounder));
}
