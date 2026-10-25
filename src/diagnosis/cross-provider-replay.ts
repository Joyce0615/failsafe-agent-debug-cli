import type { RemediationMode } from "../remediation/modes.js";
import type { Recommendation } from "../remediation/modes.js";
/**
 * Cross-provider diagnostic replay (item 101).
 *
 * The item asks for four things and nothing in the repo composes them: replay
 * identical evidence through pinned providers/models, measure diagnosis and
 * remediation drift, and require abstention when identity or evidence
 * fidelity is uncertain. Confirmed by grep before this module existed:
 * `trace/genai-normalize.ts`'s `FieldResolution`/`resolveField` (provider
 * identity resolution per span) and `remediation/modes.ts`'s `Recommendation`
 * (remediation ranking) are never imported together by any module, and
 * neither is imported anywhere alongside `types/diagnosis.ts`'s
 * `FailureDiagnosis`. `diagnosis/engine.ts`'s `diagnose()` produces exactly
 * one `FailureDiagnosis` per call and has no notion of "the same failure, run
 * again under a different provider" at all.
 *
 * This module does not call any provider itself — `diagnose()` is already the
 * thing that would be called per provider, and calling it is the caller's
 * job (it needs a live `StoreInterface`). What is missing, and what this
 * module supplies, is pure: given N already-produced `FailureDiagnosis`
 * results for the SAME `FailureRecord` (one per pinned provider/model), (1)
 * resolve whether provider identity was actually pinned and unambiguous for
 * each run, (2) resolve whether the evidence each run saw was faithfully
 * captured (not truncated, not structurally broken, not redacted into
 * uselessness), (3) measure how far the diagnoses (and, optionally, the
 * remediation recommendations built from them) actually diverged, and (4)
 * decide whether the result can be reported at all, or must abstain.
 *
 * Four pieces, each independently testable and each reusing an existing,
 * unmodified primitive rather than re-deriving one:
 *
 * 1. **Provider identity, not assumed.** `resolveProviderIdentity` reuses
 *    `trace/genai-normalize.ts`'s `resolveField`/`ATTRIBUTE_ALIASES`
 *    unmodified against the `model`/`provider`/`agent_version` canonical
 *    fields — the SAME alias-resolution machinery that normalizes a trace
 *    span, applied here to a provider-identity attribute bag a caller
 *    supplies per run. A run whose identity attributes resolve with a
 *    conflict (two aliases disagreeing), or do not resolve at all, is
 *    `pinned: false` and names why — "pinned" is not the caller's claim,
 *    it is this module's finding.
 * 2. **Evidence fidelity, not assumed.** `resolveEvidenceFidelity` folds in
 *    three ALREADY-EXISTING fidelity signals a caller can supply per run —
 *    `trace/diagnose.ts`'s own `TraceProvenance.truncated`,
 *    `trace/genai-normalize.ts`'s own `StructureIssue[]`, and a redacted-
 *    event count in the same shape `diagnosis/timeline.ts` already reports
 *    — into one `faithful: boolean` + named reasons. None of the three
 *    fidelity checks is reimplemented; this module only reads their
 *    already-computed outputs.
 * 3. **Drift, not blended into one score.** `diffDiagnoses` reports root-
 *    cause CATEGORY agreement, confidence spread (max − min across the N
 *    runs), and evidence-kind overlap (Jaccard over `EvidenceItem.kind`)
 *    as three separate numbers — mirroring `bench/service-diagnosis.ts`'s
 *    own refusal to combine independent axes into a composite. When
 *    `Recommendation`s are also supplied, `diffRemediation` separately
 *    reports whether the RECOMMENDED SET of modes (from
 *    `remediation/modes.ts`'s own `recommend()`, called by the caller, not
 *    this module) agreed across runs — reusing `Recommendation.recommended`
 *    unmodified rather than re-deriving a notion of "the remediation this
 *    run would take."
 * 4. **Abstention is a gate, not a suggestion.** `gateCrossProviderReplay`
 *    refuses to report a verdict (returns `abstain: true` with every
 *    triggering reason named) when ANY run's identity is unpinned, ANY
 *    run's evidence is unfaithful, or fewer than `MIN_PROVIDERS` runs are
 *    present to compare at all — mirroring `repro/counterfactual.ts`'s own
 *    `insufficient_repeats` refusal for too few arms. A caller cannot
 *    silence a reported abstention reason by supplying a majority of clean
 *    runs: ONE unpinned or unfaithful run abstains the whole comparison,
 *    because a drift measurement with one corrupted input is not a drift
 *    measurement with 2-out-of-3 good inputs, it is an unverifiable one.
 *
 * Pure: no network, no provider call, no fs, no clock read. Every input is
 * caller-supplied and already computed by an existing, unmodified module.
 */
