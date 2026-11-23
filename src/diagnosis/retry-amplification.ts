/**
 * Trace retry-induced fault persistence and amplification (item 58,
 * module-header numbering: item 123, confirmed next-free via `grep
 * -rohE "item [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u |
 * tail`, highest prior being item 122 from item 57's
 * `workflow-executor-attribution.ts`).
 *
 * `causal-graph.ts` (item 38) already models a `retry` node kind and a
 * `retry_of` edge type and already computes `downstream_failures`
 * (blast radius) per root cause, but it ranks root causes WITHIN one
 * graph snapshot — it never compares the SAME root cause's signature or
 * blast radius ACROSS a sequence of retry attempts of the same failing
 * operation. `incident-clustering.ts` (item 71) already defines a
 * normalized `causalSignature` built from cause category, blamed
 * component, causal path, and successful-intervention outcomes — and
 * already refuses to count a recurring signature as independent
 * incidents, clustering by signature instead of by raw message — but
 * it clusters incidents that are SEPARATE in time across a whole
 * corpus; it has no notion of "attempt 1, attempt 2, attempt 3 of the
 * SAME retry loop" or of blast radius growing between them.
 * `grep -rln "retry.induced|blind.replication|cascade.radius" src
 * --include="*.ts" -i` before this module returned nothing.
 *
 * This module is the missing before/after comparison across one retry
 * loop's own attempts, reusing both prior pieces of evidence
 * unmodified:
 *
 * - `causalSignature` (from `incident-clustering.ts`, item 71,
 *   UNMODIFIED) is computed per attempt from the `Incident` shape the
 *   caller already has one diagnosis for.
 * - `blast_radius` is the caller-supplied `downstream_failures` count
 *   `causal-graph.ts`'s (item 38) `rankRootCauses` already produces per
 *   attempt — this module does not rebuild a causal graph, it only
 *   compares the numbers across consecutive attempts.
 *
 * Two independently-reportable finding kinds, read off CONSECUTIVE
 * attempt pairs only (sequence N vs. sequence N+1), because a retry is
 * a response to the immediately preceding attempt, not to the first
 * one ever recorded:
 *
 * - `blind_replication`: two consecutive attempts share the identical
 *   normalized causal signature. The retry did not change the
 *   mechanism of failure at all — it reproduced the SAME fault, not a
 *   new occurrence of a similar-looking one. This is the hazard the
 *   item names directly: "avoid counting repeated symptoms as
 *   independent root causes." The report therefore ALSO exposes
 *   `naive_root_cause_count` (one per attempt, the wrong count a
 *   system that treats every retry as a fresh incident would report)
 *   alongside `corrected_root_cause_count` (the count of DISTINCT
 *   causal signatures across the whole sequence) so the deflation is
 *   visible, not just asserted.
 * - `cascade_amplification`: the blast radius strictly increased from
 *   one attempt to the next — the retry did not just fail again, it
 *   failed WORSE, touching more downstream nodes than the attempt
 *   before it. This is reported even when the causal signature also
 *   changed between the two attempts (a retry can both widen the
 *   blast radius AND shift mechanism, e.g. a timeout retry that now
 *   also trips a downstream rate limiter) — the two finding kinds are
 *   independent axes, not alternatives, mirroring this project's
 *   general discipline of reporting each distinct fact once rather
 *   than collapsing axes into a single label.
 *
 * Fewer than `MIN_ATTEMPTS_TO_COMPARE` = 2 attempts cannot support a
 * before/after comparison at all — there is no "after a retry" with
 * only one attempt — and the report abstains (`confidence:
 * "abstained"`) rather than reporting zero findings, which would look
 * identical to "we checked and found nothing" and is not the same
 * statement as "we could not check."
 *
 * Pure: no fs/network/process. Caller supplies every `RetryAttempt`;
 * this module never discovers or replays attempts itself.
 */
import { type Incident, causalSignature } from "./incident-clustering.js";

export const MIN_ATTEMPTS_TO_COMPARE = 2;

export type RetryAttempt = {
	attempt_id: string;
	/** Monotonic order within one retry loop; 0 is conventionally the original attempt. */
	sequence: number;
	/** The diagnosed incident for this specific attempt. */
	incident: Incident;
	/** Count of distinct downstream failed nodes reachable from this attempt's root cause (causal-graph.ts's `downstream_failures`). */
	blast_radius: number;
};

export type BlindReplicationFinding = {
	kind: "blind_replication";
	from_attempt_id: string;
	to_attempt_id: string;
	causal_signature: string;
	detail: string;
};

export type CascadeAmplificationFinding = {
	kind: "cascade_amplification";
	from_attempt_id: string;
	to_attempt_id: string;
	from_blast_radius: number;
	to_blast_radius: number;
	detail: string;
};

