/**
 * Minimal failing-trace reduction that preserves the diagnosed cause
 * (item 70).
 *
 * Delta debugging shrinks a failing input by repeatedly removing parts and
 * keeping the removal if the failure survives. Applied naively to a trace it
 * produces something smaller that still fails — which is not the same as
 * something smaller that still fails *for the same reason*, and the difference
 * matters more than the reduction does. A trace reduced until it fails on a
 * missing dependency, when the bug was a race condition, is worse than the
 * original: it is short, it is wrong, and its shortness makes it convincing.
 *
 * So the oracle here has two outputs, not one. `reproduces` says the run still
 * failed; `cause_signature` says why. A candidate is accepted only when both
 * match the original. Every rejection where the failure survived but the cause
 * changed is recorded in `cause_drift`, because those are the most interesting
 * events in the whole reduction: each one is an element that was load-bearing
 * for the diagnosis without being load-bearing for the failure.
 *
 * Three further honesty requirements:
 *
 * - **The result is 1-minimal, not minimal.** Delta debugging guarantees that
 *   no *single* remaining element can be removed, not that no smaller failing
 *   subset exists. `ReductionResult.minimality` says which was achieved, and
 *   the distinction is stated rather than left to whoever reads "minimal".
 *
 * - **Monotonicity is assumed and checked.** Reduction assumes removing
 *   elements cannot turn a passing configuration into a failing one. Real
 *   traces violate this — remove a retry and a timing window changes. Observed
 *   violations are counted, and a reduction with violations is flagged as
 *   unreliable rather than reported as if the assumption had held.
 *
 * - **Dependencies are respected.** A child span cannot remain when its parent
 *   is removed. Candidate subsets are closed over dependencies before being
 *   tested, so the oracle never sees an incoherent trace and never reports a
 *   failure caused by the reducer.
 *
 * Pure: the oracle is injected, so this module runs nothing.
 */

export type TraceElement = {
	id: string;
	/** Elements that must be present for this one to be meaningful. */
	depends_on?: string[];
	label?: string;
};

export type OracleResult = {
	/** Did the reduced trace still fail? */
	reproduces: boolean;
	/**
	 * Why it failed. Compared against the original; a different value means the
	 * reduction changed the bug rather than shrinking the evidence for it.
	 */
	cause_signature?: string;
};

/** Runs a candidate subset. Injected so this module spawns nothing. */
export type ReductionOracle = (elementIds: string[]) => Promise<OracleResult> | OracleResult;

export type ReductionOptions = {
	/** Maximum oracle invocations. Reduction stops and says so when exhausted. */
	max_oracle_calls?: number;
	/** Stop once the candidate is this small, even if further reduction is possible. */
	target_size?: number;
};

export const DEFAULT_MAX_ORACLE_CALLS = 500;

export type CauseDrift = {
	/** Elements removed in the candidate that changed the cause. */
	removed: string[];
	from_signature: string;
	to_signature: string;
};

export type ReductionResult = {
	/** The reduced element set, in original order. */
	elements: TraceElement[];
	original_size: number;
	reduced_size: number;
	oracle_calls: number;
	/**
	 * `one_minimal` — no single remaining element can be removed.
	 * `budget_exhausted` — the search stopped early.
	 * `target_reached` — the caller's size target was met before minimality.
	 * `not_reduced` — nothing could be removed at all.
	 */
	minimality: "one_minimal" | "budget_exhausted" | "target_reached" | "not_reduced";
	/** Candidates where the failure survived but the diagnosis did not. */
	cause_drift: CauseDrift[];
	/** Candidates that passed after a removal that a monotone system would keep failing. */
	non_monotonic_observations: number;
	caveats: string[];
};

/**
 * Close a subset over its dependencies.
 *
 * Removing an element removes everything that depends on it, transitively.
 * Testing a subset that contains a child without its parent would put an
 * incoherent trace in front of the oracle, and a failure caused by the reducer
 * is indistinguishable — to the reducer — from the failure it is investigating.
 */
export function closeOverDependencies(elements: TraceElement[], keep: Set<string>): Set<string> {
	const byId = new Map(elements.map((e) => [e.id, e]));
	const result = new Set(keep);
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of [...result]) {
			const element = byId.get(id);
			if (!element?.depends_on) continue;
			for (const dependency of element.depends_on) {
				if (!byId.has(dependency)) continue;
				if (!result.has(dependency)) {
					// The dependency is absent, so this element cannot stay.
					result.delete(id);
					changed = true;
					break;
				}
			}
		}
	}
	return result;
}

/**
 * Reduce a failing trace while preserving its diagnosed cause.
 *
 * Implements ddmin: try removing complements at increasing granularity,
 * halving the chunk size when nothing at the current granularity can go. The
 * departure from textbook ddmin is the acceptance test — a candidate must both
 * reproduce *and* reproduce for the same reason.
 */
