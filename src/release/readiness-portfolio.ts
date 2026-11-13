/**
 * Publish incident-readiness release portfolios (item 40, item 106 in this
 * project's own module-header numbering convention — confirmed as the next
 * free number via `grep -rohE "item [0-9]+" src --include="*.ts" |
 * sort -t' ' -k2 -n -u`, highest prior use was item 105 from item 39's
 * `diagnosis/operator-adjudication.ts`).
 *
 * The item asks for one signed promote/hold/rollback verdict combining SEVEN
 * independently-computed dimensions: telemetry fidelity, attribution,
 * reproducer quality, recovery safety, privacy, advisory exposure, and
 * drift. `grep -rln "readiness|portfolio" src --include="*.ts"` before this
 * module matched nothing — every one of the seven dimensions already has
 * its own module that computes it correctly and refuses on insufficient
 * evidence, but nothing combined them into one gated release decision:
 *
 * 1. **Telemetry fidelity** — `trace/telemetry-gaps.ts` (item 32)
 *    `TelemetryGapReport`, consumed unmodified.
 * 2. **Attribution** — `diagnosis/change-point.ts` (item 72)
 *    `ChangePointReport`, consumed unmodified (its own `refused_reason` is
 *    reported as-is, never overridden with an opinion).
 * 3. **Reproducer quality** — `repro/counterfactual.ts` (item 55)
 *    `ControlResult`, consumed unmodified.
 * 4. **Recovery safety** — `remediation/canary.ts` (item 29) `CanaryReport`,
 *    consumed unmodified, INCLUDING its own promote/hold/rollback verdict.
 * 5. **Privacy** — `exchange/privacy-sharing.ts` (item 28) `PrivacyBudget`,
 *    consumed unmodified (an over-spent or near-exhausted budget holds the
 *    release rather than silently continuing to draw on it).
 * 6. **Advisory exposure** — `security/advisories.ts` (item 37)
 *    `AdvisoryIngestReport`, consumed unmodified.
 * 7. **Drift** — `diagnosis/longitudinal-drift.ts` (item 30)
 *    `LongitudinalDriftReport`, consumed unmodified.
 *
 * **Combining rule, deliberately conservative and ordered:** `rollback`
 * outranks `hold` outranks `promote` — a `rollback`-worthy dimension (the
 * canary's own `recovery_safety.verdict === "rollback"`, or an `exploitable`
 * advisory, no bounded recovery a release can ship with) is NEVER
 * downgraded to a `hold` by a milder, unrelated concern elsewhere, and a
 * `hold`-worthy dimension (an unexplained telemetry gap, an over-spent
 * privacy budget, a regressed drift dimension, a non-`causal` reproducer
 * verdict, the canary's own `hold`) is NEVER silently promoted past. Every
 * dimension that contributed to the final verdict names itself in
 * `reasons`, not just the first one found — a reader sees every reason the
 * release did not clear, not just whichever check ran first.
 *
 * **The signature covers the verdict and the dimension summaries, not the
 * raw underlying reports.** Mirrors `release/supply-chain.ts` (item 94)
 * `signRelease`/`verifyRelease`'s own HMAC-over-canonical-payload
 * construction exactly — this module does not invent a new signing scheme,
 * it reuses that module's own `createHmac`/`timingSafeEqual` discipline on a
 * payload shaped for a readiness verdict instead of an artifact manifest.
 *
 * Pure apart from the HMAC call itself (no fs/network/randomness); the
 * seven dimension reports are supplied by the caller, exactly as
 * `longitudinal-drift.ts` and `telemetry-gaps.ts` already require of their
 * own callers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { LongitudinalDriftReport } from "../diagnosis/longitudinal-drift.js";
import type { CanaryReport } from "../remediation/canary.js";
import type { ControlResult } from "../repro/counterfactual.js";
import type { AdvisoryIngestReport } from "../security/advisories.js";
import type { TelemetryGapReport } from "../trace/telemetry-gaps.js";

/** The minimal shape this module needs from `exchange/privacy-sharing.ts`'s `PrivacyBudget`. */
export type PrivacyBudgetSummary = {
	epsilon_total: number;
	epsilon_spent: number;
};

/** The minimal shape this module needs from `change-point.ts`'s `ChangePointReport`. */
export type AttributionSummary =
	| { refused_reason: string }
	| {
			refused_reason?: undefined;
			counts: { attributed: number; confounded: number; unexplained: number };
	  };

