/**
 * Add replay-from-scratch recovery validation (item 38, item 104 in this
 * project's own module-header numbering convention — confirmed as the next
 * free number via `grep -rohE "item [0-9]+" src --include="*.ts" |
 * sort -t' ' -k2 -n -u`, highest prior use was item 103 from item 37's
 * `security/advisories.ts`).
 *
 * `grep -rln "provenance|replay|reproduc" src --include="*.ts"` before this
 * module matched many files, but none of them compose the specific thing
 * this item asks for: rebuild an isolated environment FROM RECORDED
 * PROVENANCE (not just re-run the same process in place), rerun the minimal
 * reproducer and remediation against that rebuild, and accept a fix ONLY
 * when the regenerated evidence matches declared criteria. `repro/
 * verifier.ts`'s `verifyRepro` already re-runs a candidate command and
 * compares signatures via `repro/signatures.ts`'s `signaturesMatch`, and
 * `diagnosis/recovery-packet.ts`'s `measureRerunImprovement` already
 * compares rerun outcomes before/after a recovery attempt — but neither
 * checks whether the environment the rerun executed in is the SAME one the
 * original failure was recorded in, and neither treats "the repro never
 * reproduced in the rebuilt environment to begin with" as its own named
 * refusal rather than folding it into a generic "did not improve".
 *
 * This item asks three separable questions, each refusing to guess rather
 * than default to pass or fail:
 *
 * 1. **Is the rebuilt environment's provenance faithful to what was
 *    recorded, on exactly the fields the caller declared load-bearing?**
 *    `compareEnvironmentProvenance` compares two `capture/env.ts`
 *    `EnvFingerprint`s field-by-field, but ONLY on the caller-supplied
 *    `requiredFields` — a `cwd` difference between the original machine
 *    and a rebuilt sandbox is expected and irrelevant, while a differing
 *    `node_version` on a Node-specific failure is exactly the drift that
 *    would make "it passed" meaningless. A required field missing from the
 *    rebuilt environment is `unknown`, a THIRD status distinct from
 *    `match`/`mismatch` — mirroring `trace/telemetry-gaps.ts`'s
 *    `confirmed_absence` vs `unknown_evidence` split, generalized here to
 *    environment fields: "we cannot tell" must never collapse into "it
 *    matched".
 *
 * 2. **Did the rebuilt environment actually reproduce the ORIGINAL failure
 *    before the fix was applied, and does it pass after?**
 *    `validateReplayFromScratch` requires BOTH `repro/verifier.ts`'s own
 *    `VerifyResult.verified` on the pre-fix rerun (reusing that module's
 *    existing signature-similarity check against the caller's declared
 *    `AcceptanceCriteria.min_signature_match` threshold, never a module-
 *    local reimplementation of the comparison) AND a clean (`verified:
 *    false`, `exit_code: 0`) post-fix rerun. Either one alone is
 *    insufficient: a rebuild that never reproduced the failure proves
 *    nothing about the fix regardless of whether the post-fix run passed
 *    (the pass could be incidental to a rebuild that never ran the
 *    relevant code at all — the exact "repro never exercised the changed
 *    code" story `repro/counterfactual.ts`'s own module doc already names
 *    as one of the four ways "tests pass now" lies), and a faithful
 *    reproduction that still fails after the fix means the fix did not
 *    work in the one environment that matters: the one actually rebuilt
 *    from recorded provenance, not the one the fix was developed in.
 *
 * 3. **Is acceptance the caller's own declared criteria, not this module's
 *    opinion?** `AcceptanceCriteria` is a plain data value the caller
 *    supplies (`required_provenance_fields`, `min_signature_match`) —
 *    tightening or loosening the bar is a caller decision made explicit in
 *    the one place it is checked, never a hardcoded threshold a future
 *    change could silently drift. `validateReplayFromScratch` refuses
 *    (returns `accepted: false` with a named reason in `refused`) on EVERY
 *    criterion it does not meet rather than stopping at the first failure,
 *    so a caller investigating a rejected replay sees every reason at
 *    once, not one at a time across repeated runs.
 *
 * Pure: no fs/network/process/clock. `EnvFingerprint`s and `VerifyResult`s
 * are supplied by the caller (typically the result of `capture/env.ts`'s
 * `captureEnvFingerprint` and `repro/verifier.ts`'s `verifyRepro`, each run
 * once against the original recording and once against the rebuilt
 * environment).
 */
import { signaturesMatch } from "../repro/signatures.js";
import type { VerifyResult } from "../repro/verifier.js";
import type { EnvFingerprint } from "../types/common.js";
import type { FailureSignature } from "../types/repro.js";

export type AcceptanceCriteria = {
	/** Fields that must match between recorded and rebuilt provenance. */
	required_provenance_fields: Array<keyof EnvFingerprint>;
	/** Minimum `repro/signatures.ts` similarity for the pre-fix rerun to count as a reproduction. */
	min_signature_match: number;
};

export type ProvenanceComparison = {
	field: keyof EnvFingerprint;
	recorded?: string;
	rebuilt?: string;
	status: "match" | "mismatch" | "unknown";
};

export type ProvenanceComparisonResult = {
	faithful: boolean;
	comparisons: ProvenanceComparison[];
	problems: string[];
};