import { ATTRIBUTE_ALIASES, type CanonicalField, resolveField } from "../trace/genai-normalize.js";
import type { EvidenceItem, FailureDiagnosis } from "../types/diagnosis.js";

/** Minimum pinned, faithful runs required before a comparison is meaningful. */
export const MIN_PROVIDERS = 2;

/** The canonical fields that establish WHICH provider/model produced a run. */
export const PROVIDER_IDENTITY_FIELDS: readonly CanonicalField[] = [
	"provider",
	"model",
	"agent_version",
];

export type ProviderIdentityResolution = {
	run_id: string;
	pinned: boolean;
	/** One resolved value per identity field that resolved cleanly. */
	identity: Partial<Record<CanonicalField, string | number>>;
	/** Why pinning failed, when it did. Empty iff `pinned`. */
	reasons: string[];
};

/**
 * Resolve a run's provider identity from a raw attribute bag.
 *
 * Reuses `resolveField` (from `trace/genai-normalize.ts`) unmodified, one
 * call per identity field — the SAME alias-resolution a trace span goes
 * through, applied here to whatever attribute bag a caller recorded
 * alongside a diagnosis run. A field that is missing, or that resolves with
 * a conflict (two aliases disagreeing on the value), fails pinning for the
 * whole run — a run's identity is not "mostly known."
 */
export function resolveProviderIdentity(
	run_id: string,
	attributes: Record<string, unknown>,
): ProviderIdentityResolution {
	const identity: Partial<Record<CanonicalField, string | number>> = {};
	const reasons: string[] = [];

	for (const field of PROVIDER_IDENTITY_FIELDS) {
		const resolved = resolveField(attributes, field);
		if (!resolved) {
			reasons.push(
				`'${field}' did not resolve from any of: ${ATTRIBUTE_ALIASES[field].join(", ")}`,
			);
			continue;
		}
		if (resolved.conflicts.length > 0) {
			reasons.push(
				`'${field}' resolved to '${resolved.value}' via '${resolved.source_key}' but conflicted with ${resolved.conflicts
					.map((c) => `'${c.key}'='${c.value}'`)
					.join(", ")}`,
			);
			continue;
		}
		identity[field] = resolved.value;
	}

	return { run_id, pinned: reasons.length === 0, identity, reasons };
}

export type EvidenceFidelityInput = {
	run_id: string;
	/** From `trace/diagnose.ts`'s `TraceProvenance.truncated`, when this run came from a trace. */
	trace_truncated?: boolean;
	/** From `trace/genai-normalize.ts`'s `validateGenAiStructure`, when this run came from a GenAI trace. */
	structure_issues?: number;
	/** From `diagnosis/timeline.ts`'s redaction accounting: events whose content was redacted. */
	redacted_events?: number;
	/** Total events/spans this run's evidence was drawn from, for a rate rather than a raw count. */
	total_events?: number;
};

export type EvidenceFidelityResolution = {
	run_id: string;
	faithful: boolean;
	reasons: string[];
	/** redacted_events / total_events, when both are known. */
	redaction_rate?: number;
};

/** Above this fraction of redacted events, evidence is not faithful even with zero structural issues. */
export const MAX_REDACTION_RATE = 0.5;

/**
 * Resolve whether a run's evidence was faithfully captured.
 *
 * Folds in three signals that already exist elsewhere in this codebase
 * (truncation, structural issues, redaction) without recomputing any of
 * them — this module only reads already-computed fields a caller supplies.
 */
