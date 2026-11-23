/**
 * Evidence-sufficiency challenge sets (item 60, module-header
 * numbering: item 125, confirmed next-free via `grep -rohE "item
 * [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u | tail`, highest
 * prior being item 124 from item 59's `migration-forensics.ts`).
 *
 * Every diagnosis module this cycle added (`mrtr.ts` item 51,
 * `mcp-subscription.ts` item 52, `shared-state-race.ts` item 53,
 * `oauth-misbinding.ts` item 54, `trusted-state-contamination.ts` item
 * 55, `latent-fault-paired-control.ts` item 56,
 * `workflow-executor-attribution.ts` item 57, `retry-amplification.ts`
 * item 58, `migration-forensics.ts` item 59, plus pre-existing modules
 * going back to item 7) individually tests its OWN abstention logic
 * with its OWN hand-picked thin-evidence fixtures. `fuzz.ts` (item 87)
 * tests a different axis entirely — structural garbage a parser must
 * not crash on, not evidence THINNING a diagnoser must respond to by
 * abstaining more, never less. `failure-corpus.ts` (item 98) is the
 * closest relative: a shared, versioned, provenance-signed corpus with
 * a shared evaluator — but it tests that each detector reaches the
 * RIGHT verdict on a FIXED fixture, never that a detector's own
 * confidence degrades gracefully as the SAME fixture is progressively
 * stripped of evidence. `grep -rln "evidence.sufficiency|challenge.set
 * |deleting.spans|skew.*clock|corrupt.*label|truncat.*handoff" src
 * --include="*.ts" -i` before this module matched only incidental
 * mentions (`agent-attribution.ts`'s own "evidence sufficiency" scoring
 * axis, `telemetry-gaps.ts`'s/`timeline.ts`'s/`integrity.ts`'s own
 * clock-skew vocabulary, `partial-order.ts`'s/`async-lifecycle-race.
 * ts`'s skew-corrected-clocks reuse) — nothing that MUTATES a fixture
 * five specific ways and checks a REGRESSION PROPERTY across whatever
 * diagnoser is handed to it.
 *
 * This module is that property harness, reusable against ANY future
 * diagnoser (not just the ones shipped here), built on a deliberately
 * minimal, generic `EvidenceBundle` shape that is sufficient to express
 * all five degradations this item names by name:
 *
 * - `deleteSpans` — removes a fraction of `spans` (span_id/ts_ms/
 *   optional parent), the FIRST ones by array order, not a random
 *   subset, so a reported challenge reproduces exactly (the same
 *   determinism discipline `chaos.ts`/`fuzz.ts` already follow).
 * - `skewClocks` — adds a fixed, large `deltaMs` to every span's
 *   `ts_ms`, mirroring `timeline.ts`'s/`trace/integrity.ts`'s own
 *   notion of a systematic clock offset, without touching anything
 *   else about the bundle.
 * - `removeReferences` — removes a fraction of `references` (opaque
 *   ids a diagnoser would otherwise cross-check evidence against).
 * - `corruptLabels` — replaces a fraction of `labels`' VALUES with
 *   `CORRUPTED_LABEL_SENTINEL`, never deleting the key (a corrupted
 *   label that is still present and wrong is a different failure mode
 *   than a missing one, and this module keeps them distinguishable
 *   the same way `trace/integrity.ts`'s own "duplicate with identical
 *   content vs. differing content" distinction stays separate).
 * - `truncateHandoffs` — keeps only the FIRST `ceil((1-fraction)*n)`
 *   handoffs by `sequence` order, discarding the tail — a premature
 *   cutoff, not a hole in the middle, matching how a real handoff
 *   chain actually truncates (it stops, it does not skip).
 *
 * `buildChallengeSet` applies exactly ONE of the five mutations to the
 * ORIGINAL bundle per case — never stacked — so a reported regression
 * is attributable to a single named degradation, mirroring this
 * project's general "report each distinct fact once" discipline.
 *
 * The property this item asks to verify is stricter than "confidence
 * never increases": the exact wording is "lowers confidence OR
 * abstains", which this module reads literally as a two-way
 * disjunction, not a non-strict inequality. `challengePasses` therefore
 * requires one of: the post-degradation confidence rank is STRICTLY
 * below the baseline's, or the post-degradation confidence is
 * `abstained` outright (the floor, which trivially satisfies "or
 * abstains" even when the baseline itself was already `abstained` and
 * cannot go any lower). A diagnoser that reports the SAME non-abstained
 * confidence after evidence was deleted is a violation under this
 * reading, even though its rank did not technically increase — because
 * "unchanged and confident" on strictly less evidence is exactly the
 * complacency this item exists to catch, not a borderline pass.
 *
 * `assessEvidenceSufficiency` is a reference diagnoser built honestly
 * from simple evidence-density thresholds (never tuned against the
 * challenge set after the fact) so the harness has a real, non-trivial
 * subject to run against, mirroring `comm-fault-injection.ts`'s own
 * `processMessage`/`injectCommFault` split between a real detector and
 * the fault injector that tests it. Tests also run a DELIBERATELY
 * broken diagnoser (one that always reports `full`) through the same
 * harness and assert it is CAUGHT with violations on every one of the
 * five challenges — proof the harness itself detects the failure mode
 * it exists to detect, not merely that a well-behaved diagnoser passes.
 *
 * Pure: no fs/network/process/clock/random. Every mutation is a plain
 * array transform; `DEFAULT_EVIDENCE_BUNDLE` is a literal fixture.
 */

