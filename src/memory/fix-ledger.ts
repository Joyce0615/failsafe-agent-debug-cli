/**
 * Longitudinal tracking of fix attempts, outcomes, regressions, and
 * invalidated hypotheses (item 78).
 *
 * Item 32 remembers dead ends so an agent does not retry them. This module is
 * the layer above: what happened to those fixes *over time*, which is a
 * different question with three answers people routinely get wrong.
 *
 * 1. **A fix that resolved and later regressed is not a success.** Outcome is
 *    therefore not a field but a *history*: `resolved` at T can become
 *    `regressed` at T+n, and the ledger keeps both. It follows that any success
 *    rate is meaningless without the observation window it was measured over —
 *    a 95% success rate measured one hour after each fix is a statement about
 *    one hour. `durabilityReport` refuses to report a rate without a window and
 *    excludes attempts too recent to have been observed for that long, because
 *    counting a fix from this morning as durable is how the number gets good.
 *
 * 2. **A hypothesis invalidated later retracts the justification it lent.**
 *    If one hypothesis justified three fixes and is subsequently refuted, those
 *    three fixes are not wrong — they may have worked — but their *reasons* are
 *    gone, and a system that keeps citing them is citing a retracted claim.
 *    `invalidateHypothesis` marks them `justification_retracted` rather than
 *    changing their outcome, since the two facts are independent.
 *
 * 3. **Attempts per resolution is the number that predicts frustration.** A
 *    signature resolved on the first attempt and one resolved on the ninth look
 *    identical in a success rate and are completely different experiences.
 *
 * Pure: analysis over records, no I/O.
 */

