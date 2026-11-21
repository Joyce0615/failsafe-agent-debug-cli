/**
 * Validate runtime security patches by replaying exploit-relevant fixtures
 * against vulnerable and patched dependency matrices (item 48,
 * module-header numbering: item 114, confirmed next-free via `grep -rohE
 * "item [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u`, highest
 * prior being item 113 from item 47's `async-lifecycle-race.ts`).
 *
 * `security/advisories.ts` (item 37/103) already answers "is a component
 * exploitable here" (`assessExploitability`) and "what bounded action
 * fixes it" (`proposeAdvisoryRecovery`) — both reused UNMODIFIED. Neither
 * EXECUTES anything: an `exploitable` status is a reachability judgment
 * from declared attack-vector/exposure facts, never a live replay of the
 * actual exploit against the actual dependency. `grep -rln "exploit.*
 * replay\|replay.*exploit\|vulnerable.*matrix\|patched.*matrix\|
 * mitigation.*verif" src --include="*.ts"` returned nothing before this
 * module — the gap this item names (did the patch ACTUALLY mitigate the
 * exploit, confirmed by running it, not merely inferred from a version
 * number) had no module at all.
 *
 * `repro/counterfactual.ts` (item 55) already solved the adjacent problem
 * — "did a patch causally fix a FUNCTIONAL failure" — with a multi-arm
 * control matrix behind an injected `ArmRunner` seam that keeps this
 * module execution-free and its tests subprocess-free. This module reuses
 * that SAME seam shape (a `MatrixRunner` callback, same signature
 * discipline) rather than inventing a parallel execution mechanism, but
 * the matrix itself is a different shape from `counterfactual.ts`'s four
 * fixed arms, because the question is different: not "pass vs fail
 * before/after a code patch" but "does the exploit fixture succeed
 * against the VULNERABLE dependency version and fail against the PATCHED
 * one" — two arms, `vulnerable` and `patched`, each run against the SAME
 * exploit fixture.
 *
 * Verdicts, each a distinct fact rather than folded into one score:
 *
 * - `mitigated`: the exploit succeeded on `vulnerable` and failed on
 *   `patched`, consistently across every repeat. This is the ONLY verdict
 *   that licenses `proposeAdvisoryRecovery`'s `upgrade` action to actually
 *   be applied with confidence — a patched_version string from an
 *   advisory feed is a claim; `mitigated` is confirmation.
 * - `not_mitigated`: the exploit ALSO succeeds on `patched`. This is the
 *   most consequential verdict this module can produce — a vendor-
 *   declared fix that does not actually stop the exploit — and it refuses
 *   to recommend the `upgrade` action `proposeAdvisoryRecovery` would
 *   otherwise propose, redirecting to isolation instead, mirroring
 *   `advisories.ts`'s own refusal to propose an upgrade it cannot back.
 * - `exploit_ineffective`: the exploit fails on `vulnerable` TOO. The
 *   fixture itself is not reproducing the vulnerability (a stale PoC, a
 *   wrong target, an already-neutralizing environment), so NEITHER arm's
 *   result is evidence about the patch — reported as its own verdict
 *   rather than silently counted as `mitigated` (which would be claiming
 *   credit the patch never earned).
 * - `inconsistent`: either arm produced BOTH outcomes across repeats
 *   (flaky exploit or flaky mitigation) — never resolved by majority
 *   vote, mirroring `counterfactual.ts`'s own `stability: "inconsistent"`
 *   refusal to average away a disagreement.
 * - `insufficient_repeats`: below `MIN_MATRIX_REPEATS`, mirroring
 *   `counterfactual.ts`'s `MIN_REPEATS` — one run per arm cannot
 *   distinguish "always" from "happened once".
 * - `harness_error`: any run `error`'d (the fixture itself failed to
 *   execute, not failed to exploit) — never treated as a verdict about
 *   the vulnerability.
 *
 * `decideExceptionOrUpgrade` is this module's own answer to the item's
 * "produce evidence for upgrade, isolation, or exception decisions"
 * clause: `mitigated` recommends applying `proposeAdvisoryRecovery`'s
 * already-proposed `upgrade` action as now CONFIRMED; `not_mitigated`
 * recommends isolation (the patch cannot be trusted, same as having no
 * patch); `exploit_ineffective`/`inconsistent`/`insufficient_repeats`/
 * `harness_error` all recommend an EXCEPTION — explicitly refusing to
 * decide upgrade-vs-isolate on evidence this module itself does not trust,
 * the same "refuse to guess" posture `counterfactual.ts`'s
 * `insufficient_repeats` and `advisories.ts`'s `vulnerable_not_exploitable`
 * already established.
 *
 * Pure: execution happens behind the injected `MatrixRunner` seam; this
 * module contains no process spawning and its tests contain no
 * subprocesses.
 */
