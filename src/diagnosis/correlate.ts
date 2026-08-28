/**
 * Correlation across logs, traces, metrics, code, configuration, and deployment
 * changes (item 58).
 *
 * Correlating a failure with "something that happened just before it" is easy
 * and almost always wrong, for two reasons this module is built around:
 *
 * 1. **Temporal proximity is the weakest evidence there is**, and it is the
 *    kind every system has in abundance. A shared trace id is a *fact* about
 *    the same execution; a matching service and version is a fact about the
 *    same deployment; a matching file path is a fact about the same code. "It
 *    happened forty seconds earlier" is a fact about a clock. `joinSignals`
 *    ranks joins `identity > entity > content > temporal`, reports which one
 *    it used, and caps the confidence of a temporal-only link so it can never
 *    be presented as if it were any of the others.
 *
 * 2. **Base rates destroy naive correlation.** If a service deploys every four
 *    minutes, then "the error came right after a deploy" is true of every error
 *    and explains none of them. `chanceCoincidence` computes the probability
 *    that a randomly placed failure would land inside the correlation window of
 *    *some* occurrence of the candidate, and `lift` divides observation by that
 *    expectation. A candidate that is always happening has a lift near 1 and is
 *    reported as such rather than as the top result.
 *
 * A third hazard is handled at the report level: scanning two hundred config
 * keys for "the one that changed" will find several by chance alone.
 * `correlationReport` records how many candidates were examined and applies a
 * Bonferroni-style adjustment, so a finding that only survives because the
 * search was wide is visible as one.
 *
 * Pure: takes already-collected signals, performs no I/O.
 */