export const ATTEMPT_OUTCOMES = ["unresolved", "resolved", "regressed", "unknown"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export type OutcomeObservation = {
	outcome: AttemptOutcome;
	observed_at_ms: number;
	/** How this was established: a rerun, a user report, a later failure. */
	source: string;
};

export type FixEpisode = {
	id: string;
	/** Failure signature this attempt targeted. */
	signature: string;
	attempted_at_ms: number;
	summary: string;
	files_changed: string[];
	/** Hypotheses this fix was justified by. */
	justified_by: string[];
	/**
	 * Outcome observations, oldest first. The *last* one is current; the whole
	 * list is what makes a regression visible.
	 */
	observations: OutcomeObservation[];
	/** Set when a hypothesis that justified this fix was later refuted. */
	justification_retracted?: { hypothesis: string; at_ms: number; reason: string };
};

/** The outcome as of `atMs`, or `unknown` if nothing was observed by then. */
export function outcomeAt(episode: FixEpisode, atMs: number): AttemptOutcome {
	let current: AttemptOutcome = "unknown";
	for (const observation of episode.observations) {
		if (observation.observed_at_ms <= atMs) current = observation.outcome;
	}
	return current;
}

/** The most recent outcome recorded. */
export function currentOutcome(episode: FixEpisode): AttemptOutcome {
	return episode.observations[episode.observations.length - 1]?.outcome ?? "unknown";
}

/**
 * When a fix first resolved and then stopped being resolved.
 *
 * `null` when it never resolved or never regressed. The distinction matters:
 * "never worked" and "worked for three weeks" call for different responses and
 * a single `success: false` flag conflates them.
 */
export function regressionAt(
	episode: FixEpisode,
): { resolved_at_ms: number; regressed_at_ms: number } | null {
	let resolvedAt: number | null = null;
	for (const observation of episode.observations) {
		if (observation.outcome === "resolved") {
			resolvedAt ??= observation.observed_at_ms;
		} else if (resolvedAt !== null && observation.outcome === "regressed") {
			return { resolved_at_ms: resolvedAt, regressed_at_ms: observation.observed_at_ms };
		}
	}
	return null;
}

export type DurabilityReport = {
	/** The window every attempt was observed for. Stated, never implied. */
	window_ms: number;
	/** Attempts old enough to have been observed for the full window. */
	eligible: number;
	/** Attempts excluded for being too recent to judge. */
	too_recent: number;
	/** Resolved at the end of the window and never regressed within it. */
	durable: number;
	/** Resolved and then regressed within the window. */
	regressed: number;
	/** Never resolved within the window. */
	never_resolved: number;
	/** durable / eligible, or `null` when nothing was eligible. */
	durable_rate: number | null;
	/** Mean time from resolution to regression, over regressed attempts. */
	mean_time_to_regression_ms: number | null;
	caveats: string[];
};

/**
 * Success rate over an explicit observation window.
 *
 * Attempts younger than the window are *excluded*, not counted as durable.
 * Including them is the single most common way a durability metric becomes
 * flattering: every fix made today has not yet regressed.
 */
export function durabilityReport(
	episodes: FixEpisode[],
	windowMs: number,
	nowMs: number,
): DurabilityReport {
	const eligible = episodes.filter((e) => nowMs - e.attempted_at_ms >= windowMs);
	const tooRecent = episodes.length - eligible.length;

	let durable = 0;
	let regressed = 0;
	let neverResolved = 0;
	const regressionDelays: number[] = [];

	for (const episode of eligible) {
		const deadline = episode.attempted_at_ms + windowMs;
		const withinWindow = {
			...episode,
			observations: episode.observations.filter((o) => o.observed_at_ms <= deadline),
		};
		const regression = regressionAt(withinWindow);
		if (regression) {
			regressed++;
			regressionDelays.push(regression.regressed_at_ms - regression.resolved_at_ms);
			continue;
		}
		if (outcomeAt(withinWindow, deadline) === "resolved") durable++;
		else neverResolved++;
	}

	const caveats: string[] = [
		`durability is measured over a ${Math.round(windowMs / 3_600_000)}-hour window; a rate quoted without one says nothing`,
	];
	if (tooRecent > 0) {
		caveats.push(
			`${tooRecent} attempt(s) are younger than the window and are excluded rather than counted as durable`,
		);
	}
	if (eligible.length === 0) {
		caveats.push("no attempt is old enough to judge: there is no rate to report yet");
	}

	return {
		window_ms: windowMs,
		eligible: eligible.length,
		too_recent: tooRecent,
		durable,
		regressed,
		never_resolved: neverResolved,
		durable_rate: eligible.length > 0 ? durable / eligible.length : null,
		mean_time_to_regression_ms:
			regressionDelays.length > 0
				? regressionDelays.reduce((a, b) => a + b, 0) / regressionDelays.length
				: null,
		caveats,
	};
}

/**
 * Retract the justification of every fix that leaned on a refuted hypothesis.
 *
 * Deliberately does *not* change any outcome. A fix justified by a wrong
 * hypothesis may still have worked — for a reason nobody has articulated — and
 * marking it failed would destroy real information. What is gone is the
 * *reason*, and a system still citing it is citing a retracted claim.
 *
 * Returns new episodes; the input is not mutated.
 */
export function invalidateHypothesis(
	episodes: FixEpisode[],
	hypothesis: string,
	atMs: number,
	reason: string,
): { episodes: FixEpisode[]; retracted: string[] } {
	const retracted: string[] = [];
	const updated = episodes.map((episode) => {
		if (!episode.justified_by.includes(hypothesis)) return episode;
		retracted.push(episode.id);
		return {
			...episode,
			justification_retracted: { hypothesis, at_ms: atMs, reason },
		};
	});
	return { episodes: updated, retracted };
}

export type SignatureHistory = {
	signature: string;
	attempts: number;
	/** Attempts before the first durable resolution, or `null` if never. */
	attempts_to_resolution: number | null;
	first_attempt_ms: number;
	last_attempt_ms: number;
	current_outcome: AttemptOutcome;
	/** Times this signature recurred after being marked resolved. */
	recurrences: number;
	/** Fixes whose justification was retracted. */
	retracted_justifications: number;
	/** Files touched across all attempts, most-touched first. */
	churned_files: Array<{ file: string; attempts: number }>;
	warnings: string[];
};

/** Attempts on one signature above which the approach is probably wrong. */
export const THRASHING_THRESHOLD = 4;

/**
 * Per-signature history.
 *
 * `attempts_to_resolution` is the number that predicts frustration: a signature
 * resolved on the first attempt and one resolved on the ninth are identical in
 * any success rate and are completely different experiences. `churned_files`
 * exposes the other pattern worth catching — the same file edited five times
 * for the same failure means the diagnosis, not the edit, is the problem.
 */
export function signatureHistory(episodes: FixEpisode[], signature: string): SignatureHistory {
	const attempts = episodes
		.filter((e) => e.signature === signature)
		.sort((a, b) => a.attempted_at_ms - b.attempted_at_ms || a.id.localeCompare(b.id));

	if (attempts.length === 0) {
		return {
			signature,
			attempts: 0,
			attempts_to_resolution: null,
			first_attempt_ms: 0,
			last_attempt_ms: 0,
			current_outcome: "unknown",
			recurrences: 0,
			retracted_justifications: 0,
			churned_files: [],
			warnings: ["no attempts recorded for this signature"],
		};
	}

	let attemptsToResolution: number | null = null;
	attempts.forEach((episode, i) => {
		if (attemptsToResolution === null && currentOutcome(episode) === "resolved") {
			attemptsToResolution = i + 1;
		}
	});

	const recurrences = attempts.filter((e) => regressionAt(e) !== null).length;
	const churn = new Map<string, number>();
	for (const episode of attempts) {
		for (const file of new Set(episode.files_changed)) {
			churn.set(file, (churn.get(file) ?? 0) + 1);
		}
	}

	const warnings: string[] = [];
	if (attempts.length >= THRASHING_THRESHOLD && attemptsToResolution === null) {
		warnings.push(
			`${attempts.length} attempts with no resolution: the diagnosis is more likely wrong than the fixes`,
		);
	}
	const heavilyChurned = [...churn.entries()].filter(([, n]) => n >= THRASHING_THRESHOLD);
	for (const [file, n] of heavilyChurned) {
		warnings.push(
			`'${file}' was edited in ${n} separate attempts on this signature; repeated edits to one file for one failure point at the diagnosis rather than the edit`,
		);
	}
	if (recurrences > 0) {
		warnings.push(
			`${recurrences} attempt(s) resolved and then regressed; a fix that stops working is evidence the cause was never addressed`,
		);
	}

	return {
		signature,
		attempts: attempts.length,
		attempts_to_resolution: attemptsToResolution,
		first_attempt_ms: attempts[0].attempted_at_ms,
		last_attempt_ms: attempts[attempts.length - 1].attempted_at_ms,
		current_outcome: currentOutcome(attempts[attempts.length - 1]),
		recurrences,
		retracted_justifications: attempts.filter((e) => e.justification_retracted).length,
		churned_files: [...churn.entries()]
			.map(([file, n]) => ({ file, attempts: n }))
			.sort((a, b) => b.attempts - a.attempts || a.file.localeCompare(b.file)),
		warnings,
	};
}

export type LedgerSummary = {
	episodes: number;
	signatures: number;
	/** Signatures with at least one attempt that later regressed. */
	signatures_with_regressions: number;
	/** Mean attempts before a first resolution, over resolved signatures only. */
	mean_attempts_to_resolution: number | null;
	/** Signatures never resolved despite repeated attempts. */
	thrashing: string[];
	/** Episodes whose justification was retracted by a later refutation. */
	retracted: number;
	caveats: string[];
};

/**
 * Ledger-wide summary.
 *
 * `mean_attempts_to_resolution` is computed over resolved signatures only, and
 * the exclusion is stated: averaging in the unresolved ones as though they took
 * their current attempt count would make a worsening situation look like an
 * improving one every time somebody gives up.
 */
export function summarizeLedger(episodes: FixEpisode[]): LedgerSummary {
	const signatures = [...new Set(episodes.map((e) => e.signature))].sort();
	const histories = signatures.map((s) => signatureHistory(episodes, s));
	const resolved = histories.filter((h) => h.attempts_to_resolution !== null);

	const caveats: string[] = [];
	const unresolved = histories.length - resolved.length;
	if (unresolved > 0) {
		caveats.push(
			`mean attempts-to-resolution excludes ${unresolved} unresolved signature(s); counting them at their current attempt count would make the number improve every time somebody gives up`,
		);
	}
	const withRegressions = histories.filter((h) => h.recurrences > 0);
	if (withRegressions.length > 0) {
		caveats.push(
			`${withRegressions.length} signature(s) have fixes that later regressed; those attempts are not successes at any window long enough to see it`,
		);
	}

	return {
		episodes: episodes.length,
		signatures: signatures.length,
		signatures_with_regressions: withRegressions.length,
		mean_attempts_to_resolution:
			resolved.length > 0
				? resolved.reduce((sum, h) => sum + (h.attempts_to_resolution ?? 0), 0) / resolved.length
				: null,
		thrashing: histories
			.filter((h) => h.attempts >= THRASHING_THRESHOLD && h.attempts_to_resolution === null)
			.map((h) => h.signature),
		retracted: episodes.filter((e) => e.justification_retracted).length,
		caveats,
	};
}
