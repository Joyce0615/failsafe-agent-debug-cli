/**
 * Detection of missing, duplicated, reordered, and clock-skewed spans and logs
 * (item 67).
 *
 * The four defects in this item's title are not independent phenomena that
 * happen to appear in one list. They are four *explanations* for largely the
 * same observation, and telling them apart is the entire problem. A child span
 * that starts before its parent might be:
 *
 * - a reordered delivery (the data is fine, the sequence is not),
 * - a skewed clock (the data is systematically wrong by a constant),
 * - a genuine asynchronous fork (nothing is wrong at all), or
 * - a missing intermediate span (the real parent was never exported).
 *
 * A detector that picks one and reports it as fact is worse than useless,
 * because a confident wrong diagnosis here sends someone to fix an NTP
 * configuration that was never broken. So every finding carries the set of
 * explanations still consistent with the evidence, and narrowing happens only
 * where the evidence actually narrows:
 *
 * - **Systematic offsets are skew; isolated ones are not.** If every span from
 *   a service violates containment by roughly the same amount, that is a clock.
 *   If one does, it is not. `estimateServiceSkew` uses the median of implied
 *   shifts and reports the spread, and a service whose violations disagree with
 *   each other is explicitly *not* diagnosed as skewed.
 *
 * - **A duplicate id with identical content and one with differing content are
 *   different defects.** The first is redelivery, which is normal and harmless.
 *   The second means an id collision or a mutating retry, and it silently
 *   corrupts every aggregate. They are separate defect codes because they need
 *   separate responses.
 *
 * Pure: no I/O.
 */

export type IntegritySpan = {
	span_id: string;
	parent_span_id?: string;
	service: string;
	name: string;
	start_ms: number;
	end_ms: number;
	/** Producer sequence number, when the exporter supplies one. */
	sequence?: number;
	status?: "ok" | "error";
};

export const DEFECT_CODES = [
	"duplicate_span",
	"conflicting_duplicate",
	"orphan_parent",
	"sequence_gap",
	"out_of_order_delivery",
	"containment_violation",
	"clock_skew",
	"zero_duration_parent",
	"negative_duration",
] as const;
export type DefectCode = (typeof DEFECT_CODES)[number];

/** Explanations a containment violation may have. Never narrowed to one by guesswork. */
export const CONTAINMENT_EXPLANATIONS = [
	"clock_skew",
	"reordered_delivery",
	"asynchronous_fork",
	"missing_intermediate_span",
] as const;
export type ContainmentExplanation = (typeof CONTAINMENT_EXPLANATIONS)[number];

export type Finding = {
	code: DefectCode;
	/** Spans the finding is about. */
	span_ids: string[];
	detail: string;
	/**
	 * Explanations still consistent with the evidence. A single entry means the
	 * evidence genuinely narrowed; several mean it did not, and the finding
	 * should not be read as a diagnosis.
	 */
	explanations: ContainmentExplanation[];
	severity: "high" | "medium" | "low";
};

export type SkewEstimate = {
	service: string;
	/** Median implied offset, in ms. Positive means the service's clock is ahead. */
	offset_ms: number;
	/** Half the interquartile range of implied offsets: how consistent they are. */
	spread_ms: number;
	observations: number;
	/**
	 * True only when the offsets agree with each other. A service whose
	 * violations disagree has a delivery problem, not a clock problem, and
	 * saying otherwise sends someone to fix NTP for nothing.
	 */
	systematic: boolean;
};

/** Observations below this cannot establish that anything is systematic. */
export const MIN_SKEW_OBSERVATIONS = 3;
/** Spread above this fraction of the offset means the offsets disagree. */
export const SKEW_CONSISTENCY_RATIO = 0.25;
/** Violations at or below this are measurement noise, not evidence. */
export const CONTAINMENT_TOLERANCE_MS = 2;

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function iqrHalf(values: number[]): number {
	if (values.length < 4)
		return values.length === 0 ? 0 : (Math.max(...values) - Math.min(...values)) / 2;
	const sorted = [...values].sort((a, b) => a - b);
	const q1 = sorted[Math.floor(sorted.length * 0.25)];
	const q3 = sorted[Math.floor(sorted.length * 0.75)];
	return (q3 - q1) / 2;
}

