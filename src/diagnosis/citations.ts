/**
 * Mandatory evidence citations for diagnoses, repairs, and confidence updates
 * (item 61).
 *
 * An unsourced diagnosis is indistinguishable from a plausible guess, and the
 * two are equally confident. This module makes the citation a structural
 * requirement rather than a convention: a claim with no citations does not pass
 * the gate, and a claim whose citations do not check out is rejected with a
 * named reason.
 *
 * The distinctions it keeps are the useful part:
 *
 * - **A missing citation and a fabricated one are different failures.** The
 *   first is an omission; the second means the claim references evidence that
 *   does not exist, which is the signature of a hypothesis being decorated
 *   after the fact. They get different severities and are counted separately,
 *   because a system that never cites and a system that invents citations need
 *   opposite interventions.
 *
 * - **A quote is checked against the source.** Citing evidence you did read and
 *   quoting words it does not contain is the highest-severity violation here,
 *   above even fabricating an id: the id might be a typo, but a quote that is
 *   not in the text was produced rather than copied.
 *
 * - **A confidence update must cite evidence that points the way it moved.**
 *   Raising confidence while citing contradicting evidence is not a weak
 *   argument, it is an incoherent one, and it is exactly what happens when a
 *   citation is attached to justify a conclusion already reached.
 *
 * - **A vague citation is a distinct, lesser problem.** Pointing at a 4 000-line
 *   log is a citation; pointing at line 812 is a source. The first is reported
 *   as `imprecise` rather than rejected, because demanding line-level precision
 *   from evidence that has no lines would be its own kind of dishonesty.
 *
 * Pure: no I/O.
 */