export function resolveEvidenceFidelity(input: EvidenceFidelityInput): EvidenceFidelityResolution {
	const reasons: string[] = [];

	if (input.trace_truncated) {
		reasons.push("the source trace was truncated before analysis (see TraceProvenance.truncated)");
	}
	if ((input.structure_issues ?? 0) > 0) {
		reasons.push(
			`${input.structure_issues} structural issue(s) in the source spans (see validateGenAiStructure)`,
		);
	}

	let redactionRate: number | undefined;
	if (input.total_events !== undefined && input.total_events > 0) {
		redactionRate = (input.redacted_events ?? 0) / input.total_events;
		if (redactionRate > MAX_REDACTION_RATE) {
			reasons.push(
				`${Math.round(redactionRate * 100)}% of events had content redacted, above the ${Math.round(MAX_REDACTION_RATE * 100)}% ceiling`,
			);
		}
	}

	return {
		run_id: input.run_id,
		faithful: reasons.length === 0,
		reasons,
		...(redactionRate !== undefined ? { redaction_rate: redactionRate } : {}),
	};
}

export type ProviderRun = {
	run_id: string;
	diagnosis: FailureDiagnosis;
	recommendation?: Recommendation;
};

export type DiagnosisDrift = {
	/** True iff every run's root_cause.category agreed (runs with no root_cause are excluded from this check). */
	category_agreement: boolean;
	categories: Record<string, string[]>;
	/** Max confidence minus min confidence across runs that reported a root_cause. */
	confidence_spread: number;
	/** Jaccard overlap of EvidenceItem.kind sets across all runs; 1 = identical evidence-kind coverage, 0 = disjoint. */
	evidence_kind_overlap: number;
};

function evidenceKinds(evidence: EvidenceItem[]): Set<string> {
	return new Set(evidence.map((e) => e.kind));
}

function jaccard(sets: Set<string>[]): number {
	if (sets.length === 0) return 1;
	const union = new Set<string>();
	for (const s of sets) for (const v of s) union.add(v);
	if (union.size === 0) return 1;
	let intersection = new Set(sets[0]);
	for (const s of sets.slice(1)) {
		intersection = new Set([...intersection].filter((v) => s.has(v)));
	}
	return intersection.size / union.size;
}

/**
 * Compare N diagnoses of the SAME failure for drift, on three separate axes.
 *
 * Deliberately never blended into one "drift score" — a category disagreement
 * and a confidence spread are not commensurable, mirroring
 * `bench/service-diagnosis.ts`'s own refusal to do this for its five axes.
 */
export function diffDiagnoses(runs: ProviderRun[]): DiagnosisDrift {
	const categories: Record<string, string[]> = {};
	const confidences: number[] = [];
	for (const run of runs) {
		const rootCause = run.diagnosis.root_cause;
		if (!rootCause) continue;
		(categories[rootCause.category] ??= []).push(run.run_id);
		confidences.push(rootCause.confidence);
	}
	const distinctCategories = Object.keys(categories).length;
	const category_agreement = distinctCategories <= 1;
	const confidence_spread =
		confidences.length === 0 ? 0 : Math.max(...confidences) - Math.min(...confidences);
	const evidence_kind_overlap = jaccard(runs.map((r) => evidenceKinds(r.diagnosis.evidence)));

	return { category_agreement, categories, confidence_spread, evidence_kind_overlap };
}

export type RemediationDrift = {
	/** True iff every run that produced a recommendation agreed on the recommended MODE SET. */
	mode_set_agreement: boolean;
	mode_sets: Record<string, string[]>;
};

/**
 * Compare N remediation recommendations (from `remediation/modes.ts`'s own
 * `recommend()`, built by the caller) for agreement on the recommended set
 * of modes. Reuses `Recommendation.recommended` unmodified; this module
 * does not call `recommend()` itself.
 */
export function diffRemediation(runs: ProviderRun[]): RemediationDrift | null {
	const withRecs = runs.filter((r) => r.recommendation);
	if (withRecs.length === 0) return null;

	const mode_sets: Record<string, string[]> = {};
	for (const run of withRecs) {
		const modes: RemediationMode[] = run.recommendation!.recommended.map((e) => e.mode).sort();
		const key = modes.length === 0 ? "(none)" : modes.join(",");
		(mode_sets[key] ??= []).push(run.run_id);
	}
	return { mode_set_agreement: Object.keys(mode_sets).length <= 1, mode_sets };
}