export async function reduceTrace(
	elements: TraceElement[],
	oracle: ReductionOracle,
	options: ReductionOptions = {},
): Promise<ReductionResult> {
	const maxCalls = options.max_oracle_calls ?? DEFAULT_MAX_ORACLE_CALLS;
	const target = options.target_size ?? 0;
	const order = new Map(elements.map((e, i) => [e.id, i]));

	let calls = 0;
	const drift: CauseDrift[] = [];
	let nonMonotonic = 0;
	let budgetExhausted = false;
	let targetReached = false;

	const baseline = await oracle(elements.map((e) => e.id));
	calls++;
	if (!baseline.reproduces) {
		return {
			elements,
			original_size: elements.length,
			reduced_size: elements.length,
			oracle_calls: calls,
			minimality: "not_reduced",
			cause_drift: [],
			non_monotonic_observations: 0,
			caveats: [
				"the full trace does not reproduce the failure; there is nothing to reduce and the input is not a failing trace",
			],
		};
	}
	const causeSignature = baseline.cause_signature;

	/** Test a candidate. `true` only when it fails the same way. */
	const accepts = async (candidate: string[], removed: string[]): Promise<boolean> => {
		if (calls >= maxCalls) {
			budgetExhausted = true;
			return false;
		}
		const result = await oracle(candidate);
		calls++;
		if (!result.reproduces) return false;
		if (causeSignature !== undefined && result.cause_signature !== causeSignature) {
			drift.push({
				removed: [...removed],
				from_signature: causeSignature,
				to_signature: result.cause_signature ?? "unknown",
			});
			return false;
		}
		return true;
	};

	let current = new Set(elements.map((e) => e.id));
	let granularity = 2;

	while (current.size > target && !budgetExhausted) {
		const ids = [...current].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
		if (ids.length < 2) break;

		const chunkSize = Math.max(1, Math.floor(ids.length / granularity));
		let reduced = false;

		for (let start = 0; start < ids.length; start += chunkSize) {
			const removed = ids.slice(start, start + chunkSize);
			if (removed.length === 0) continue;
			const keep = new Set(ids.filter((id) => !removed.includes(id)));
			const closed = closeOverDependencies(elements, keep);
			if (closed.size === 0 || closed.size === ids.length) continue;

			const candidate = [...closed].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
			if (await accepts(candidate, removed)) {
				current = closed;
				granularity = Math.max(2, granularity - 1);
				reduced = true;
				break;
			}
			if (budgetExhausted) break;
		}

		if (current.size <= target) {
			targetReached = true;
			break;
		}
		if (!reduced) {
			if (granularity >= ids.length) break;
			granularity = Math.min(ids.length, granularity * 2);
		}
	}

	// Monotonicity check: with the reduction settled, removing any single
	// remaining element should still fail to reproduce. One that *does*
	// reproduce means the search missed it, which is what non-monotonicity
	// looks like from the inside.
	if (!budgetExhausted && !targetReached) {
		for (const id of [...current]) {
			if (calls >= maxCalls) {
				budgetExhausted = true;
				break;
			}
			const keep = new Set([...current].filter((x) => x !== id));
			const closed = closeOverDependencies(elements, keep);
			if (closed.size === 0) continue;
			const candidate = [...closed].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
			const result = await oracle(candidate);
			calls++;
			if (result.reproduces && result.cause_signature === causeSignature) {
				nonMonotonic++;
				current = closed;
			}
		}
	}

	const kept = elements.filter((e) => current.has(e.id));
	const caveats: string[] = [];

	const minimality: ReductionResult["minimality"] = budgetExhausted
		? "budget_exhausted"
		: targetReached
			? "target_reached"
			: kept.length === elements.length
				? "not_reduced"
				: "one_minimal";

	if (minimality === "one_minimal") {
		caveats.push(
			"the result is 1-minimal: no single remaining element can be removed. A smaller failing subset may still exist, since removing two elements together was not tried exhaustively",
		);
	}
	if (minimality === "budget_exhausted") {
		caveats.push(
			`the oracle budget of ${maxCalls} calls was exhausted before minimality was established; the result is smaller than the original but nothing stronger can be claimed`,
		);
	}
	if (nonMonotonic > 0) {
		caveats.push(
			`${nonMonotonic} element(s) turned out to be removable after the main search concluded: the trace is not monotone, so the reduction is a local result rather than a property of the failure`,
		);
	}
	if (drift.length > 0) {
		caveats.push(
			`${drift.length} candidate(s) still failed but with a different cause; those elements are load-bearing for the diagnosis without being load-bearing for the failure, and are listed in cause_drift`,
		);
	}
	if (causeSignature === undefined) {
		caveats.push(
			"the oracle reported no cause signature, so reduction preserved only 'still fails' and may have changed why",
		);
	}

	return {
		elements: kept,
		original_size: elements.length,
		reduced_size: kept.length,
		oracle_calls: calls,
		minimality,
		cause_drift: drift,
		non_monotonic_observations: nonMonotonic,
		caveats,
	};
}

/**
 * Elements whose removal changed the cause without removing the failure.
 *
 * The most diagnostically valuable output of a reduction, and the one a
 * conventional delta-debugger throws away: each of these participates in the
 * mechanism being investigated even though the trace fails without it.
 */
export function causeCriticalElements(result: ReductionResult): string[] {
	return [...new Set(result.cause_drift.flatMap((d) => d.removed))].sort();
}

/** Fraction of the original removed. Reported alongside, never instead of, minimality. */
export function reductionRatio(result: ReductionResult): number {
	if (result.original_size === 0) return 0;
	return 1 - result.reduced_size / result.original_size;
}