/**
 * Implied clock offset for one containment violation.
 *
 * A child that starts `d` ms before its parent implies the child's clock is
 * `d` ms behind — *if* the cause is skew. This function computes the number;
 * `estimateServiceSkew` decides whether it means anything.
 */
export function impliedOffset(parent: IntegritySpan, child: IntegritySpan): number {
	if (child.start_ms < parent.start_ms) return child.start_ms - parent.start_ms;
	if (child.end_ms > parent.end_ms) return child.end_ms - parent.end_ms;
	return 0;
}

/**
 * Estimate per-service clock offsets from parent/child containment violations.
 *
 * Uses the median so one badly matched pair cannot drag the estimate, and
 * reports the spread so a caller can see whether the observations agree. A
 * service is called `systematic` only with enough observations *and* a spread
 * small relative to the offset; anything else is left undiagnosed.
 */
export function estimateServiceSkew(spans: IntegritySpan[]): SkewEstimate[] {
	const byId = new Map(spans.map((s) => [s.span_id, s]));
	const offsets = new Map<string, number[]>();

	for (const child of spans) {
		if (!child.parent_span_id) continue;
		const parent = byId.get(child.parent_span_id);
		if (!parent) continue;
		// Only cross-service edges say anything about a clock; a violation within
		// one service is a data problem, not a synchronization problem.
		if (parent.service === child.service) continue;
		const offset = impliedOffset(parent, child);
		if (Math.abs(offset) <= CONTAINMENT_TOLERANCE_MS) continue;
		const list = offsets.get(child.service);
		if (list) list.push(offset);
		else offsets.set(child.service, [offset]);
	}

	return [...offsets.entries()]
		.map(([service, values]) => {
			const offset = median(values);
			const spread = iqrHalf(values);
			return {
				service,
				offset_ms: offset,
				spread_ms: spread,
				observations: values.length,
				systematic:
					values.length >= MIN_SKEW_OBSERVATIONS &&
					Math.abs(offset) > 0 &&
					spread <= Math.abs(offset) * SKEW_CONSISTENCY_RATIO,
			};
		})
		.sort((a, b) => a.service.localeCompare(b.service));
}

export type IntegrityReport = {
	spans_examined: number;
	findings: Finding[];
	skew: SkewEstimate[];
	counts: Partial<Record<DefectCode, number>>;
	/** Explanations that remain open across the report, so ambiguity is visible. */
	unresolved_explanations: ContainmentExplanation[];
};

function sameContent(a: IntegritySpan, b: IntegritySpan): boolean {
	return (
		a.parent_span_id === b.parent_span_id &&
		a.service === b.service &&
		a.name === b.name &&
		a.start_ms === b.start_ms &&
		a.end_ms === b.end_ms &&
		a.status === b.status
	);
}

/**
 * Check a span set for all four defect families.
 *
 * Order of work matters once: skew is estimated *before* containment violations
 * are classified, so a violation on a service with an established systematic
 * offset can be narrowed to `clock_skew` while an isolated one keeps all four
 * explanations open.
 */
