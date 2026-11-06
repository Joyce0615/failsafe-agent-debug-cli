/**
 * Detect and explain distributed telemetry gaps (item 32).
 *
 * Four kinds of absence look identical from a distance — a child span that
 * never arrived, a trace a collector decided not to keep, a context that
 * crossed a hop and came back unparseable, a provider's attribute name this
 * project does not yet speak — and conflating any two of them sends someone
 * to fix the wrong thing. This module composes the four detectors that
 * already understand one slice each, UNMODIFIED, and adds exactly the thing
 * none of them individually provide: a shared verdict on whether a gap is
 * explained (a known, named cause accounts for it) or unexplained (the
 * absence is real, but why is not known).
 *
 * - `trace/integrity.ts` (item 67) already finds missing/skewed/reordered
 *   spans via `checkIntegrity`, called here unmodified. Its `orphan_parent`
 *   and `sequence_gap` findings are the "missing spans" family; its
 *   `clock_skew`/`containment_violation` findings are the "clock
 *   uncertainty" family.
 * - `telemetry/propagation.ts` (item 56) already names *why* a trace
 *   restarted instead of continuing (`continueTrace`'s `reason`), called
 *   here unmodified. A restart is "broken context", always explained: the
 *   reason string IS the explanation.
 * - `telemetry/retention.ts` (item 65) already records, per trace, the
 *   `sampling_rate` it was subject to and whether it was kept. A trace
 *   dropped by a KNOWN sub-1.0 sampling rate is a deliberate, accounted-for
 *   absence, not a defect — conflating "we chose not to keep this" with "this
 *   went missing" is exactly the "evidence of absence" vs "absence of
 *   evidence" confusion this item exists to prevent.
 * - `trace/genai-normalize.ts` (item 57) already names *why* a span's
 *   provider-specific attributes did not resolve (`unknown_reason`), called
 *   here (via `normalizeGenAiTrace`'s report) unmodified. Each named reason
 *   is "provider translation" loss with a known cause.
 *
 * The one genuinely missing idea: a clock-uncertainty or containment finding
 * that `checkIntegrity` could not narrow to a single explanation is NOT the
 * same fact as a structurally confirmed missing span. The former is
 * "unknown evidence" (we do not have enough signal to say what happened);
 * the latter is the closest this project gets to "evidence of absence" (a
 * parent reference or sequence number positively implies something that is
 * not there) — and even that is reported with a caveat, never as proof,
 * because `checkIntegrity` itself already hedges orphan_parent as
 * "the parent was dropped, or has simply not arrived yet".
 *
 * Pure: no fs/network. Callers (CLI/MCP) supply already-computed
 * `IntegrityReport`/`ContinueResult`/`RetentionDecision`/`NormalizationReport`
 * inputs — this module never re-implements any of their detection logic.
 */
import type { ContinueResult } from "../telemetry/propagation.js";
import type { RetentionDecision } from "../telemetry/retention.js";
import type { NormalizationReport } from "./genai-normalize.js";
import {
	type ContainmentExplanation,
	type IntegrityReport,
	type IntegritySpan,
	checkIntegrity,
} from "./integrity.js";

export const GAP_CATEGORIES = [
	"missing_span",
	"broken_context",
	"clock_uncertainty",
	"sampling_loss",
	"provider_translation",
] as const;
export type GapCategory = (typeof GAP_CATEGORIES)[number];

/**
 * `confirmed_absence`: structural evidence (a parent reference, a sequence
 * number, a deliberate sampling decision) positively accounts for the gap.
 * `unknown_evidence`: there is not enough signal to say whether something is
 * missing or simply never captured — never promoted to `confirmed_absence`
 * no matter how suspicious the shape looks.
 */
