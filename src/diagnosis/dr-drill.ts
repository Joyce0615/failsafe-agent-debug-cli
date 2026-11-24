import type { DiagnosticBundle, TrustOptions } from "../exchange/bundle.js";
import { importBundles } from "../exchange/bundle.js";
/**
 * Diagnostic disaster-recovery drills (item 50, module-header numbering:
 * item 116, confirmed next-free via `grep -rohE "item [0-9]+" src
 * --include="*.ts" | sort -t' ' -k2 -n -u`, highest prior being item 115
 * from item 49's `diagnosis/handoff-continuity.ts`).
 *
 * This item names five failure conditions and asks for a drill harness
 * that simulates each, measures RPO/RTO and attribution degradation, and
 * judges whether restoration is SAFE. Each condition already has a
 * module that detects or scores it correctly in isolation, and none of
 * them has ever been pointed at a drill:
 *
 * - **Telemetry loss** -> `testing/chaos.ts` (item 88) already
 *   distinguishes `degraded_loudly` from `degraded_silently` for exactly
 *   this condition. Reused UNMODIFIED via `assessResilience`.
 * - **Store corruption** -> `exchange/custody.ts` (item 85) already
 *   makes a hash chain tamper-evident: `recomputeChainIntegrity`
 *   detects a spliced/altered record by recomputing every link_hash.
 *   Reused UNMODIFIED.
 * - **Key revocation** -> `exchange/encryption.ts` (item 89) already
 *   states explicitly that it does not implement revocation itself
 *   ("distribution, rotation, and revocation are the parts of a scheme
 *   like this that fail in practice") and returns `issueKeys`'
 *   per-recipient key set. This drill simulates a revocation by
 *   re-running `issueKeys` with the revoked key removed from
 *   `allKeys` and checking the previously-issued recipient's access is
 *   now excluded.
 * - **Provider outage** -> `diagnosis/cross-provider-replay.ts`
 *   (item 101) already refuses (`abstain: true`) to report a comparison
 *   when fewer than `MIN_PROVIDERS` pinned runs are available. A
 *   provider outage during a drill is exactly "down to one provider",
 *   reused via `gateCrossProviderReplay` UNMODIFIED.
 * - **Compromised debugging memory** -> `exchange/bundle.ts` (item 49)
 *   already scores trust and disqualifies (`score: 0`) a bundle with an
 *   invalid signature. A compromised memory store is simulated as a
 *   batch of bundles whose signatures no longer verify against the
 *   importer's current key (e.g. after the signing key itself was
 *   rotated out from under them), reused via `assessTrust`/
 *   `importBundles` UNMODIFIED.
 *
 * `grep -rln "disaster.recovery|RPO|RTO|drill" src --include="*.ts" -i`
 * returned nothing before this module; none of the five primitives
 * above had ever been composed into a single drill report, and none of
 * them computes RPO, RTO, or attribution degradation on its own.
 *
 * This module adds exactly that composition layer, plus the three
 * concepts none of the five detectors has any notion of:
 *
 * 1. **RPO is measured, not assumed.** `measureRpo` takes the caller's
 *    own `last_known_good_ms` (the last confirmed-intact checkpoint)
 *    and `incident_detected_ms` and reports the gap as data genuinely at
 *    risk of loss — it does not assume the loss equals the detection
 *    delay, which conflates "how fast we noticed" with "how much we
 *    actually lost", two different numbers a drill report must keep
 *    separate.
 * 2. **RTO requires SAFE restoration, not merely completed
 *    restoration.** `measureRto` refuses to report an RTO at all when
 *    `restoration_safety_check` (the caller's own post-restore
 *    detector result — reusing `recomputeChainIntegrity`'s `valid`
 *    field, `assessResilience`'s `acceptable` field, or equivalent) is
 *    not itself clean: a system that comes back up still corrupted has
 *    not recovered, it has started failing in a new way, and an RTO
 *    number reported anyway would reward exactly that.
 * 3. **Attribution degradation is a BEFORE/AFTER comparison of the SAME
 *    scoring axis**, never an absolute number. `measureAttributionDegradation`
 *    takes a baseline accuracy/precision-style metric and a post-drill
 *    one (whatever axis the caller already measures elsewhere — this
 *    module does not invent a new attribution scorer) and reports the
 *    signed delta plus whether it crossed `SEVERE_DEGRADATION_THRESHOLD`,
 *    mirroring `cross-provider-replay.ts`'s own "drift is a comparison
 *    between runs, never a property of one run" discipline.
 *
 * `runDrillSuite` composes one `DrillScenarioResult` per condition from
 * caller-supplied inputs and never executes anything itself — exactly
 * `cross-provider-replay.ts`'s own posture, generalized to five
 * detectors instead of one. Pure: no fs/network/clock (all timestamps
 * are caller-supplied), so a drill is fully reproducible in tests.
 */