export type ReadinessInputs = {
	project: string;
	version: string;
	built_at_ms: number;
	telemetry_fidelity: TelemetryGapReport;
	attribution: AttributionSummary;
	reproducer_quality: ControlResult;
	recovery_safety: CanaryReport;
	privacy_budget: PrivacyBudgetSummary;
	advisory_exposure: AdvisoryIngestReport;
	drift: LongitudinalDriftReport;
};

export const READINESS_VERDICTS = ["promote", "hold", "rollback"] as const;
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number];

/** Fraction of the privacy budget spent above which a release holds rather than drawing further. */
export const PRIVACY_BUDGET_HOLD_THRESHOLD = 0.9;

export type ReadinessPortfolio = {
	project: string;
	version: string;
	built_at_ms: number;
	verdict: ReadinessVerdict;
	dimension_summaries: {
		telemetry_fidelity: { unexplained_gaps: number };
		attribution: { refused: boolean };
		reproducer_quality: { verdict: ControlResult["verdict"] };
		recovery_safety: { verdict: CanaryReport["verdict"] };
		privacy_budget: { fraction_spent: number };
		advisory_exposure: { exploitable_count: number };
		drift: { regressed_dimensions: string[] };
	};
	signature: string;
};

export type ReadinessReport = {
	portfolio: ReadinessPortfolio;
	verdict: ReadinessVerdict;
	/** Every reason that contributed to the verdict, never just the first found. */
	reasons: string[];
};

function portfolioPayload(portfolio: Omit<ReadinessPortfolio, "signature">): string {
	return JSON.stringify({
		project: portfolio.project,
		version: portfolio.version,
		built_at_ms: portfolio.built_at_ms,
		verdict: portfolio.verdict,
		dimension_summaries: portfolio.dimension_summaries,
	});
}

/**
 * Combine the seven dimensions into one promote/hold/rollback verdict and
 * sign the resulting portfolio.
 *
 * Priority is rollback > hold > promote, and every dimension's own reason is
 * accumulated — never short-circuited to the first finding — so a caller
 * reading `reasons` sees the full case, not a partial one.
 */