export type EvidenceSpan = {
	span_id: string;
	ts_ms: number;
	parent_span_id?: string;
};

export type EvidenceHandoff = {
	handoff_id: string;
	sequence: number;
	payload: string;
};

export type EvidenceBundle = {
	spans: EvidenceSpan[];
	/** Opaque ids a diagnoser would otherwise cross-check other evidence against. */
	references: string[];
	/** Ordered by `sequence`; a real handoff chain truncates at the tail, not the middle. */
	handoffs: EvidenceHandoff[];
	labels: Record<string, string>;
};

export const DEFAULT_DEGRADATION_FRACTION = 0.5;
export const DEFAULT_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1000; // one week: unmistakably systematic, never an ordinary jitter.
export const CORRUPTED_LABEL_SENTINEL = "<corrupted>";

/** Remove the first `fraction` of `spans`, by array order (deterministic, not random). */
export function deleteSpans(
	bundle: EvidenceBundle,
	fraction: number = DEFAULT_DEGRADATION_FRACTION,
): EvidenceBundle {
	const cut = Math.ceil(bundle.spans.length * fraction);
	return { ...bundle, spans: bundle.spans.slice(cut) };
}

/** Add a fixed, systematic offset to every span's `ts_ms`. */
export function skewClocks(
	bundle: EvidenceBundle,
	deltaMs: number = DEFAULT_CLOCK_SKEW_MS,
): EvidenceBundle {
	return { ...bundle, spans: bundle.spans.map((s) => ({ ...s, ts_ms: s.ts_ms + deltaMs })) };
}

/** Remove the first `fraction` of `references`, by array order. */
export function removeReferences(
	bundle: EvidenceBundle,
	fraction: number = DEFAULT_DEGRADATION_FRACTION,
): EvidenceBundle {
	const cut = Math.ceil(bundle.references.length * fraction);
	return { ...bundle, references: bundle.references.slice(cut) };
}

/** Replace the first `fraction` of label VALUES (by sorted key order) with the corruption sentinel, never deleting the key. */
export function corruptLabels(
	bundle: EvidenceBundle,
	fraction: number = DEFAULT_DEGRADATION_FRACTION,
): EvidenceBundle {
	const keys = Object.keys(bundle.labels).sort();
	const cut = Math.ceil(keys.length * fraction);
	const corrupted = new Set(keys.slice(0, cut));
	const labels: Record<string, string> = {};
	for (const [key, value] of Object.entries(bundle.labels)) {
		labels[key] = corrupted.has(key) ? CORRUPTED_LABEL_SENTINEL : value;
	}
	return { ...bundle, labels };
}