export const EVIDENCE_STATUSES = ["confirmed_absence", "unknown_evidence"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export type GapFinding = {
	category: GapCategory;
	detail: string;
	/** Named cause when known; absent when genuinely unexplained. */
	cause?: string;
	evidence: EvidenceStatus;
	/** Carried through from `checkIntegrity` when this finding came from it. */
	explanations?: ContainmentExplanation[];
};

export type TelemetryGapReport = {
	spans_examined: number;
	findings: GapFinding[];
	by_category: Partial<Record<GapCategory, number>>;
	confirmed_absence_count: number;
	unknown_evidence_count: number;
	/** Present only when at least one finding could not be explained. */
	caveat?: string;
};

export type TelemetryGapInputs = {
	spans?: IntegritySpan[];
	propagation_restarts?: ContinueResult[];
	retention?: RetentionDecision[];
	genai?: NormalizationReport;
};

function fromIntegrity(report: IntegrityReport): GapFinding[] {
	const findings: GapFinding[] = [];
	for (const finding of report.findings) {
		if (finding.code === "orphan_parent" || finding.code === "sequence_gap") {
			findings.push({
				category: "missing_span",
				detail: finding.detail,
				evidence: "unknown_evidence",
				explanations: finding.explanations,
			});
			continue;
		}
		if (finding.code === "clock_skew") {
			findings.push({
				category: "clock_uncertainty",
				detail: finding.detail,
				cause: "systematic clock skew",
				evidence: "confirmed_absence",
				explanations: finding.explanations,
			});
			continue;
		}
		if (finding.code === "containment_violation") {
			findings.push({
				category: "clock_uncertainty",
				detail: finding.detail,
				evidence: "unknown_evidence",
				explanations: finding.explanations,
			});
		}
	}
	return findings;
}

function fromPropagation(restarts: ContinueResult[]): GapFinding[] {
	return restarts
		.filter((r) => r.action === "restarted")
		.map((r) => ({
			category: "broken_context" as const,
			detail: `trace context could not be continued: ${r.reason}`,
			cause: r.reason,
			evidence: "confirmed_absence" as const,
		}));
}

function fromRetention(decisions: RetentionDecision[]): GapFinding[] {
	return decisions
		.filter((d) => !d.keep)
		.map((d) => ({
			category: "sampling_loss" as const,
			detail: `trace '${d.trace_id}' was not retained (sampling_rate=${d.sampling_rate})`,
			cause: d.sampling_rate < 1 ? `deliberate sampling at rate ${d.sampling_rate}` : undefined,
			evidence: "confirmed_absence" as const,
		}));
}

function fromGenai(report: NormalizationReport): GapFinding[] {
	return report.unknown_reasons.map((r) => ({
		category: "provider_translation" as const,
		detail: `${r.spans} span(s) could not be resolved to a known gen_ai kind: ${r.reason}`,
		cause: r.reason,
		evidence: "confirmed_absence" as const,
	}));
}

/**
 * Detect and explain telemetry gaps across every family this project has a
 * detector for, distinguishing a confirmed, named absence from a gap no
 * evidence yet explains.
 */
export function detectTelemetryGaps(inputs: TelemetryGapInputs): TelemetryGapReport {
	const findings: GapFinding[] = [];
	let spansExamined = 0;

	if (inputs.spans) {
		spansExamined = inputs.spans.length;
		findings.push(...fromIntegrity(checkIntegrity(inputs.spans)));
	}
	if (inputs.propagation_restarts) findings.push(...fromPropagation(inputs.propagation_restarts));
	if (inputs.retention) findings.push(...fromRetention(inputs.retention));
	if (inputs.genai) findings.push(...fromGenai(inputs.genai));

	const byCategory: Partial<Record<GapCategory, number>> = {};
	for (const f of findings) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;

	const confirmed = findings.filter((f) => f.evidence === "confirmed_absence").length;
	const unknown = findings.filter((f) => f.evidence === "unknown_evidence").length;

	return {
		spans_examined: spansExamined,
		findings,
		by_category: byCategory,
		confirmed_absence_count: confirmed,
		unknown_evidence_count: unknown,
		...(unknown > 0
			? {
					caveat: `${unknown} finding(s) are unknown evidence, not confirmed absence: there is not enough signal to say whether telemetry is genuinely missing or simply never captured`,
				}
			: {}),
	};
}