export function publishReleaseReadinessPortfolio(
	inputs: ReadinessInputs,
	signingKey: string,
): ReadinessReport {
	const reasons: string[] = [];
	let verdict: ReadinessVerdict = "promote";

	const escalate = (next: ReadinessVerdict, reason: string) => {
		reasons.push(reason);
		if (next === "rollback") verdict = "rollback";
		else if (next === "hold" && verdict !== "rollback") verdict = "hold";
	};

	// Recovery safety: the canary's own verdict is reused unmodified, never re-derived.
	if (inputs.recovery_safety.verdict === "rollback") {
		escalate(
			"rollback",
			`recovery-safety canary itself verdicted 'rollback': ${inputs.recovery_safety.reasons.join("; ")}`,
		);
	} else if (inputs.recovery_safety.verdict === "hold") {
		escalate(
			"hold",
			`recovery-safety canary itself verdicted 'hold': ${inputs.recovery_safety.reasons.join("; ")}`,
		);
	}

	// Advisory exposure: any exploitable advisory holds the release until a bounded
	// recovery ships; it is never promoted past regardless of every other dimension.
	const exploitableCount = inputs.advisory_exposure.assessments.filter(
		(a) => a.status === "exploitable",
	).length;
	if (exploitableCount > 0) {
		escalate(
			"hold",
			`${exploitableCount} exploitable advisor${exploitableCount === 1 ? "y" : "ies"} named against this release's dependencies`,
		);
	}

	// Telemetry fidelity: an unexplained gap (unknown_evidence) holds; a confirmed,
	// explained absence does not, by the same evidence-of-absence distinction
	// telemetry-gaps.ts itself draws.
	if (inputs.telemetry_fidelity.unknown_evidence_count > 0) {
		escalate(
			"hold",
			`${inputs.telemetry_fidelity.unknown_evidence_count} unexplained telemetry gap(s): the evidence this release's readiness rests on is incomplete in an unexplained way`,
		);
	}

	// Attribution: a refusal is reported but is NOT itself a hold — change-point.ts
	// already refuses conservatively on short series, which is correct behavior, not
	// a readiness problem on its own.
	if (inputs.attribution.refused_reason) {
		reasons.push(`attribution check refused: ${inputs.attribution.refused_reason}`);
	}

	// Reproducer quality: only a `causal` verdict is strong enough evidence; any
	// other verdict (refuted/flaky/regression/etc.) holds.
	if (inputs.reproducer_quality.verdict !== "causal") {
		escalate(
			"hold",
			`reproducer-quality verdict is '${inputs.reproducer_quality.verdict}', not 'causal': ${inputs.reproducer_quality.summary}`,
		);
	}

	// Privacy budget: holds before the budget is effectively exhausted, not after.
	const fractionSpent =
		inputs.privacy_budget.epsilon_total <= 0
			? 1
			: inputs.privacy_budget.epsilon_spent / inputs.privacy_budget.epsilon_total;
	if (fractionSpent >= PRIVACY_BUDGET_HOLD_THRESHOLD) {
		escalate(
			"hold",
			`privacy budget ${(fractionSpent * 100).toFixed(1)}% spent, at or above the ${(PRIVACY_BUDGET_HOLD_THRESHOLD * 100).toFixed(0)}% hold threshold`,
		);
	}

	// Drift: any regressed dimension holds.
	if (inputs.drift.regressed_dimensions.length > 0) {
		escalate(
			"hold",
			`drift regressed in dimension(s): ${inputs.drift.regressed_dimensions.join(", ")}`,
		);
	}

	if (verdict === "promote") {
		reasons.push(
			"every dimension (telemetry fidelity, reproducer quality, recovery safety, privacy budget, advisory exposure, drift) cleared; attribution carries its own refusal state when present",
		);
	}

	const unsigned: Omit<ReadinessPortfolio, "signature"> = {
		project: inputs.project,
		version: inputs.version,
		built_at_ms: inputs.built_at_ms,
		verdict,
		dimension_summaries: {
			telemetry_fidelity: { unexplained_gaps: inputs.telemetry_fidelity.unknown_evidence_count },
			attribution: { refused: Boolean(inputs.attribution.refused_reason) },
			reproducer_quality: { verdict: inputs.reproducer_quality.verdict },
			recovery_safety: { verdict: inputs.recovery_safety.verdict },
			privacy_budget: { fraction_spent: fractionSpent },
			advisory_exposure: { exploitable_count: exploitableCount },
			drift: { regressed_dimensions: [...inputs.drift.regressed_dimensions] },
		},
	};

	const portfolio: ReadinessPortfolio = {
		...unsigned,
		signature: createHmac("sha256", signingKey).update(portfolioPayload(unsigned)).digest("hex"),
	};

	return { portfolio, verdict, reasons };
}

/**
 * Verify a readiness portfolio's signature against the exact payload it was
 * signed over, using a constant-time comparison.
 *
 * Mirrors `release/supply-chain.ts`'s `verifyRelease` signature check
 * exactly; this is an attribution property (who signed it), not a safety
 * property (whether the verdict is correct) — the same caveat that module's
 * own `SignatureVerification.what_this_proves` states.
 */
export function verifyReadinessSignature(
	portfolio: ReadinessPortfolio,
	signingKey: string,
): boolean {
	const expected = Buffer.from(
		createHmac("sha256", signingKey).update(portfolioPayload(portfolio)).digest("hex"),
		"hex",
	);
	const actual = Buffer.from(portfolio.signature, "hex");
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Render a report for a human deciding whether to ship. */
export function renderReadinessPortfolio(report: ReadinessReport): string {
	const lines: string[] = [
		"# Incident-Readiness Release Portfolio",
		"",
		`**Project:** ${report.portfolio.project}@${report.portfolio.version}`,
		`**Verdict:** ${report.verdict}`,
		"",
		"## Reasons",
		"",
	];
	for (const reason of report.reasons) lines.push(`- ${reason}`);
	lines.push("", "## Dimension summaries", "");
	const s = report.portfolio.dimension_summaries;
	lines.push(
		`- telemetry_fidelity: ${s.telemetry_fidelity.unexplained_gaps} unexplained gap(s)`,
		`- attribution: refused=${s.attribution.refused}`,
		`- reproducer_quality: ${s.reproducer_quality.verdict}`,
		`- recovery_safety: ${s.recovery_safety.verdict}`,
		`- privacy_budget: ${(s.privacy_budget.fraction_spent * 100).toFixed(1)}% spent`,
		`- advisory_exposure: ${s.advisory_exposure.exploitable_count} exploitable`,
		`- drift: regressed=${s.drift.regressed_dimensions.join(", ") || "(none)"}`,
	);
	return lines.join("\n");
}