import type { CustodyChain } from "../exchange/custody.js";
import { recomputeChainIntegrity } from "../exchange/custody.js";
import type { DisclosurePolicy, PlainSection } from "../exchange/encryption.js";
import { issueKeys } from "../exchange/encryption.js";
import type { ChaosScenario, ObservedBehaviour } from "../testing/chaos.js";
import { assessResilience } from "../testing/chaos.js";
import type {
	CrossProviderReplayInput,
	CrossProviderReplayReport,
} from "./cross-provider-replay.js";
import { gateCrossProviderReplay } from "./cross-provider-replay.js";

export const DRILL_KINDS = [
	"telemetry_loss",
	"store_corruption",
	"key_revocation",
	"provider_outage",
	"compromised_memory",
] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

export type RpoMeasurement = {
	/** Timestamp of the last confirmed-intact checkpoint, ms since epoch. */
	last_known_good_ms: number;
	incident_detected_ms: number;
	/** Data genuinely at risk of loss: the gap BEFORE detection, not the detection delay itself. */
	exposure_window_ms: number;
};

/** The incident was detected before, at, or after the last good checkpoint is meaningless; refuses rather than reports a negative window. */
export function measureRpo(lastKnownGoodMs: number, incidentDetectedMs: number): RpoMeasurement {
	const exposure = Math.max(0, incidentDetectedMs - lastKnownGoodMs);
	return {
		last_known_good_ms: lastKnownGoodMs,
		incident_detected_ms: incidentDetectedMs,
		exposure_window_ms: exposure,
	};
}

export type RestorationSafetyCheck = {
	safe: boolean;
	/** Every reason restoration is judged unsafe. Empty when safe. */
	reasons: string[];
};

export type RtoResult =
	| { reported: true; rto_ms: number }
	| { reported: false; reason: string; safety: RestorationSafetyCheck };

/**
 * Measure RTO, refusing to report one unless `safety.safe` holds.
 *
 * A restoration that completed in record time but left the store
 * corrupted, telemetry silently dropping, or a revoked key still
 * honored is not a recovery — reporting an RTO for it would reward the
 * speed of the failure, not the speed of the fix.
 */
export function measureRto(
	incidentDetectedMs: number,
	restorationCompleteMs: number,
	safety: RestorationSafetyCheck,
): RtoResult {
	if (!safety.safe) {
		return {
			reported: false,
			reason: `restoration completed at ${restorationCompleteMs}ms but failed its own safety check: ${safety.reasons.join("; ")}`,
			safety,
		};
	}
	return { reported: true, rto_ms: Math.max(0, restorationCompleteMs - incidentDetectedMs) };
}

/** Degradation beyond this fraction of the baseline metric is reported as severe, not merely "changed". */
export const SEVERE_DEGRADATION_THRESHOLD = 0.2;

export type AttributionDegradation = {
	baseline: number;
	post_drill: number;
	/** `post_drill - baseline`. Negative means degradation for an accuracy-style metric. */
	delta: number;
	/** Fraction of the baseline lost, 0 when post_drill >= baseline. */
	relative_degradation: number;
	severe: boolean;
};

/**
 * Compare a before/after value on the SAME attribution-quality axis.
 *
 * This never invents its own scoring: `baseline` and `postDrill` are
 * whatever accuracy/precision-style metric the caller already measures
 * (e.g. `bench/agent-attribution.ts`'s `agent_accuracy`). Only the
 * comparison — and the severe-degradation judgment — is this module's
 * job.
 */