export type CrossProviderReplayInput = {
	runs: ProviderRun[];
	identities: Record<string, Record<string, unknown>>;
	fidelity: Record<string, EvidenceFidelityInput>;
};

export type CrossProviderReplayReport = {
	identities: ProviderIdentityResolution[];
	fidelity: EvidenceFidelityResolution[];
	diagnosis_drift: DiagnosisDrift | null;
	remediation_drift: RemediationDrift | null;
	abstain: boolean;
	/** Non-empty iff `abstain`. */
	abstain_reasons: string[];
};

/**
 * Run the full cross-provider replay: resolve identity and fidelity per run,
 * measure drift, and decide whether the comparison can be reported.
 *
 * Abstention is checked BEFORE drift is reported as actionable: the drift
 * numbers are still computed (so a caller auditing an abstained comparison
 * can see what the raw numbers were), but `abstain: true` is the governing
 * verdict and a caller must check it before acting on `diagnosis_drift` or
 * `remediation_drift`.
 */
export function gateCrossProviderReplay(
	input: CrossProviderReplayInput,
): CrossProviderReplayReport {
	const identities = input.runs.map((r) =>
		resolveProviderIdentity(r.run_id, input.identities[r.run_id] ?? {}),
	);
	const fidelity = input.runs.map((r) =>
		resolveEvidenceFidelity(input.fidelity[r.run_id] ?? { run_id: r.run_id }),
	);

	const diagnosis_drift = input.runs.length > 0 ? diffDiagnoses(input.runs) : null;
	const remediation_drift = input.runs.length > 0 ? diffRemediation(input.runs) : null;

	const abstain_reasons: string[] = [];
	if (input.runs.length < MIN_PROVIDERS) {
		abstain_reasons.push(
			`only ${input.runs.length} run(s) supplied; at least ${MIN_PROVIDERS} pinned providers are required to measure drift`,
		);
	}
	for (const identity of identities) {
		if (!identity.pinned) {
			abstain_reasons.push(
				`run '${identity.run_id}' is not pinned: ${identity.reasons.join("; ")}`,
			);
		}
	}
	for (const fid of fidelity) {
		if (!fid.faithful) {
			abstain_reasons.push(
				`run '${fid.run_id}' evidence is not faithful: ${fid.reasons.join("; ")}`,
			);
		}
	}

	return {
		identities,
		fidelity,
		diagnosis_drift,
		remediation_drift,
		abstain: abstain_reasons.length > 0,
		abstain_reasons,
	};
}

/** Render a report for a human reviewing a cross-provider comparison. */
export function renderCrossProviderReplay(report: CrossProviderReplayReport): string {
	const lines: string[] = ["# Cross-Provider Diagnostic Replay", ""];
	if (report.abstain) {
		lines.push("**ABSTAINED** — no verdict is reported.", "");
		for (const reason of report.abstain_reasons) lines.push(`- ${reason}`);
		lines.push("");
	}
	lines.push("## Provider identity", "");
	for (const identity of report.identities) {
		lines.push(
			`- ${identity.run_id}: ${identity.pinned ? "pinned" : "NOT pinned"}${
				identity.pinned
					? ` (${JSON.stringify(identity.identity)})`
					: ` — ${identity.reasons.join("; ")}`
			}`,
		);
	}
	lines.push("", "## Evidence fidelity", "");
	for (const fid of report.fidelity) {
		lines.push(
			`- ${fid.run_id}: ${fid.faithful ? "faithful" : `NOT faithful — ${fid.reasons.join("; ")}`}`,
		);
	}
	if (report.diagnosis_drift) {
		lines.push(
			"",
			"## Diagnosis drift",
			"",
			`- category agreement: ${report.diagnosis_drift.category_agreement}`,
			`- confidence spread: ${report.diagnosis_drift.confidence_spread.toFixed(3)}`,
			`- evidence-kind overlap: ${report.diagnosis_drift.evidence_kind_overlap.toFixed(3)}`,
		);
	}
	if (report.remediation_drift) {
		lines.push(
			"",
			"## Remediation drift",
			"",
			`- mode-set agreement: ${report.remediation_drift.mode_set_agreement}`,
		);
	}
	return lines.join("\n");
}