import {
	type AdvisoryRecovery,
	type ExploitabilityAssessment,
	type RecoveryAction,
	proposeAdvisoryRecovery,
} from "./advisories.js";

export const PATCH_MATRIX_ARMS = ["vulnerable", "patched"] as const;
export type PatchMatrixArm = (typeof PATCH_MATRIX_ARMS)[number];

/** What each arm is expected to do when the exploit fixture is run against it. */
export const PATCH_ARM_EXPECTATIONS: Record<PatchMatrixArm, "exploit_succeeds" | "exploit_fails"> =
	{
		vulnerable: "exploit_succeeds",
		patched: "exploit_fails",
	};

export type ExploitOutcome = "exploit_succeeded" | "exploit_failed" | "error";

export type MatrixRun = {
	outcome: ExploitOutcome;
	duration_ms?: number;
	/** Harness detail; only meaningful for `error`. */
	detail?: string;
};

/** Executes one repetition of one arm's exploit fixture. Injected so this module stays pure. */
export type MatrixRunner = (arm: PatchMatrixArm, attempt: number) => Promise<MatrixRun> | MatrixRun;

/** Below this, flakiness in the exploit or the mitigation is invisible. Mirrors `counterfactual.ts`'s `MIN_REPEATS`. */
export const MIN_MATRIX_REPEATS = 3;
export const DEFAULT_MATRIX_REPEATS = 3;

export type ArmSummary = {
	arm: PatchMatrixArm;
	expected: "exploit_succeeds" | "exploit_fails";
	runs: MatrixRun[];
	as_expected: number;
	contrary: number;
	errors: number;
	stability: "consistent" | "inconsistent" | "errored";
	satisfied: boolean;
};

function summarizeArm(arm: PatchMatrixArm, runs: MatrixRun[]): ArmSummary {
	const expected = PATCH_ARM_EXPECTATIONS[arm];
	const errors = runs.filter((r) => r.outcome === "error").length;
	const succeeded = runs.filter((r) => r.outcome === "exploit_succeeded").length;
	const failed = runs.filter((r) => r.outcome === "exploit_failed").length;
	const asExpected = expected === "exploit_succeeds" ? succeeded : failed;
	const contrary = expected === "exploit_succeeds" ? failed : succeeded;

	const stability: ArmSummary["stability"] =
		errors > 0 ? "errored" : succeeded > 0 && failed > 0 ? "inconsistent" : "consistent";

	return {
		arm,
		expected,
		runs,
		as_expected: asExpected,
		contrary,
		errors,
		stability,
		satisfied: stability === "consistent" && contrary === 0 && asExpected === runs.length,
	};
}

export const PATCH_VALIDATION_VERDICTS = [
	"mitigated",
	"not_mitigated",
	"exploit_ineffective",
	"inconsistent",
	"insufficient_repeats",
	"harness_error",
] as const;
export type PatchValidationVerdict = (typeof PATCH_VALIDATION_VERDICTS)[number];

export type PatchValidationResult = {
	verdict: PatchValidationVerdict;
	arms: ArmSummary[];
	rationale: string;
};

/**
 * Run the exploit fixture against both arms (`repeats` times each via
 * `runner`) and classify the result as exactly one verdict.
 */
export async function validatePatchAgainstExploit(
	runner: MatrixRunner,
	repeats: number = DEFAULT_MATRIX_REPEATS,
): Promise<PatchValidationResult> {
	if (repeats < MIN_MATRIX_REPEATS) {
		return {
			verdict: "insufficient_repeats",
			arms: [],
			rationale: `${repeats} repeat(s) requested, below the minimum of ${MIN_MATRIX_REPEATS}; flakiness in the exploit or the mitigation would be invisible`,
		};
	}

	const arms: ArmSummary[] = [];
	for (const arm of PATCH_MATRIX_ARMS) {
		const runs: MatrixRun[] = [];
		for (let attempt = 1; attempt <= repeats; attempt++) {
			runs.push(await runner(arm, attempt));
		}
		arms.push(summarizeArm(arm, runs));
	}

	const [vulnerable, patched] = arms;

	if (vulnerable.stability === "errored" || patched.stability === "errored") {
		const erroredArms = arms.filter((a) => a.stability === "errored").map((a) => a.arm);
		return {
			verdict: "harness_error",
			arms,
			rationale: `the harness failed to execute at least one run on arm(s) ${erroredArms.join(", ")}; a failure to RUN the exploit fixture is not evidence about the vulnerability`,
		};
	}

	if (vulnerable.stability === "inconsistent" || patched.stability === "inconsistent") {
		const inconsistentArms = arms.filter((a) => a.stability === "inconsistent").map((a) => a.arm);
		return {
			verdict: "inconsistent",
			arms,
			rationale: `arm(s) ${inconsistentArms.join(", ")} produced both outcomes across repeats; this is not resolved by majority vote`,
		};
	}

	if (!vulnerable.satisfied) {
		return {
			verdict: "exploit_ineffective",
			arms,
			rationale: `the exploit fixture did not consistently succeed against the VULNERABLE arm; the fixture itself is not reproducing the vulnerability, so neither arm's result is evidence about the patch`,
		};
	}

	if (patched.satisfied) {
		return {
			verdict: "mitigated",
			arms,
			rationale: `the exploit fixture consistently succeeded against 'vulnerable' and consistently failed against 'patched'; the patch is confirmed to mitigate this exploit`,
		};
	}

	return {
		verdict: "not_mitigated",
		arms,
		rationale: `the exploit fixture succeeded against 'vulnerable' AND against 'patched'; the declared patch does not actually stop this exploit`,
	};
}