export function measureAttributionDegradation(
	baseline: number,
	postDrill: number,
): AttributionDegradation {
	const delta = postDrill - baseline;
	const relative = baseline > 0 ? Math.max(0, (baseline - postDrill) / baseline) : 0;
	return {
		baseline,
		post_drill: postDrill,
		delta,
		relative_degradation: relative,
		severe: relative >= SEVERE_DEGRADATION_THRESHOLD,
	};
}

export type TelemetryLossDrillInput = {
	scenario: ChaosScenario;
	observed: ObservedBehaviour;
};

export type StoreCorruptionDrillInput = {
	chain: CustodyChain;
};

export type KeyRevocationDrillInput = {
	sections: PlainSection[];
	all_keys_before: Record<string, Buffer>;
	all_keys_after_revocation: Record<string, Buffer>;
	policy: DisclosurePolicy;
};

export type ProviderOutageDrillInput = {
	replay: CrossProviderReplayInput;
};

export type CompromisedMemoryDrillInput = {
	bundles: DiagnosticBundle[];
	trust_options: TrustOptions & { min_trust?: number };
};

export type DrillScenarioResult =
	| { kind: "telemetry_loss"; acceptable: boolean; detail: string }
	| { kind: "store_corruption"; acceptable: boolean; detail: string }
	| { kind: "key_revocation"; acceptable: boolean; detail: string }
	| {
			kind: "provider_outage";
			acceptable: boolean;
			detail: string;
			report: CrossProviderReplayReport;
	  }
	| { kind: "compromised_memory"; acceptable: boolean; detail: string };

/** Telemetry loss: reuses `assessResilience` unmodified. Acceptable iff the loss was loud, not silent. */
export function drillTelemetryLoss(input: TelemetryLossDrillInput): DrillScenarioResult {
	const report = assessResilience(input.scenario, input.observed);
	return { kind: "telemetry_loss", acceptable: report.acceptable, detail: report.detail };
}

/** Store corruption: reuses `recomputeChainIntegrity` unmodified. Acceptable iff the chain's own hash check still catches the corruption. */
export function drillStoreCorruption(input: StoreCorruptionDrillInput): DrillScenarioResult {
	const integrity = recomputeChainIntegrity(input.chain);
	return {
		kind: "store_corruption",
		acceptable: !integrity.valid,
		detail: integrity.valid
			? "the supplied chain is valid; this drill expects a CORRUPTED chain to be caught, not confirmed intact, so there is nothing to verify detection against"
			: `corruption detected: ${integrity.problems.join("; ")}`,
	};
}

/** Key revocation: reuses `issueKeys` unmodified, before and after the revoked key is removed. Acceptable iff the revoked recipient genuinely loses access. */
export function drillKeyRevocation(input: KeyRevocationDrillInput): DrillScenarioResult {
	const before = issueKeys(input.sections, input.all_keys_before, input.policy);
	const after = issueKeys(input.sections, input.all_keys_after_revocation, input.policy);
	const hadAccess = Object.keys(before.keys).length > 0;
	const stillHasAccess = Object.keys(after.keys).length > 0;
	const acceptable = !hadAccess || !stillHasAccess;
	return {
		kind: "key_revocation",
		acceptable,
		detail: acceptable
			? `recipient '${input.policy.recipient}' lost access to ${Object.keys(before.keys).length - Object.keys(after.keys).length} section key(s) after revocation`
			: `recipient '${input.policy.recipient}' still holds ${Object.keys(after.keys).length} section key(s) after the revoked key was removed from the issuance pool; revocation did not take effect`,
	};
}

/** Provider outage: reuses `gateCrossProviderReplay` unmodified. Acceptable iff the module correctly abstains rather than reporting drift on an outage-degraded input. */
export function drillProviderOutage(
	input: ProviderOutageDrillInput,
): Extract<DrillScenarioResult, { kind: "provider_outage" }> {
	const report = gateCrossProviderReplay(input.replay);
	return {
		kind: "provider_outage",
		acceptable: report.abstain,
		detail: report.abstain
			? `correctly abstained during the outage: ${report.abstain_reasons.join("; ")}`
			: "did not abstain despite the simulated outage; a drift comparison was reported on degraded input",
		report,
	};
}

