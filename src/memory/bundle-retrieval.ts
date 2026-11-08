/**
 * Privacy-safe debugging memory retrieval (item 34).
 *
 * `exchange/bundle.ts` (item 49) already defines signed, scrubbed
 * failure/diagnosis/repair bundles and a trust score for importing them one
 * at a time. `storage/governance.ts` (item 90) already defines tenant
 * isolation that *refuses* an unscoped query rather than defaulting to "every
 * tenant" — and already lists `exchange_bundle` as a governed data class with
 * its own retention TTL. `remediation/learned-ranking.ts` (item 97) already
 * defines a Wilson lower bound for ranking small-sample outcome rates
 * conservatively. None of the three talk to each other: nothing indexes
 * bundles for retrieval, nothing routes that retrieval through tenant
 * isolation, and nothing asks whether a bundle's diagnosis/repair pattern has
 * *actually helped* before recommending it again.
 *
 * This module adds exactly that retrieval path, composing all three
 * unmodified:
 *
 * 1. **Tenant leakage is prevented by delegation, not re-implementation.**
 *    Every candidate bundle is wrapped in a `GovernedRecord` and the query is
 *    run through `queryRecords` verbatim. A caller who forgets a tenant
 *    predicate gets the exact same refusal `governance.ts` already gives any
 *    other governed query — there is no second, retrieval-specific place
 *    where "no tenant" could accidentally mean "every tenant".
 * 2. **Stale transfer is refused, not merely discounted.** `assessTrust`
 *    already applies an age-decay *discount*; that is right for trust, but a
 *    bundle past the data class's own governed TTL
 *    (`DEFAULT_RETENTION.exchange_bundle`) is refused outright for transfer,
 *    the same "refuse past the line, don't fade" posture `planRetention`
 *    already uses for storage.
 * 3. **Applicability requires evidence, not a single success.** A bundle
 *    usage history is scored with `wilsonLowerBound` (unmodified) and judged
 *    against `MIN_SAMPLES_FOR_RANKING` (unmodified) — exactly the standard
 *    item 97 already applies to remediation modes, applied here to "should
 *    this diagnosis/repair pattern be retrieved again".
 * 4. **Retrieval lift vs. negative transfer is measured, not assumed.** A
 *    bundle's own historical success rate when reused is compared against an
 *    explicit baseline (the success rate achieved *without* retrieval); a
 *    bundle that measurably performs worse than the baseline is named
 *    `negative_transfer`, not silently ranked lower.
 *
 * Pure: no fs, no network, no clock (timestamps are passed in), so a caller
 * can audit exactly why a bundle was retrieved, refused, or marked as
 * negative transfer.
 */
import {
	DEFAULT_MIN_TRUST,
	type DiagnosticBundle,
	type TrustOptions,
	assessTrust,
	bundleFingerprint,
} from "../exchange/bundle.js";
import { MIN_SAMPLES_FOR_RANKING, wilsonLowerBound } from "../remediation/learned-ranking.js";
import {
	DEFAULT_RETENTION,
	type GovernedRecord,
	type TenantQuery,
	queryRecords,
} from "../storage/governance.js";

/** One bundle, tagged with the tenant that produced it. */
export type MemoryCandidate = {
	bundle: DiagnosticBundle;
	tenant: string;
};

/** One recorded outcome of reusing a bundle's diagnosis/repair pattern. */
export type BundleUsageOutcome = {
	bundle_fingerprint: string;
	succeeded: boolean;
};

export const APPLICABILITY_VERDICTS = [
	"applicable",
	"not_applicable",
	"insufficient_data",
] as const;
export type ApplicabilityVerdict = (typeof APPLICABILITY_VERDICTS)[number];

/** Minimum Wilson lower bound for a well-evidenced bundle to count as applicable. */
export const MIN_APPLICABILITY_CONFIDENCE = 0.5;