/** Keep only the first `ceil((1-fraction) * n)` handoffs by `sequence` order, discarding the tail. */
export function truncateHandoffs(
	bundle: EvidenceBundle,
	fraction: number = DEFAULT_DEGRADATION_FRACTION,
): EvidenceBundle {
	const sorted = [...bundle.handoffs].sort((a, b) => a.sequence - b.sequence);
	const keep = Math.max(0, Math.floor(sorted.length * (1 - fraction)));
	return { ...bundle, handoffs: sorted.slice(0, keep) };
}

export const CHALLENGE_SET_KINDS = [
	"delete_spans",
	"skew_clocks",
	"remove_references",
	"corrupt_labels",
	"truncate_handoffs",
] as const;
export type ChallengeSetKind = (typeof CHALLENGE_SET_KINDS)[number];

export type ChallengeCase = {
	kind: ChallengeSetKind;
	description: string;
	bundle: EvidenceBundle;
};

/** Apply exactly ONE of the five standard mutations to `bundle` per case -- never stacked. */
export function buildChallengeSet(bundle: EvidenceBundle): ChallengeCase[] {
	return [
		{
			kind: "delete_spans",
			description: `${Math.ceil(bundle.spans.length * DEFAULT_DEGRADATION_FRACTION)} of ${bundle.spans.length} span(s) deleted`,
			bundle: deleteSpans(bundle),
		},
		{
			kind: "skew_clocks",
			description: `every span's ts_ms shifted by ${DEFAULT_CLOCK_SKEW_MS}ms`,
			bundle: skewClocks(bundle),
		},
		{
			kind: "remove_references",
			description: `${Math.ceil(bundle.references.length * DEFAULT_DEGRADATION_FRACTION)} of ${bundle.references.length} reference(s) removed`,
			bundle: removeReferences(bundle),
		},
		{
			kind: "corrupt_labels",
			description: `${Math.ceil(Object.keys(bundle.labels).length * DEFAULT_DEGRADATION_FRACTION)} of ${Object.keys(bundle.labels).length} label(s) corrupted`,
			bundle: corruptLabels(bundle),
		},
		{
			kind: "truncate_handoffs",
			description: `handoff chain truncated to ${Math.max(0, Math.floor(bundle.handoffs.length * (1 - DEFAULT_DEGRADATION_FRACTION)))} of ${bundle.handoffs.length} handoff(s)`,
			bundle: truncateHandoffs(bundle),
		},
	];
}

/** The canonical published fixture: enough spans/references/handoffs/clean labels for a reasonable diagnoser to report `full`. */
export const DEFAULT_EVIDENCE_BUNDLE: EvidenceBundle = {
	spans: [
		{ span_id: "s1", ts_ms: 0 },
		{ span_id: "s2", ts_ms: 10, parent_span_id: "s1" },
		{ span_id: "s3", ts_ms: 20, parent_span_id: "s2" },
		{ span_id: "s4", ts_ms: 30, parent_span_id: "s3" },
	],
	references: ["ref-a", "ref-b", "ref-c", "ref-d"],
	handoffs: [
		{ handoff_id: "h1", sequence: 0, payload: "plan" },
		{ handoff_id: "h2", sequence: 1, payload: "execute" },
		{ handoff_id: "h3", sequence: 2, payload: "verify" },
		{ handoff_id: "h4", sequence: 3, payload: "report" },
	],
	labels: { owner: "agent-a", status: "ok", stage: "verify" },
};

export const CONFIDENCE_LEVELS = ["abstained", "reduced", "full"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
	abstained: 0,
	reduced: 1,
	full: 2,
};

export type Diagnoser = (bundle: EvidenceBundle) => ConfidenceLevel;

/**
 * "Lowers confidence OR abstains": pass iff the post-degradation
 * confidence rank is STRICTLY below the baseline's, or the
 * post-degradation confidence is `abstained` outright (the floor,
 * satisfying "or abstains" even when the baseline was already
 * `abstained` and literally cannot rank any lower). A diagnoser that
 * reports the SAME non-abstained confidence after evidence was removed
 * does not pass -- "unchanged and confident on strictly less evidence"
 * is the complacency this item exists to catch.
 */
export function challengePasses(baseline: ConfidenceLevel, challenge: ConfidenceLevel): boolean {
	if (challenge === "abstained") return true;
	return CONFIDENCE_RANK[challenge] < CONFIDENCE_RANK[baseline];
}