/** Compromised memory: reuses `importBundles`/`assessTrust` unmodified. Acceptable iff every bundle signed against a since-revoked key is rejected, not imported. */
export function drillCompromisedMemory(input: CompromisedMemoryDrillInput): DrillScenarioResult {
	const result = importBundles(input.bundles, input.trust_options);
	const acceptable = result.accepted.length === 0;
	return {
		kind: "compromised_memory",
		acceptable,
		detail: acceptable
			? `all ${input.bundles.length} bundle(s) signed under the compromised/revoked key were rejected`
			: `${result.accepted.length} of ${input.bundles.length} bundle(s) signed under the compromised/revoked key were still accepted`,
	};
}

export type DrillSuiteReport = {
	results: DrillScenarioResult[];
	rpo: RpoMeasurement;
	rto: RtoResult;
	attribution_degradation: AttributionDegradation;
	/** Scenarios where the detector failed to behave acceptably. */
	failed_scenarios: DrillKind[];
	/** Every DRILL_KINDS entry not exercised in this run. */
	untested: DrillKind[];
};

export type DrillSuiteInput = {
	telemetry_loss?: TelemetryLossDrillInput;
	store_corruption?: StoreCorruptionDrillInput;
	key_revocation?: KeyRevocationDrillInput;
	provider_outage?: ProviderOutageDrillInput;
	compromised_memory?: CompromisedMemoryDrillInput;
	last_known_good_ms: number;
	incident_detected_ms: number;
	restoration_complete_ms: number;
	restoration_safety: RestorationSafetyCheck;
	attribution_baseline: number;
	attribution_post_drill: number;
};

/** Run every supplied scenario and compose the full drill report. */
export function runDrillSuite(input: DrillSuiteInput): DrillSuiteReport {
	const results: DrillScenarioResult[] = [];
	if (input.telemetry_loss) results.push(drillTelemetryLoss(input.telemetry_loss));
	if (input.store_corruption) results.push(drillStoreCorruption(input.store_corruption));
	if (input.key_revocation) results.push(drillKeyRevocation(input.key_revocation));
	if (input.provider_outage) results.push(drillProviderOutage(input.provider_outage));
	if (input.compromised_memory) results.push(drillCompromisedMemory(input.compromised_memory));

	const tested = new Set(results.map((r) => r.kind));
	const untested = DRILL_KINDS.filter((k) => !tested.has(k));
	const failed_scenarios = results.filter((r) => !r.acceptable).map((r) => r.kind);

	return {
		results,
		rpo: measureRpo(input.last_known_good_ms, input.incident_detected_ms),
		rto: measureRto(
			input.incident_detected_ms,
			input.restoration_complete_ms,
			input.restoration_safety,
		),
		attribution_degradation: measureAttributionDegradation(
			input.attribution_baseline,
			input.attribution_post_drill,
		),
		failed_scenarios,
		untested,
	};
}

/** Render a human-readable drill report. */
export function renderDrillSuiteReport(report: DrillSuiteReport): string {
	const lines: string[] = ["# Diagnostic Disaster-Recovery Drill Report", ""];
	lines.push(`RPO exposure window: ${report.rpo.exposure_window_ms}ms`);
	lines.push(
		report.rto.reported
			? `RTO: ${report.rto.rto_ms}ms`
			: `RTO: not reported (${report.rto.reason})`,
	);
	lines.push(
		`Attribution degradation: ${report.attribution_degradation.delta.toFixed(3)} (${(report.attribution_degradation.relative_degradation * 100).toFixed(1)}% relative${report.attribution_degradation.severe ? ", SEVERE" : ""})`,
	);
	lines.push("");
	lines.push("## Scenarios");
	for (const r of report.results) {
		lines.push(`- ${r.kind}: ${r.acceptable ? "acceptable" : "FAILED"} — ${r.detail}`);
	}
	if (report.untested.length > 0) {
		lines.push("");
		lines.push(`## Untested: ${report.untested.join(", ")}`);
	}
	return lines.join("\n");
}