/**
 * Compare two `EnvFingerprint`s, but only on `requiredFields`.
 *
 * A field absent from `rebuilt` is `unknown`, never `match` — the caller
 * cannot verify a field that was never recorded, and silently treating a
 * missing value as agreement would hide exactly the gap this function
 * exists to surface.
 */
export function compareEnvironmentProvenance(
	recorded: EnvFingerprint,
	rebuilt: EnvFingerprint,
	requiredFields: Array<keyof EnvFingerprint>,
): ProvenanceComparisonResult {
	const comparisons: ProvenanceComparison[] = requiredFields.map((field) => {
		const recordedValue = recorded[field];
		const rebuiltValue = rebuilt[field];
		const status: ProvenanceComparison["status"] =
			rebuiltValue === undefined
				? "unknown"
				: recordedValue === rebuiltValue
					? "match"
					: "mismatch";
		return {
			field,
			recorded: recordedValue,
			rebuilt: rebuiltValue,
			status,
		};
	});

	const problems: string[] = [];
	for (const comparison of comparisons) {
		if (comparison.status === "mismatch") {
			problems.push(
				`'${comparison.field}' differs: recorded '${comparison.recorded}', rebuilt '${comparison.rebuilt}'`,
			);
		}
		if (comparison.status === "unknown") {
			problems.push(
				`'${comparison.field}' is required but was not captured in the rebuilt environment`,
			);
		}
	}

	return { faithful: problems.length === 0, comparisons, problems };
}

export type ReplayInputs = {
	recordedEnv: EnvFingerprint;
	rebuiltEnv: EnvFingerprint;
	recordedSignature: FailureSignature;
	/** The repro, rerun in the rebuilt environment before the fix is applied. */
	preFix: VerifyResult;
	/** The repro, rerun in the rebuilt environment after the fix is applied. */
	postFix: VerifyResult;
};

export type ReplayValidationResult = {
	provenance: ProvenanceComparisonResult;
	/** Whether the rebuilt environment reproduced the original failure before the fix. */
	pre_fix_reproduced: boolean;
	pre_fix_signature_match?: number;
	/** Whether the repro passed cleanly in the rebuilt environment after the fix. */
	post_fix_passed: boolean;
	accepted: boolean;
	/** Every unmet criterion, not just the first. */
	refused: string[];
};

/**
 * Validate a replay-from-scratch recovery attempt against declared
 * acceptance criteria.
 *
 * Accepts only when ALL of: the rebuilt environment's provenance matches on
 * every required field, the pre-fix rerun reproduced the original failure
 * (verified by `repro/verifier.ts`'s own signature check, at or above
 * `criteria.min_signature_match`), and the post-fix rerun passed cleanly
 * (`verified: false`, `exit_code: 0`). Every unmet criterion is reported in
 * `refused`, not just the first.
 */
export function validateReplayFromScratch(
	inputs: ReplayInputs,
	criteria: AcceptanceCriteria,
): ReplayValidationResult {
	const provenance = compareEnvironmentProvenance(
		inputs.recordedEnv,
		inputs.rebuiltEnv,
		criteria.required_provenance_fields,
	);

	const preFixSignatureMatch = inputs.preFix.new_signature
		? signaturesMatch(inputs.recordedSignature, inputs.preFix.new_signature)
		: undefined;
	const preFixReproduced =
		inputs.preFix.verified &&
		preFixSignatureMatch !== undefined &&
		preFixSignatureMatch >= criteria.min_signature_match;

	const postFixPassed = !inputs.postFix.verified && inputs.postFix.exit_code === 0;

	const refused: string[] = [];
	if (!provenance.faithful) {
		refused.push(
			`rebuilt environment's provenance does not match: ${provenance.problems.join("; ")}`,
		);
	}
	if (!preFixReproduced) {
		refused.push(
			preFixSignatureMatch === undefined
				? "the rebuilt environment never reproduced the original failure before the fix was applied; the regenerated evidence has nothing to confirm the fix against"
				: `the rebuilt environment's pre-fix failure signature matched only ${Math.round(preFixSignatureMatch * 100)}% (required ${Math.round(criteria.min_signature_match * 100)}%); this is not a confirmed reproduction of the original failure`,
		);
	}
	if (!postFixPassed) {
		refused.push(
			`the reproducer did not pass after the fix was applied in the rebuilt environment (verified: ${inputs.postFix.verified}, exit_code: ${inputs.postFix.exit_code})`,
		);
	}

	return {
		provenance,
		pre_fix_reproduced: preFixReproduced,
		pre_fix_signature_match: preFixSignatureMatch,
		post_fix_passed: postFixPassed,
		accepted: refused.length === 0,
		refused,
	};
}

/** A short rendering suitable for an incident channel. */
export function renderReplayValidationResult(result: ReplayValidationResult): string {
	const lines: string[] = [
		"# Replay-From-Scratch Validation",
		"",
		`accepted: ${result.accepted}`,
		`provenance faithful: ${result.provenance.faithful}`,
		`pre-fix reproduced: ${result.pre_fix_reproduced}`,
		`post-fix passed: ${result.post_fix_passed}`,
	];
	if (result.refused.length > 0) {
		lines.push("", "## Refused", "");
		for (const reason of result.refused) lines.push(`- ${reason}`);
	}
	return lines.join("\n");
}