export function checkIntegrity(spans: IntegritySpan[]): IntegrityReport {
	const findings: Finding[] = [];
	const skew = estimateServiceSkew(spans);
	const skewed = new Map(skew.filter((s) => s.systematic).map((s) => [s.service, s]));

	// --- duplicates: identical redelivery versus conflicting content ---
	const byId = new Map<string, IntegritySpan[]>();
	for (const span of spans) {
		const list = byId.get(span.span_id);
		if (list) list.push(span);
		else byId.set(span.span_id, [span]);
	}
	for (const [id, group] of byId) {
		if (group.length < 2) continue;
		const identical = group.every((s) => sameContent(s, group[0]));
		findings.push(
			identical
				? {
						code: "duplicate_span",
						span_ids: [id],
						detail: `span '${id}' delivered ${group.length} times with identical content`,
						explanations: [],
						severity: "low",
					}
				: {
						code: "conflicting_duplicate",
						span_ids: [id],
						detail: `span '${id}' delivered ${group.length} times with differing content: an id collision or a mutating retry, either of which corrupts every aggregate over this trace`,
						explanations: [],
						severity: "high",
					},
		);
	}

	const unique = new Map<string, IntegritySpan>();
	for (const span of spans) if (!unique.has(span.span_id)) unique.set(span.span_id, span);

	// --- structural defects ---
	for (const span of unique.values()) {
		if (span.end_ms < span.start_ms) {
			findings.push({
				code: "negative_duration",
				span_ids: [span.span_id],
				detail: `span '${span.span_id}' ends ${span.start_ms - span.end_ms}ms before it starts`,
				explanations: [],
				severity: "high",
			});
		}
		if (span.parent_span_id && !unique.has(span.parent_span_id)) {
			findings.push({
				code: "orphan_parent",
				span_ids: [span.span_id],
				detail: `span '${span.span_id}' references parent '${span.parent_span_id}', which is absent from this set`,
				// An orphan is ambiguous in exactly one way: the parent was
				// dropped, or it simply has not arrived yet.
				explanations: ["missing_intermediate_span"],
				severity: "medium",
			});
		}
	}

	// --- containment ---
	for (const child of unique.values()) {
		if (!child.parent_span_id) continue;
		const parent = unique.get(child.parent_span_id);
		if (!parent) continue;

		const startsEarly = parent.start_ms - child.start_ms;
		const endsLate = child.end_ms - parent.end_ms;
		if (startsEarly <= CONTAINMENT_TOLERANCE_MS && endsLate <= CONTAINMENT_TOLERANCE_MS) continue;

		const crossService = parent.service !== child.service;
		const systematic = crossService ? skewed.get(child.service) : undefined;

		// Narrow only where the evidence narrows. A systematic per-service
		// offset is a clock. Anything else keeps its alternatives.
		const explanations: ContainmentExplanation[] = systematic
			? ["clock_skew"]
			: crossService
				? [...CONTAINMENT_EXPLANATIONS]
				: ["reordered_delivery", "asynchronous_fork", "missing_intermediate_span"];

		findings.push({
			code: systematic ? "clock_skew" : "containment_violation",
			span_ids: [parent.span_id, child.span_id],
			detail: systematic
				? `child '${child.span_id}' falls outside parent '${parent.span_id}' by ${Math.max(startsEarly, endsLate)}ms, consistent with a systematic ${systematic.offset_ms}ms offset on service '${child.service}'`
				: `child '${child.span_id}' falls outside parent '${parent.span_id}' by ${Math.max(startsEarly, endsLate)}ms; the evidence does not distinguish between ${explanations.join(", ")}`,
			explanations,
			severity: systematic ? "medium" : "high",
		});
	}

	// --- delivery order ---
	const sequenced = [...unique.values()]
		.filter((s) => s.sequence !== undefined)
		.sort((a, b) => a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id));
	for (let i = 1; i < sequenced.length; i++) {
		if (sequenced[i].sequence! < sequenced[i - 1].sequence!) {
			findings.push({
				code: "out_of_order_delivery",
				span_ids: [sequenced[i - 1].span_id, sequenced[i].span_id],
				detail: `sequence ${sequenced[i].sequence} arrived after ${sequenced[i - 1].sequence} despite an earlier start time`,
				explanations: ["reordered_delivery"],
				severity: "low",
			});
		}
	}

	const numbers = sequenced.map((s) => s.sequence!).sort((a, b) => a - b);
	for (let i = 1; i < numbers.length; i++) {
		const gap = numbers[i] - numbers[i - 1];
		if (gap > 1) {
			findings.push({
				code: "sequence_gap",
				span_ids: [],
				detail: `${gap - 1} span(s) missing between sequence ${numbers[i - 1]} and ${numbers[i]}`,
				explanations: ["missing_intermediate_span"],
				severity: "medium",
			});
		}
	}

	// --- a parent with no duration cannot contain anything ---
	for (const parent of unique.values()) {
		if (parent.end_ms !== parent.start_ms) continue;
		const hasChildren = [...unique.values()].some((s) => s.parent_span_id === parent.span_id);
		if (hasChildren) {
			findings.push({
				code: "zero_duration_parent",
				span_ids: [parent.span_id],
				detail: `span '${parent.span_id}' has zero duration but has children, so containment cannot be checked against it`,
				explanations: [],
				severity: "low",
			});
		}
	}

	const counts: Partial<Record<DefectCode, number>> = {};
	for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;

	const open = new Set<ContainmentExplanation>();
	for (const finding of findings) {
		if (finding.explanations.length > 1) {
			for (const explanation of finding.explanations) open.add(explanation);
		}
	}

	return {
		spans_examined: spans.length,
		findings: findings.sort(
			(a, b) =>
				severityRank(b.severity) - severityRank(a.severity) ||
				a.code.localeCompare(b.code) ||
				(a.span_ids[0] ?? "").localeCompare(b.span_ids[0] ?? ""),
		),
		skew,
		counts,
		unresolved_explanations: [...open].sort(),
	};
}

