/**
 * Diagnose latent faults with paired controls (item 56, module-header
 * numbering: item 121, confirmed next-free via `grep -rohE "item [0-9]+"
 * src --include="*.ts" | sort -t' ' -k2 -n -u | tail`, highest prior
 * being item 120 from item 55's `trusted-state-contamination.ts`).
 *
 * `trajectory-diff.ts` (item 69) already aligns a failing trajectory
 * against one or more healthy baselines by step *signature* — tool name,
 * argument *shape*, and coarse outcome (`ok`/`error`) — and already
 * refuses to call a shared difference discriminating without
 * `MIN_BASELINES` references. That comparison is deliberately coarse: it
 * treats two steps as a `match` whenever their action, argument shape,
 * and ok/error outcome agree, by design (comparing rendered text instead
 * would make two reads of different files look different and a read that
 * silently returned stale cached data look identical to a fresh one —
 * backwards for ordinary step-level drift). This item names the opposite
 * failure mode: three fault kinds that are latent PRECISELY BECAUSE they
 * hide inside a step that `trajectory-diff.ts`'s own signature already
 * calls a `match` — same action, same shape, same `ok` outcome, and
 * therefore invisible to it by construction, not because that module is
 * wrong but because it is answering a different, coarser question.
 *
 * `grep -rln "paired.control|no.fault.reference|semantic.corruption|
 * guardrail.bypass|ambiguous.delegation|latent.fault" src --include=
 * "*.ts" -i` before this module matched only `bench/agentchaosbench.ts`
 * (item 99), which SCORES a detector's prediction of these fault types
 * against a labeled corpus but never DETECTS them from raw step
 * evidence itself — a different job, matching this project's own
 * labeled-corpus/live-detector division of labor
 * (`agentchaosbench.ts`'s own docstring names this same split for
 * `fault-localization.ts`).
 *
 * This module reuses `trajectory-diff.ts`'s `align` and `stepSignature`
 * UNMODIFIED to find the `match` pairs between a failing trace and
 * exactly ONE paired no-fault reference (a "paired control": the SAME
 * task, known to have completed without the fault class this module
 * looks for — not a statistical baseline population, the role
 * `trajectory-diff.ts`'s multi-baseline noise-floor already fills).
 * Only `match` pairs are inspected further — `substitute`/`insert`/
 * `delete` pairs are already a difference `trajectory-diff.ts` itself
 * would report, and re-flagging them here under a different name would
 * be the same evidence wearing two labels. Three independently-reportable
 * finding kinds, each compares an EXTRA evidence field `TrajectoryStep`
 * does not carry (because ordinary step-shape diffing has no use for
 * it), present only on `PairedControlStep`:
 *
 * - `semantic_corruption`: both steps carry a `result_fingerprint` (an
 *   opaque content digest of what the step actually returned, never the
 *   raw value itself — this module's own instance of this project's
 *   "redact the payload, keep the fact" discipline, e.g.
 *   `oauth-misbinding.ts`'s opaque `token_ref`) and they differ, despite
 *   the step's action/shape/outcome signature matching. This is the
 *   textbook case the item names: a tool call that silently returned
 *   stale cached data instead of a fresh result looks identical to
 *   `trajectory-diff.ts` (same action, same shape, same `ok`) and is
 *   only visible by comparing what was actually returned.
 * - `guardrail_bypass`: the control step's `guardrail_decision` recorded
 *   an enforcement determination of `block` or `warn` for this step, but
 *   the failing step's `guardrail_decision` is either absent or recorded
 *   `allow` — the exact hazard `agentchaosbench.ts` already names for
 *   SCORING ("a detector that reports `none` whenever no exception
 *   surfaced... scores every guardrail bypass as a true negative"),
 *   applied here to DETECTION: the step's outward action/outcome can
 *   still look like an ordinary successful `match`, which is exactly
 *   why it needs its own finding kind rather than relying on
 *   `changed_outcome` to ever catch it.
 * - `ambiguous_delegation`: the control step names a `delegate_actor_id`
 *   (clear, recorded evidence of which agent actually acted at a
 *   delegation point) but the failing step's own `delegate_actor_id` is
 *   absent — the failing run's telemetry never recorded who actually
 *   took the action the reference shows was a delegation point at all,
 *   which "same action, same outcome" surface telemetry has no way to
 *   surface on its own.
 *
 * **Abstention, not a guess, is the default for everything else.** A
 * `match` pair missing the relevant evidence field on EITHER side is not
 * silently skipped as "no finding" — it is named in `abstained_steps`
 * with the specific missing field, mirroring `authorization-drift.ts`'s
 * (item 44) `lost_policy_source` and `mcp-subscription.ts`'s (item 52)
 * `transport_uncertain_subscriptions` discipline of giving "cannot tell"
 * its own bucket. And when the alignment between failing and control
 * produces ZERO `match` pairs at all — the two traces share no
 * comparable branch whatsoever — `diagnoseLatentFaults` reports
 * `confidence: "abstained"` for the WHOLE report rather than returning
 * an empty, falsely-clean finding list; `confidence: "reduced"` when
 * some match pairs had to abstain but at least one finding kind was
 * fully evaluable; `confidence: "full"` only when every match pair
 * carried the evidence needed for every applicable check.
 *
 * Pure: no fs/network/process. Reuses `trajectory-diff.ts`'s `align`/
 * `stepSignature` UNMODIFIED; this module never re-implements alignment.
 */