export type ChallengeViolation = {
	kind: ChallengeSetKind;
	description: string;
	baseline_confidence: ConfidenceLevel;
	challenge_confidence: ConfidenceLevel;
	detail: string;
};

export type ChallengeReport = {
	baseline_confidence: ConfidenceLevel;
	violations: ChallengeViolation[];
	passed: boolean;
};

/**
 * Run `diagnoser` against `bundle` and against every one of the five
 * standard challenge cases built from it, reporting any case where the
 * diagnoser did not lower its confidence or abstain.
 */
export function runEvidenceSufficiencyChallenge(
	diagnoser: Diagnoser,
	bundle: EvidenceBundle = DEFAULT_EVIDENCE_BUNDLE,
): ChallengeReport {
	const baseline = diagnoser(bundle);
	const cases = buildChallengeSet(bundle);

	const violations: ChallengeViolation[] = [];
	for (const challengeCase of cases) {
		const challengeConfidence = diagnoser(challengeCase.bundle);
		if (!challengePasses(baseline, challengeConfidence)) {
			violations.push({
				kind: challengeCase.kind,
				description: challengeCase.description,
				baseline_confidence: baseline,
				challenge_confidence: challengeConfidence,
				detail: `after '${challengeCase.kind}' (${challengeCase.description}), confidence was '${challengeConfidence}' but the baseline was already '${baseline}': the diagnoser neither lowered confidence nor abstained on strictly less evidence`,
			});
		}
	}

	return { baseline_confidence: baseline, violations, passed: violations.length === 0 };
}

const MIN_SPANS_FOR_FULL = 3;
const MIN_REFERENCES_FOR_FULL = 3;
const MIN_HANDOFFS_FOR_FULL = 3;
/**
 * A systematic clock shift adds the SAME delta to every span, so it
 * never changes the INTERNAL spread between spans -- detecting it
 * from spread alone is structurally impossible. Instead, any evidence
 * bundle's own spans are expected to start near the bundle's own
 * relative-ms-from-zero frame; a span timestamp beyond this bound has
 * been displaced from that frame by something, which is exactly what
 * a systematic skew does.
 */
const PLAUSIBLE_MAX_SPAN_TS_MS = 60_000;

/**
 * Reference diagnoser, built from simple evidence-density thresholds
 * decided BEFORE this module's own challenge set was built against it
 * (never tuned after the fact): `abstained` when any evidence category
 * is entirely empty; `full` when every category clears its minimum,
 * no label carries the corruption sentinel, and no span timestamp is
 * implausibly displaced from the bundle's expected near-zero frame;
 * `reduced` otherwise.
 */
export function assessEvidenceSufficiency(bundle: EvidenceBundle): ConfidenceLevel {
	if (bundle.spans.length === 0 || bundle.references.length === 0 || bundle.handoffs.length === 0) {
		return "abstained";
	}

	const hasCorruptedLabel = Object.values(bundle.labels).some(
		(v) => v === CORRUPTED_LABEL_SENTINEL,
	);
	const suspectedSkew = bundle.spans.some((s) => s.ts_ms > PLAUSIBLE_MAX_SPAN_TS_MS);

	const clearsMinimums =
		bundle.spans.length >= MIN_SPANS_FOR_FULL &&
		bundle.references.length >= MIN_REFERENCES_FOR_FULL &&
		bundle.handoffs.length >= MIN_HANDOFFS_FOR_FULL;

	if (clearsMinimums && !hasCorruptedLabel && !suspectedSkew) {
		return "full";
	}
	return "reduced";
}

/** Render a human-readable challenge report. */
export function renderChallengeReport(report: ChallengeReport): string {
	const lines: string[] = [
		"# Evidence-Sufficiency Challenge Report",
		`baseline_confidence: ${report.baseline_confidence}`,
		`passed: ${report.passed}`,
	];
	if (report.violations.length > 0) {
		lines.push("", "## Violations");
		for (const v of report.violations) {
			lines.push(`- [${v.kind}] ${v.detail}`);
		}
	}
	return lines.join("\n");
}