export type ApplicabilityEvidence = {
	samples: number;
	successes: number;
	wilson_lower_bound: number;
	verdict: ApplicabilityVerdict;
};

/** Score a bundle's prior-usage evidence with the same statistic item 97 uses for modes. */
export function scoreApplicability(outcomes: BundleUsageOutcome[]): ApplicabilityEvidence {
	const samples = outcomes.length;
	const successes = outcomes.filter((o) => o.succeeded).length;
	if (samples < MIN_SAMPLES_FOR_RANKING) {
		return {
			samples,
			successes,
			wilson_lower_bound: samples > 0 ? wilsonLowerBound(successes, samples) : 0,
			verdict: "insufficient_data",
		};
	}
	const lowerBound = wilsonLowerBound(successes, samples);
	return {
		samples,
		successes,
		wilson_lower_bound: lowerBound,
		verdict: lowerBound >= MIN_APPLICABILITY_CONFIDENCE ? "applicable" : "not_applicable",
	};
}

export const TRANSFER_VERDICTS = [
	"positive_transfer",
	"negative_transfer",
	"insufficient_data",
] as const;
export type TransferVerdict = (typeof TRANSFER_VERDICTS)[number];

export type LiftReport = {
	bundle_fingerprint: string;
	samples: number;
	success_rate: number;
	baseline_success_rate: number;
	/** success_rate - baseline_success_rate. Negative means reuse did worse than not retrieving. */
	lift: number;
	verdict: TransferVerdict;
};

/**
 * Compare a bundle's reuse success rate against an explicit baseline (the
 * success rate achieved by remediation attempts that did NOT use retrieved
 * memory). The baseline is a caller-supplied fact, never inferred, so this
 * cannot quietly assume "no memory" means "worse" when nobody measured it.
 */
export function measureRetrievalLift(
	fingerprint: string,
	outcomes: BundleUsageOutcome[],
	baselineSuccessRate: number,
): LiftReport {
	const samples = outcomes.length;
	if (samples < MIN_SAMPLES_FOR_RANKING) {
		return {
			bundle_fingerprint: fingerprint,
			samples,
			success_rate: samples > 0 ? outcomes.filter((o) => o.succeeded).length / samples : 0,
			baseline_success_rate: baselineSuccessRate,
			lift: 0,
			verdict: "insufficient_data",
		};
	}
	const successRate = outcomes.filter((o) => o.succeeded).length / samples;
	const lift = successRate - baselineSuccessRate;
	return {
		bundle_fingerprint: fingerprint,
		samples,
		success_rate: successRate,
		baseline_success_rate: baselineSuccessRate,
		lift,
		verdict: lift >= 0 ? "positive_transfer" : "negative_transfer",
	};
}

export type RetrievedMemory = {
	bundle: DiagnosticBundle;
	trust_score: number;
	applicability: ApplicabilityEvidence;
	lift?: LiftReport;
};

export type RejectedMemory = {
	bundle_id: string;
	reason: "low_trust" | "stale_transfer" | "not_applicable" | "negative_transfer";
	detail: string;
};

export type MemoryRetrievalResult =
	| { ok: false; reason: string }
	| {
			ok: true;
			scope: string;
			retrieved: RetrievedMemory[];
			rejected: RejectedMemory[];
	  };

export type MemoryRetrievalOptions = {
	trust?: TrustOptions;
	min_trust?: number;
	/** Current time, ms since epoch — used against the governed TTL, not trust decay. */
	now_ms: number;
	/** Per-bundle usage history, keyed by bundle fingerprint. */
	usage?: Map<string, BundleUsageOutcome[]>;
	/** Success rate achieved without retrieval, for lift measurement. Omit to skip lift. */
	baseline_success_rate?: number;
	/** Governed TTL for the exchange_bundle data class. Defaults to the real governance default. */
	stale_after_ms?: number;
};