function severityRank(severity: Finding["severity"]): number {
	return severity === "high" ? 2 : severity === "medium" ? 1 : 0;
}

export type LogLine = { service: string; ts_ms: number; message: string; sequence?: number };

/**
 * Check a log stream for the same families.
 *
 * Logs have no containment structure, so only three of the four apply. A
 * backwards timestamp within one service is the interesting case: with a
 * sequence number available it is provably reordering *or* skew, and without
 * one it is simply undecidable — which the finding says rather than guessing.
 */
export function checkLogIntegrity(lines: LogLine[]): Finding[] {
	const findings: Finding[] = [];
	const byService = new Map<string, LogLine[]>();
	for (const line of lines) {
		const list = byService.get(line.service);
		if (list) list.push(line);
		else byService.set(line.service, [line]);
	}

	for (const [service, group] of [...byService.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		for (let i = 1; i < group.length; i++) {
			if (group[i].ts_ms >= group[i - 1].ts_ms) continue;
			const hasSequence = group[i].sequence !== undefined && group[i - 1].sequence !== undefined;
			const reordered = hasSequence && group[i].sequence! < group[i - 1].sequence!;
			findings.push({
				code: reordered ? "out_of_order_delivery" : "containment_violation",
				span_ids: [],
				detail: reordered
					? `'${service}' log line at ${group[i].ts_ms} arrived after ${group[i - 1].ts_ms} and its sequence is also lower: the stream was reordered`
					: hasSequence
						? `'${service}' timestamp went backwards while the sequence advanced: the clock moved, not the stream`
						: `'${service}' timestamp went backwards with no sequence number to disambiguate reordering from a clock step`,
				explanations: reordered
					? ["reordered_delivery"]
					: hasSequence
						? ["clock_skew"]
						: ["clock_skew", "reordered_delivery"],
				severity: "medium",
			});
		}

		const duplicates = new Map<string, number>();
		for (const line of group) {
			const key = `${line.ts_ms}|${line.message}`;
			duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
		}
		for (const [key, count] of duplicates) {
			if (count < 2) continue;
			findings.push({
				code: "duplicate_span",
				span_ids: [],
				detail: `'${service}' emitted an identical line ${count} times at the same millisecond: ${key.split("|")[1].slice(0, 60)}`,
				explanations: [],
				severity: "low",
			});
		}
	}

	return findings;
}