export type RetryFinding = BlindReplicationFinding | CascadeAmplificationFinding;

export type RetryPersistenceReport = {
	attempts_analyzed: number;
	findings: RetryFinding[];
	/** One per attempt — the inflated count a system that treats every retry as an independent root cause would report. */
	naive_root_cause_count: number;
	/** Count of distinct causal signatures across the whole sequence — the count that does not double-count a persisting fault. */
	corrected_root_cause_count: number;
	distinct_causal_signatures: string[];
	confidence: "full" | "abstained";
	reasons: string[];
};

/**
 * Compare causal signatures and blast radii across consecutive attempts
 * of one retry loop, reporting blind replication (identical mechanism
 * recurring) and cascade amplification (growing blast radius), and
 * deflating the naive per-attempt root-cause count to a corrected
 * distinct-signature count.
 */
export function diagnoseRetryPersistence(attempts: RetryAttempt[]): RetryPersistenceReport {
	const sorted = [...attempts].sort((a, b) => a.sequence - b.sequence);

	if (sorted.length < MIN_ATTEMPTS_TO_COMPARE) {
		return {
			attempts_analyzed: sorted.length,
			findings: [],
			naive_root_cause_count: sorted.length,
			corrected_root_cause_count: sorted.length,
			distinct_causal_signatures: sorted.map((a) => causalSignature(a.incident)),
			confidence: "abstained",
			reasons: [
				`only ${sorted.length} attempt(s) supplied; at least ${MIN_ATTEMPTS_TO_COMPARE} are required to compare "before and after a retry" at all`,
			],
		};
	}

	const signatures = sorted.map((a) => causalSignature(a.incident));
	const findings: RetryFinding[] = [];

	for (let i = 0; i < sorted.length - 1; i++) {
		const from = sorted[i];
		const to = sorted[i + 1];
		const fromSig = signatures[i];
		const toSig = signatures[i + 1];

		if (fromSig === toSig) {
			findings.push({
				kind: "blind_replication",
				from_attempt_id: from.attempt_id,
				to_attempt_id: to.attempt_id,
				causal_signature: fromSig,
				detail: `attempt '${to.attempt_id}' shares the identical causal signature with the preceding attempt '${from.attempt_id}': the retry reproduced the same fault mechanism rather than encountering a new one`,
			});
		}

		if (to.blast_radius > from.blast_radius) {
			findings.push({
				kind: "cascade_amplification",
				from_attempt_id: from.attempt_id,
				to_attempt_id: to.attempt_id,
				from_blast_radius: from.blast_radius,
				to_blast_radius: to.blast_radius,
				detail: `blast radius grew from ${from.blast_radius} to ${to.blast_radius} downstream failed node(s) between attempt '${from.attempt_id}' and '${to.attempt_id}': the retry widened the cascade instead of containing it`,
			});
		}
	}

	const distinctSignatures = [...new Set(signatures)].sort();

	const reasons: string[] = [
		`${sorted.length} attempts analyzed across ${distinctSignatures.length} distinct causal signature(s)`,
	];
	const blindCount = findings.filter((f) => f.kind === "blind_replication").length;
	if (blindCount > 0) {
		reasons.push(
			`${blindCount} consecutive attempt pair(s) blindly replicated the same fault; naive_root_cause_count (${sorted.length}) overcounts by treating each as independent, corrected_root_cause_count (${distinctSignatures.length}) does not`,
		);
	}
	const cascadeCount = findings.filter((f) => f.kind === "cascade_amplification").length;
	if (cascadeCount > 0) {
		reasons.push(`${cascadeCount} consecutive attempt pair(s) show an expanding cascade radius`);
	}

	return {
		attempts_analyzed: sorted.length,
		findings,
		naive_root_cause_count: sorted.length,
		corrected_root_cause_count: distinctSignatures.length,
		distinct_causal_signatures: distinctSignatures,
		confidence: "full",
		reasons,
	};
}

/** Render a human-readable retry-persistence report. */
export function renderRetryPersistenceReport(report: RetryPersistenceReport): string {
	const lines: string[] = [
		"# Retry Persistence & Amplification Report",
		`attempts_analyzed: ${report.attempts_analyzed}`,
		`confidence: ${report.confidence}`,
		`naive_root_cause_count: ${report.naive_root_cause_count}`,
		`corrected_root_cause_count: ${report.corrected_root_cause_count}`,
		"",
	];
	for (const reason of report.reasons) {
		lines.push(`- ${reason}`);
	}
	if (report.findings.length > 0) {
		lines.push("", "## Findings");
		for (const finding of report.findings) {
			lines.push(`- [${finding.kind}] ${finding.detail}`);
		}
	}
	return lines.join("\n");
}