export const SIGNAL_SOURCES = [
	"logs",
	"traces",
	"metrics",
	"code",
	"configuration",
	"deployment",
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/**
 * One observation from one source.
 *
 * Every identifier is optional because real evidence is ragged: a metric point
 * has a service and no trace, a commit has files and no service. The join
 * ladder is built to degrade over exactly that raggedness rather than to
 * require a complete row.
 */
export type Signal = {
	id: string;
	source: SignalSource;
	ts_ms: number;
	/** End of an interval signal, e.g. a rollout. Absent means instantaneous. */
	end_ms?: number;
	service?: string;
	trace_id?: string;
	span_id?: string;
	version?: string;
	commit?: string;
	file?: string;
	config_key?: string;
	label: string;
};

/** Join kinds, strongest first. Order here is the ranking. */
export const JOIN_STRENGTHS = ["identity", "entity", "content", "temporal"] as const;
export type JoinStrength = (typeof JOIN_STRENGTHS)[number];

export type Join = {
	strength: JoinStrength;
	/** The attribute that matched, e.g. `trace_id` or `service+version`. */
	key: string;
	value: string;
};

/**
 * Ceilings on how confident a link of each strength may ever be.
 *
 * A temporal link is capped well below the point where an agent would act on it
 * unprompted. This is the mechanism that keeps "it happened around then" from
 * being rendered indistinguishably from "it happened in this exact request".
 */
export const STRENGTH_CEILING: Record<JoinStrength, number> = {
	identity: 0.95,
	entity: 0.75,
	content: 0.7,
	temporal: 0.3,
};

export type CorrelateOptions = {
	/** How far apart two signals may be and still be considered related. */
	window_ms?: number;
	/** Total span of observation, used for base rates. */
	observation_span_ms?: number;
};

export const DEFAULT_WINDOW_MS = 5 * 60_000;

/**
 * The strongest available join between two signals, or `null`.
 *
 * Checked in ladder order and returns the first hit, so a pair sharing a trace
 * id is never reported as a merely-temporal coincidence just because the
 * temporal check is cheaper.
 */
export function joinSignals(a: Signal, b: Signal, opts: CorrelateOptions = {}): Join | null {
	const window = opts.window_ms ?? DEFAULT_WINDOW_MS;

	if (a.trace_id && a.trace_id === b.trace_id) {
		if (a.span_id && a.span_id === b.span_id) {
			return { strength: "identity", key: "span_id", value: a.span_id };
		}
		return { strength: "identity", key: "trace_id", value: a.trace_id };
	}

	if (a.service && a.service === b.service && a.version && a.version === b.version) {
		return { strength: "entity", key: "service+version", value: `${a.service}@${a.version}` };
	}

	if (a.commit && a.commit === b.commit) {
		return { strength: "content", key: "commit", value: a.commit };
	}
	if (a.file && a.file === b.file) {
		return { strength: "content", key: "file", value: a.file };
	}
	if (a.config_key && a.config_key === b.config_key) {
		return { strength: "content", key: "config_key", value: a.config_key };
	}
	// Service alone is weaker than service+version but still an entity link: the
	// two observations are about the same running thing.
	if (a.service && a.service === b.service) {
		return { strength: "entity", key: "service", value: a.service };
	}

	if (intervalGap(a, b) <= window) {
		return { strength: "temporal", key: "window", value: `${window}ms` };
	}
	return null;
}

/** Gap between two signals, treating each as an interval when it has an end. */
export function intervalGap(a: Signal, b: Signal): number {
	const aEnd = a.end_ms ?? a.ts_ms;
	const bEnd = b.end_ms ?? b.ts_ms;
	if (a.ts_ms <= bEnd && b.ts_ms <= aEnd) return 0;
	return a.ts_ms > bEnd ? a.ts_ms - bEnd : b.ts_ms - aEnd;
}

export type Direction = "precedes" | "concurrent" | "follows";

/**
 * Temporal relation of a candidate to the target.
 *
 * A candidate that *follows* the target cannot have caused it. It is kept and
 * labelled rather than dropped, because an effect is frequently the most
 * useful thing on the timeline — but it is excluded from causal ranking, which
 * is the distinction naive correlation loses.
 */
export function direction(candidate: Signal, target: Signal): Direction {
	const candidateEnd = candidate.end_ms ?? candidate.ts_ms;
	if (candidateEnd < target.ts_ms) return "precedes";
	if (candidate.ts_ms > (target.end_ms ?? target.ts_ms)) return "follows";
	return "concurrent";
}

/**
 * Probability that a randomly placed instant falls within `window_ms` of one of
 * `occurrences` candidate events spread over `span_ms`.
 *
 * This is the number that makes "it happened right after a deploy" honest.
 * Deploys every four minutes with a five-minute window gives a probability of
 * 1: the coincidence was guaranteed and carries no information.
 */
export function chanceCoincidence(occurrences: number, windowMs: number, spanMs: number): number {
	if (spanMs <= 0 || occurrences <= 0) return 0;
	// Each occurrence covers a window on either side.
	return Math.min(1, (occurrences * 2 * windowMs) / spanMs);
}

export type Correlation = {
	signal: Signal;
	join: Join;
	direction: Direction;
	/** Signed: negative when the candidate precedes the target. */
	lag_ms: number;
	/** Occurrences of this candidate class in the observation window. */
	class_occurrences: number;
	/** Probability a coincidence this close would occur by chance alone. */
	chance: number;
	/** 1 / chance: how much more surprising the coincidence is than nothing. */
	lift: number;
	confidence: number;
	caveats: string[];
};

/**
 * A candidate's *class*, for base-rate purposes.
 *
 * Grouping by source plus the most specific identifier available is what makes
 * "deployments of checkout" a class rather than lumping all deployments
 * everywhere together — a base rate computed over the wrong class is worse than
 * none, because it is precise and irrelevant.
 */
export function signalClass(signal: Signal): string {
	const scope =
		signal.config_key ?? signal.file ?? signal.service ?? signal.trace_id ?? signal.label;
	return `${signal.source}:${scope}`;
}

/** Lift above which a coincidence is worth mentioning at all. */
export const MIN_LIFT = 1.5;

/**
 * Correlate one target signal against a pool of candidates.
 *
 * Confidence is the strength ceiling scaled by how surprising the coincidence
 * is, so a rare, identity-joined precursor lands near the top and a
 * temporal-only coincidence with a candidate that happens constantly lands near
 * zero — which is where it belongs and where naive proximity ranking never puts
 * it.
 */
export function correlate(
	target: Signal,
	candidates: Signal[],
	opts: CorrelateOptions = {},
): Correlation[] {
	const window = opts.window_ms ?? DEFAULT_WINDOW_MS;
	const times = [target, ...candidates].flatMap((s) => [s.ts_ms, s.end_ms ?? s.ts_ms]);
	const span = opts.observation_span_ms ?? Math.max(1, Math.max(...times) - Math.min(...times));

	const classCounts = new Map<string, number>();
	for (const candidate of candidates) {
		const key = signalClass(candidate);
		classCounts.set(key, (classCounts.get(key) ?? 0) + 1);
	}

	const results: Correlation[] = [];
	for (const candidate of candidates) {
		if (candidate.id === target.id) continue;
		const join = joinSignals(target, candidate, opts);
		if (!join) continue;

		const occurrences = classCounts.get(signalClass(candidate)) ?? 1;
		const chance = chanceCoincidence(occurrences, window, span);
		const lift = chance > 0 ? 1 / chance : Number.POSITIVE_INFINITY;
		const dir = direction(candidate, target);

		const caveats: string[] = [];
		if (join.strength === "temporal") {
			caveats.push(
				"joined only by time: no shared trace, entity, or content links these observations",
			);
		}
		if (dir === "follows") {
			caveats.push("occurs after the target and therefore cannot be a cause");
		}
		if (occurrences > 1 && lift < MIN_LIFT) {
			caveats.push(
				`this candidate class occurs ${occurrences} times in the window; a coincidence this close was ${
					chance >= 1 ? "certain" : "likely"
				} by chance`,
			);
		}

		// Surprise is bounded so a single rare event cannot manufacture
		// certainty out of an otherwise weak join.
		const surprise = Number.isFinite(lift) ? Math.min(1, Math.log2(Math.max(1, lift)) / 6) : 1;
		const base = STRENGTH_CEILING[join.strength];
		const penalty = dir === "follows" ? 0.25 : 1;
		const confidence = Math.round(base * (0.4 + 0.6 * surprise) * penalty * 1000) / 1000;

		results.push({
			signal: candidate,
			join,
			direction: dir,
			lag_ms: (candidate.end_ms ?? candidate.ts_ms) - target.ts_ms,
			class_occurrences: occurrences,
			chance,
			lift,
			confidence,
			caveats,
		});
	}

	return results.sort(
		(a, b) =>
			b.confidence - a.confidence ||
			JOIN_STRENGTHS.indexOf(a.join.strength) - JOIN_STRENGTHS.indexOf(b.join.strength) ||
			Math.abs(a.lag_ms) - Math.abs(b.lag_ms) ||
			a.signal.id.localeCompare(b.signal.id),
	);
}

export type CorrelationReport = {
	target: string;
	/** Every candidate considered, including those that produced no join. */
	candidates_examined: number;
	correlations: Correlation[];
	/**
	 * Bonferroni-adjusted confidence floor. Scanning many candidates finds
	 * spurious matches; this raises the bar in proportion to how wide the
	 * search was, and the *number* is reported so the adjustment is auditable.
	 */
	adjusted_threshold: number;
	/** Correlations at or above the adjusted threshold. */
	surviving: Correlation[];
	/** Sources that contributed at least one candidate. */
	sources_present: SignalSource[];
	/** Sources with no candidates at all — an absence worth stating. */
	sources_missing: SignalSource[];
	caveats: string[];
};

/** Base confidence floor before the multiple-comparison adjustment. */
export const BASE_THRESHOLD = 0.35;
/** Candidates that may be examined before the width penalty starts. */
export const FREE_CANDIDATES = 10;
/** The adjustment never pushes the bar above this, or nothing ever survives. */
export const MAX_THRESHOLD = 0.9;

/**
 * Correlate and report, with the multiple-comparison correction applied.
 *
 * `sources_missing` matters as much as the correlations: a diagnosis that never
 * looked at configuration is a different claim from one that looked and found
 * nothing, and only the report can tell the two apart.
 */
export function correlationReport(
	target: Signal,
	candidates: Signal[],
	opts: CorrelateOptions = {},
): CorrelationReport {
	const correlations = correlate(target, candidates, opts);
	const examined = candidates.filter((c) => c.id !== target.id).length;

	// Bonferroni in spirit: the bar rises with the log of the search width, but
	// only once the search is genuinely wide. A handful of candidates is a
	// hypothesis being checked; a hundred is a fishing expedition, and only the
	// second one needs a higher bar. The knee is at FREE_CANDIDATES so a normal
	// correlation is not penalized for the tool being thorough.
	const excess = Math.max(0, Math.log10(Math.max(1, examined)) - Math.log10(FREE_CANDIDATES));
	const adjusted = Math.min(MAX_THRESHOLD, BASE_THRESHOLD * (1 + excess));

	const present = [...new Set(candidates.map((c) => c.source))].sort();
	const missing = SIGNAL_SOURCES.filter((s) => !present.includes(s));

	const caveats: string[] = [];
	if (missing.length > 0) {
		caveats.push(`no candidates from: ${missing.join(", ")}`);
	}
	if (examined > 20) {
		caveats.push(
			`${examined} candidates examined; the confidence floor was raised to ${adjusted.toFixed(2)} to account for the width of the search`,
		);
	}
	if (correlations.length > 0 && correlations.every((c) => c.join.strength === "temporal")) {
		caveats.push("every correlation is temporal only; none is evidence of a shared execution");
	}

	return {
		target: target.id,
		candidates_examined: examined,
		correlations,
		adjusted_threshold: Math.round(adjusted * 1000) / 1000,
		surviving: correlations.filter((c) => c.confidence >= adjusted),
		sources_present: present,
		sources_missing: missing,
		caveats,
	};
}

/**
 * Group signals into clusters that share a join.
 *
 * Transitive by construction: A–B and B–C put all three in one cluster even
 * when A and C share nothing directly. That is the conservative reading — a
 * cluster is a set of things that *might* be one incident, and splitting them
 * would assert an independence nobody established.
 */
export function clusterSignals(signals: Signal[], opts: CorrelateOptions = {}): Signal[][] {
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = id;
		while (parent.get(root) !== undefined && parent.get(root) !== root) {
			root = parent.get(root)!;
		}
		return root;
	};
	for (const s of signals) parent.set(s.id, s.id);

	for (let i = 0; i < signals.length; i++) {
		for (let j = i + 1; j < signals.length; j++) {
			if (joinSignals(signals[i], signals[j], opts)) {
				const a = find(signals[i].id);
				const b = find(signals[j].id);
				if (a !== b) parent.set(a, b);
			}
		}
	}

	const groups = new Map<string, Signal[]>();
	for (const s of signals) {
		const root = find(s.id);
		(groups.get(root) ?? groups.set(root, []).get(root)!).push(s);
	}
	return [...groups.values()]
		.map((group) => [...group].sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id)))
		.sort((a, b) => a[0].ts_ms - b[0].ts_ms || a[0].id.localeCompare(b[0].id));
}