export type PatchDecision = {
	validation: PatchValidationResult;
	/** `undefined` when the verdict licenses neither an upgrade nor an isolation action with confidence. */
	recommended_recovery?: AdvisoryRecovery;
	/** Populated whenever this module refuses to pick upgrade-vs-isolate on the available evidence. */
	exception_reason?: string;
};

/**
 * Combine a patch-validation verdict with `advisories.ts`'s own
 * exploitability assessment to decide upgrade, isolation, or exception.
 *
 * `mitigated` confirms `proposeAdvisoryRecovery`'s `upgrade` action is
 * trustworthy and passes it through unmodified. `not_mitigated` overrides
 * ANY `upgrade` action `proposeAdvisoryRecovery` proposed with an
 * isolation-only recovery (re-deriving isolation from the SAME assessment
 * via `proposeAdvisoryRecovery` on a forced non-`patched_version` basis is
 * not attempted here — this module states the override explicitly as its
 * own `exception_reason`-free recovery) — the patch failed to earn the
 * trust an upgrade recommendation requires, and running an unverified
 * patch is no safer than running no patch at all. Every other verdict
 * (`exploit_ineffective`/`inconsistent`/`insufficient_repeats`/
 * `harness_error`) recommends neither action: this module does not trust
 * its own evidence enough to pick between them, so it names an exception
 * instead of guessing.
 */
export function decideExceptionOrUpgrade(
	validation: PatchValidationResult,
	assessment: ExploitabilityAssessment,
): PatchDecision {
	if (validation.verdict === "mitigated") {
		return { validation, recommended_recovery: proposeAdvisoryRecovery(assessment) };
	}

	if (validation.verdict === "not_mitigated") {
		const baseRecovery = proposeAdvisoryRecovery(assessment);
		const isolationOnly: RecoveryAction[] = baseRecovery.actions.filter(
			(a) => a.kind === "isolate",
		);
		return {
			validation,
			recommended_recovery: {
				assessment,
				actions: isolationOnly,
				refused: [
					...baseRecovery.refused,
					`the declared patch was replayed against its own exploit fixture and did NOT mitigate it; any 'upgrade' action is withheld even though a patched_version is declared`,
				],
			},
		};
	}

	return {
		validation,
		exception_reason: `verdict '${validation.verdict}' does not license a confident upgrade-vs-isolate decision: ${validation.rationale}`,
	};
}

/** Render a human-readable summary of a patch validation + decision. */
export function renderPatchDecision(decision: PatchDecision): string {
	const lines: string[] = ["# Runtime Security Patch Validation", ""];
	lines.push(`Verdict: ${decision.validation.verdict}`);
	lines.push(decision.validation.rationale);
	lines.push("");
	for (const arm of decision.validation.arms) {
		lines.push(
			`- ${arm.arm}: expected ${arm.expected}, stability=${arm.stability}, satisfied=${arm.satisfied} (${arm.as_expected}/${arm.runs.length} as expected, ${arm.errors} error(s))`,
		);
	}
	lines.push("");
	if (decision.exception_reason) {
		lines.push(`Exception: ${decision.exception_reason}`);
	} else if (decision.recommended_recovery) {
		lines.push(
			decision.recommended_recovery.actions.length > 0
				? `Recommended action(s): ${decision.recommended_recovery.actions.map((a) => a.kind).join(", ")}`
				: "No bounded action recommended.",
		);
		for (const r of decision.recommended_recovery.refused) lines.push(`Refused: ${r}`);
	}
	return lines.join("\n");
}