/**
 * Retrieve privacy-safe debugging memory for a tenant-scoped query.
 *
 * Tenant isolation is enforced by `queryRecords` itself (item 90, unmodified):
 * a query naming no tenant and no explicit cross-tenant authorization is
 * refused here exactly as it would be refused for any other governed data
 * class, before any bundle is even considered.
 */
export function retrievePrivacySafeMemory(
	candidates: MemoryCandidate[],
	query: TenantQuery,
	opts: MemoryRetrievalOptions,
): MemoryRetrievalResult {
	const records: GovernedRecord[] = candidates.map((c) => ({
		id: c.bundle.bundle_id,
		tenant: c.tenant,
		data_class: "exchange_bundle",
		created_at_ms: Date.parse(c.bundle.created_at) || 0,
		locations: ["memory_index"],
	}));

	const scoped = queryRecords(records, query);
	if (!scoped.ok) return { ok: false, reason: scoped.reason };

	const byId = new Map(candidates.map((c) => [c.bundle.bundle_id, c]));
	const staleAfterMs = opts.stale_after_ms ?? DEFAULT_RETENTION.exchange_bundle.ttl_ms;
	const minTrust = opts.min_trust ?? DEFAULT_MIN_TRUST;
	const trustOpts: TrustOptions = opts.trust ?? { now: new Date(opts.now_ms).toISOString() };

	const retrieved: RetrievedMemory[] = [];
	const rejected: RejectedMemory[] = [];

	for (const row of scoped.rows) {
		const candidate = byId.get(row.id);
		if (!candidate) continue;
		const bundle = candidate.bundle;

		const age = opts.now_ms - row.created_at_ms;
		if (age > staleAfterMs) {
			rejected.push({
				bundle_id: bundle.bundle_id,
				reason: "stale_transfer",
				detail: `bundle is ${Math.floor(age / 86_400_000)}d old against a ${Math.floor(staleAfterMs / 86_400_000)}d exchange_bundle retention; refused for transfer rather than merely discounted`,
			});
			continue;
		}

		const trust = assessTrust(bundle, trustOpts);
		if (trust.score < minTrust) {
			rejected.push({
				bundle_id: bundle.bundle_id,
				reason: "low_trust",
				detail: `trust ${trust.score.toFixed(2)} below the ${minTrust} threshold: ${trust.reasons.join("; ")}`,
			});
			continue;
		}

		const fingerprint = bundleFingerprint(bundle);
		const outcomes = opts.usage?.get(fingerprint) ?? [];
		const applicability = scoreApplicability(outcomes);
		if (applicability.verdict === "not_applicable") {
			rejected.push({
				bundle_id: bundle.bundle_id,
				reason: "not_applicable",
				detail: `${applicability.samples} prior use(s), Wilson lower bound ${applicability.wilson_lower_bound.toFixed(2)} below ${MIN_APPLICABILITY_CONFIDENCE}: evidence of inapplicability, not merely absence of evidence`,
			});
			continue;
		}

		let lift: LiftReport | undefined;
		if (opts.baseline_success_rate !== undefined) {
			lift = measureRetrievalLift(fingerprint, outcomes, opts.baseline_success_rate);
			if (lift.verdict === "negative_transfer") {
				rejected.push({
					bundle_id: bundle.bundle_id,
					reason: "negative_transfer",
					detail: `reuse success rate ${lift.success_rate.toFixed(2)} is below the ${lift.baseline_success_rate.toFixed(2)} no-retrieval baseline over ${lift.samples} sample(s) (lift ${lift.lift.toFixed(2)})`,
				});
				continue;
			}
		}

		retrieved.push({ bundle, trust_score: trust.score, applicability, lift });
	}

	retrieved.sort(
		(a, b) =>
			b.applicability.wilson_lower_bound - a.applicability.wilson_lower_bound ||
			b.trust_score - a.trust_score,
	);

	return { ok: true, scope: scoped.scope, retrieved, rejected };
}