import { type Trajectory, type TrajectoryStep, align, stepSignature } from "./trajectory-diff.js";

export type GuardrailDecision = {
	guardrail_id: string;
	decision: "allow" | "block" | "warn";
};

export type PairedControlStep = TrajectoryStep & {
	/** Opaque content digest of what this step actually returned. NEVER the raw returned value. */
	result_fingerprint?: string;
	guardrail_decision?: GuardrailDecision;
	/** The actor id that actually acted, when this step is a delegation point. */
	delegate_actor_id?: string;
};

export type PairedControlTrajectory = Trajectory & {
	steps: PairedControlStep[];
};

export const LATENT_FAULT_KINDS = [
	"semantic_corruption",
	"guardrail_bypass",
	"ambiguous_delegation",
] as const;
export type LatentFaultKind = (typeof LATENT_FAULT_KINDS)[number];

export type LatentFaultFinding = {
	kind: LatentFaultKind;
	at_failing_index: number;
	detail: string;
};

export type AbstainedStep = {
	at_failing_index: number;
	reason: string;
};

export type LatentFaultReport = {
	failing_id: string;
	control_id: string;
	findings: LatentFaultFinding[];
	abstained_steps: AbstainedStep[];
	/** The earliest finding by `at_failing_index`, naming where the chain first broke. `undefined` when there are none. */
	first_finding?: LatentFaultFinding;
	confidence: "full" | "reduced" | "abstained";
};

function checkSemanticCorruption(
	failing: PairedControlStep,
	control: PairedControlStep,
	index: number,
): { finding: LatentFaultFinding | null; abstained: AbstainedStep | null } {
	if (failing.result_fingerprint === undefined || control.result_fingerprint === undefined) {
		return {
			finding: null,
			abstained: {
				at_failing_index: index,
				reason: `step '${failing.action}' is missing a result_fingerprint on ${failing.result_fingerprint === undefined ? "the failing side" : "the control side"}; semantic corruption cannot be evaluated for this step`,
			},
		};
	}
	if (failing.result_fingerprint !== control.result_fingerprint) {
		return {
			finding: {
				kind: "semantic_corruption",
				at_failing_index: index,
				detail: `step '${failing.action}' matches the control run's action/shape/outcome, but its actual returned content (fingerprint '${failing.result_fingerprint}') differs from the control's (fingerprint '${control.result_fingerprint}') — invisible to a signature-level comparison`,
			},
			abstained: null,
		};
	}
	return { finding: null, abstained: null };
}