export const CLAIM_KINDS = ["diagnosis", "repair", "confidence_update"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** A piece of evidence a claim may cite. */
export type EvidenceRecord = {
	id: string;
	/** Where it came from: `output`, `trace`, `test`, `diff`, `config`, … */
	source: string;
	/** The text a quote is checked against. */
	content: string;
	/** True when this record has addressable sub-locations (lines, span ids). */
	addressable?: boolean;
	/** Set when a later record replaces this one. */
	superseded_by?: string;
};

export type Citation = {
	evidence_id: string;
	/** A specific location inside the evidence: `L812-L820`, a span id, a key. */
	locator?: string;
	/** Verbatim text that must appear in the evidence. */
	quote?: string;
};

export type ClaimStance = "supports" | "contradicts";

export type Claim = {
	id: string;
	kind: ClaimKind;
	statement: string;
	citations: Citation[];
	/** Required for `confidence_update`. */
	confidence_from?: number;
	confidence_to?: number;
	/** Direction the cited evidence points, for `confidence_update`. */
	stance?: ClaimStance;
};

export const VIOLATION_CODES = [
	"fabricated_quote",
	"fabricated_evidence",
	"no_citations",
	"incoherent_update",
	"malformed_update",
	"superseded_evidence",
	"imprecise_citation",
	"duplicate_citation",
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export type Severity = "critical" | "error" | "warning";

/**
 * Severity per code.
 *
 * `fabricated_quote` outranks `fabricated_evidence` deliberately: a wrong id
 * can be a typo, while text that is not in the source was generated rather than
 * read, and that is a different and worse failure.
 */
export const VIOLATION_SEVERITY: Record<ViolationCode, Severity> = {
	fabricated_quote: "critical",
	fabricated_evidence: "critical",
	no_citations: "error",
	incoherent_update: "error",
	malformed_update: "error",
	superseded_evidence: "warning",
	imprecise_citation: "warning",
	duplicate_citation: "warning",
};

export type Violation = {
	claim_id: string;
	code: ViolationCode;
	severity: Severity;
	detail: string;
};

/**
 * Normalize text for quote comparison.
 *
 * Whitespace is collapsed because reflowing a log line is not a fabrication.
 * Case and punctuation are preserved because changing them is: `permission
 * denied` and `Permission Denied` may be different messages from different
 * subsystems, and a matcher that cannot tell them apart cannot catch the
 * substitution.
 */
export function normalizeQuote(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Whether `quote` genuinely appears in `content`. */
export function quoteAppears(quote: string, content: string): boolean {
	const needle = normalizeQuote(quote);
	if (needle.length === 0) return false;
	return normalizeQuote(content).includes(needle);
}

export type CitationPolicy = {
	/**
	 * `off` records nothing, `warn` reports but accepts, `block` rejects any
	 * claim with a violation at or above `block_at`.
	 */
	enforcement: "off" | "warn" | "block";
	block_at: Severity;
	/** Require a locator when the evidence declares itself addressable. */
	require_locator: boolean;
};

export const DEFAULT_CITATION_POLICY: CitationPolicy = {
	enforcement: "block",
	block_at: "error",
	require_locator: true,
};

const SEVERITY_ORDER: Record<Severity, number> = { warning: 0, error: 1, critical: 2 };

/**
 * Check one claim against the evidence index.
 *
 * Returns every violation rather than the first, because a claim with a
 * fabricated id *and* an incoherent direction has two distinct problems and
 * fixing one would leave the other.
 */
export function checkClaim(
	claim: Claim,
	evidence: Map<string, EvidenceRecord>,
	policy: CitationPolicy = DEFAULT_CITATION_POLICY,
): Violation[] {
	const violations: Violation[] = [];
	const add = (code: ViolationCode, detail: string): void => {
		violations.push({
			claim_id: claim.id,
			code,
			severity: VIOLATION_SEVERITY[code],
			detail,
		});
	};

	if (claim.citations.length === 0) {
		add("no_citations", `${claim.kind} '${claim.id}' cites no evidence`);
	}

	const seen = new Set<string>();
	for (const citation of claim.citations) {
		const key = `${citation.evidence_id}#${citation.locator ?? ""}`;
		if (seen.has(key)) {
			add("duplicate_citation", `cites ${key} more than once; repetition is not corroboration`);
			continue;
		}
		seen.add(key);

		const record = evidence.get(citation.evidence_id);
		if (!record) {
			add(
				"fabricated_evidence",
				`cites evidence '${citation.evidence_id}', which is not in the evidence set`,
			);
			continue;
		}

		if (citation.quote !== undefined && !quoteAppears(citation.quote, record.content)) {
			add(
				"fabricated_quote",
				`quotes "${normalizeQuote(citation.quote).slice(0, 80)}" from '${record.id}', which does not contain it`,
			);
		}

		if (policy.require_locator && record.addressable === true && !citation.locator) {
			add(
				"imprecise_citation",
				`cites '${record.id}' as a whole; that evidence has addressable locations and one should be named`,
			);
		}

		if (record.superseded_by) {
			add(
				"superseded_evidence",
				`cites '${record.id}', which was superseded by '${record.superseded_by}'`,
			);
		}
	}

	if (claim.kind === "confidence_update") {
		const { confidence_from: from, confidence_to: to, stance } = claim;
		if (from === undefined || to === undefined || stance === undefined) {
			add(
				"malformed_update",
				"a confidence update must state the confidence before and after and the stance of its evidence",
			);
		} else if (from !== to) {
			const rose = to > from;
			if (rose && stance === "contradicts") {
				add(
					"incoherent_update",
					`confidence rose from ${from} to ${to} while citing contradicting evidence`,
				);
			}
			if (!rose && stance === "supports") {
				add(
					"incoherent_update",
					`confidence fell from ${from} to ${to} while citing supporting evidence`,
				);
			}
		}
	}

	return violations;
}

export type EnforcementResult = {
	accepted: Claim[];
	rejected: Array<{ claim: Claim; violations: Violation[] }>;
	violations: Violation[];
	summary: {
		claims: number;
		/** Claims with at least one violation of any severity. */
		flagged: number;
		by_code: Record<string, number>;
		/**
		 * Reported apart because they call for opposite interventions: a system
		 * that never cites needs a prompt change, one that invents citations
		 * needs a gate.
		 */
		uncited_claims: number;
		fabricating_claims: number;
	};
};

/** Build an index, keeping the last record for a repeated id. */
export function indexEvidence(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
	return new Map(records.map((r) => [r.id, r]));
}

/**
 * Enforce the policy over a set of claims.
 *
 * Under `off`, every claim is accepted and no violations are computed, which is
 * the only honest meaning of "off" — reporting violations while accepting
 * everything is what `warn` is for, and conflating them leaves nobody sure
 * whether the gate is on.
 */
export function enforceCitations(
	claims: Claim[],
	records: EvidenceRecord[],
	policy: CitationPolicy = DEFAULT_CITATION_POLICY,
): EnforcementResult {
	if (policy.enforcement === "off") {
		return {
			accepted: [...claims],
			rejected: [],
			violations: [],
			summary: {
				claims: claims.length,
				flagged: 0,
				by_code: {},
				uncited_claims: 0,
				fabricating_claims: 0,
			},
		};
	}

	const evidence = indexEvidence(records);
	const accepted: Claim[] = [];
	const rejected: EnforcementResult["rejected"] = [];
	const all: Violation[] = [];
	const byCode: Record<string, number> = {};
	let flagged = 0;
	let uncited = 0;
	let fabricating = 0;

	for (const claim of claims) {
		const violations = checkClaim(claim, evidence, policy);
		all.push(...violations);
		for (const v of violations) byCode[v.code] = (byCode[v.code] ?? 0) + 1;
		if (violations.length > 0) flagged++;
		if (violations.some((v) => v.code === "no_citations")) uncited++;
		if (violations.some((v) => v.code === "fabricated_evidence" || v.code === "fabricated_quote")) {
			fabricating++;
		}

		const blocking =
			policy.enforcement === "block" &&
			violations.some((v) => SEVERITY_ORDER[v.severity] >= SEVERITY_ORDER[policy.block_at]);
		if (blocking) rejected.push({ claim, violations });
		else accepted.push(claim);
	}

	return {
		accepted,
		rejected,
		violations: all,
		summary: {
			claims: claims.length,
			flagged,
			by_code: byCode,
			uncited_claims: uncited,
			fabricating_claims: fabricating,
		},
	};
}

/**
 * Which evidence records nothing cited.
 *
 * The complement of the usual question, and frequently the more interesting
 * one: evidence that was collected, cost something to collect, and then played
 * no part in the conclusion is either irrelevant (stop collecting it) or was
 * overlooked (the conclusion may be wrong).
 */
export function uncitedEvidence(claims: Claim[], records: EvidenceRecord[]): EvidenceRecord[] {
	const cited = new Set(claims.flatMap((c) => c.citations.map((x) => x.evidence_id)));
	return records.filter((r) => !cited.has(r.id));
}

/** A one-line rendering of a violation, ordered severity-first for scanning. */
export function renderViolations(violations: Violation[]): string {
	return [...violations]
		.sort(
			(a, b) =>
				SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
				a.claim_id.localeCompare(b.claim_id) ||
				a.code.localeCompare(b.code),
		)
		.map((v) => `[${v.severity.toUpperCase()}] ${v.claim_id}: ${v.code} — ${v.detail}`)
		.join("\n");
}