function checkGuardrailBypass(
	failing: PairedControlStep,
	control: PairedControlStep,
	index: number,
): LatentFaultFinding | null {
	if (!control.guardrail_decision) return null;
	if (control.guardrail_decision.decision === "allow") return null;
	const failingDecision = failing.guardrail_decision?.decision ?? "allow";
	if (failingDecision === "allow") {
		return {
			kind: "guardrail_bypass",
			at_failing_index: index,
			detail: `the control run's guardrail '${control.guardrail_decision.guardrail_id}' recorded a '${control.guardrail_decision.decision}' decision for step '${control.action}', but the failing run recorded ${failing.guardrail_decision ? `an 'allow' decision` : "no guardrail decision at all"} for the same step — the step's outward action/outcome still looks like an ordinary successful match`,
		};
	}
	return null;
}

function checkAmbiguousDelegation(
	failing: PairedControlStep,
	control: PairedControlStep,
	index: number,
): LatentFaultFinding | null {
	if (control.delegate_actor_id === undefined) return null;
	if (failing.delegate_actor_id === undefined) {
		return {
			kind: "ambiguous_delegation",
			at_failing_index: index,
			detail: `the control run recorded delegate '${control.delegate_actor_id}' for step '${control.action}', a delegation point, but the failing run's telemetry never recorded who actually acted at the same step`,
		};
	}
	return null;
}

/**
 * Diagnose latent faults by comparing a failing trajectory against
 * exactly one paired no-fault reference. Only `match`-aligned pairs
 * (same action/shape/outcome signature) are inspected; non-`match`
 * pairs are left to `trajectory-diff.ts`, which already reports them.
 */
export function diagnoseLatentFaults(
	failing: PairedControlTrajectory,
	control: PairedControlTrajectory,
): LatentFaultReport {
	const alignment = align(failing.steps.map(stepSignature), control.steps.map(stepSignature));
	const matchPairs = alignment.filter((p) => p.op === "match");

	const findings: LatentFaultFinding[] = [];
	const abstainedSteps: AbstainedStep[] = [];
	let anyEvaluated = false;

	for (const pair of matchPairs) {
		const index = pair.failing_index as number;
		const failingStep = failing.steps[index];
		const controlStep = control.steps[pair.healthy_index as number];

		const { finding: corruption, abstained } = checkSemanticCorruption(
			failingStep,
			controlStep,
			index,
		);
		if (corruption) {
			findings.push(corruption);
			anyEvaluated = true;
		} else if (abstained) {
			abstainedSteps.push(abstained);
		} else {
			anyEvaluated = true;
		}

		const bypass = checkGuardrailBypass(failingStep, controlStep, index);
		if (bypass) findings.push(bypass);

		const ambiguous = checkAmbiguousDelegation(failingStep, controlStep, index);
		if (ambiguous) findings.push(ambiguous);
	}

	findings.sort((a, b) => a.at_failing_index - b.at_failing_index);

	let confidence: LatentFaultReport["confidence"];
	if (matchPairs.length === 0) {
		confidence = "abstained";
	} else if (abstainedSteps.length > 0 && !anyEvaluated) {
		confidence = "abstained";
	} else if (abstainedSteps.length > 0) {
		confidence = "reduced";
	} else {
		confidence = "full";
	}

	return {
		failing_id: failing.id,
		control_id: control.id,
		findings,
		abstained_steps: abstainedSteps,
		...(findings.length > 0 ? { first_finding: findings[0] } : {}),
		confidence,
	};
}

/** Render a human-readable latent-fault paired-control report. */
export function renderLatentFaultReport(report: LatentFaultReport): string {
	const lines: string[] = [
		`# Latent Fault Report — '${report.failing_id}' vs. paired control '${report.control_id}'`,
		`confidence: ${report.confidence}`,
		"",
	];
	if (report.confidence === "abstained" && report.findings.length === 0) {
		lines.push(
			"No comparable branch (no match-aligned steps) was found between the failing trace and the paired control; nothing can be said.",
		);
		return lines.join("\n");
	}
	if (report.findings.length === 0) {
		lines.push("No latent faults found in the comparable steps.");
	} else {
		for (const f of report.findings) {
			lines.push(`- [${f.kind}] at failing step ${f.at_failing_index}: ${f.detail}`);
		}
	}
	for (const a of report.abstained_steps) {
		lines.push(`- ABSTAINED at failing step ${a.at_failing_index}: ${a.reason}`);
	}
	return lines.join("\n");
}
