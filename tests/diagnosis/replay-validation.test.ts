import { describe, expect, test } from "bun:test";
import {
	type AcceptanceCriteria,
	compareEnvironmentProvenance,
	renderReplayValidationResult,
	validateReplayFromScratch,
} from "../../src/diagnosis/replay-validation.js";
import type { VerifyResult } from "../../src/repro/verifier.js";
import type { EnvFingerprint } from "../../src/types/common.js";
import type { FailureSignature } from "../../src/types/repro.js";

function env(overrides: Partial<EnvFingerprint> = {}): EnvFingerprint {
	return {
		os: "linux",
		arch: "x64",
		cwd: "/workspace",
		node_version: "20.11.0",
		...overrides,
	};
}

const SIGNATURE: FailureSignature = {
	exception_type: "AssertionError",
	test_name: "test_add",
};

const CRITERIA: AcceptanceCriteria = {
	required_provenance_fields: ["os", "arch", "node_version"],
	min_signature_match: 0.5,
};

function verifyResult(overrides: Partial<VerifyResult>): VerifyResult {
	return {
		verified: false,
		exit_code: 1,
		duration_ms: 10,
		...overrides,
	};
}

describe("compareEnvironmentProvenance", () => {
	test("identical fields are reported as match", () => {
		const result = compareEnvironmentProvenance(env(), env(), ["os", "arch", "node_version"]);
		expect(result.faithful).toBe(true);
		expect(result.problems).toHaveLength(0);
	});

	test("a differing required field is a mismatch, not silently ignored", () => {
		const result = compareEnvironmentProvenance(env(), env({ node_version: "18.0.0" }), [
			"os",
			"node_version",
		]);
		expect(result.faithful).toBe(false);
		expect(result.comparisons.find((c) => c.field === "node_version")?.status).toBe("mismatch");
	});

	test("a required field absent from the rebuilt environment is unknown, not a match", () => {
		const result = compareEnvironmentProvenance(env(), env({ node_version: undefined }), [
			"node_version",
		]);
		expect(result.faithful).toBe(false);
		expect(result.comparisons[0].status).toBe("unknown");
	});

	test("a field not in requiredFields is never compared, even if it differs", () => {
		const result = compareEnvironmentProvenance(env({ cwd: "/a" }), env({ cwd: "/b" }), ["os"]);
		expect(result.faithful).toBe(true);
		expect(result.comparisons).toHaveLength(1);
	});
});

describe("validateReplayFromScratch", () => {
	test("accepts when provenance is faithful, the repro reproduced pre-fix, and passed post-fix", () => {
		const result = validateReplayFromScratch(
			{
				recordedEnv: env(),
				rebuiltEnv: env(),
				recordedSignature: SIGNATURE,
				preFix: verifyResult({ verified: true, exit_code: 1, new_signature: SIGNATURE }),
				postFix: verifyResult({ verified: false, exit_code: 0 }),
			},
			CRITERIA,
		);
		expect(result.accepted).toBe(true);
		expect(result.refused).toHaveLength(0);
	});

	test("refuses when the rebuilt environment's provenance does not match required fields", () => {
		const result = validateReplayFromScratch(
			{
				recordedEnv: env(),
				rebuiltEnv: env({ node_version: "18.0.0" }),
				recordedSignature: SIGNATURE,
				preFix: verifyResult({ verified: true, exit_code: 1, new_signature: SIGNATURE }),
				postFix: verifyResult({ verified: false, exit_code: 0 }),
			},
			CRITERIA,
		);
		expect(result.accepted).toBe(false);
		expect(result.refused.some((r) => r.includes("provenance"))).toBe(true);
	});

	test("refuses when the rebuilt environment never reproduced the original failure before the fix", () => {
		const result = validateReplayFromScratch(
			{
				recordedEnv: env(),
				rebuiltEnv: env(),
				recordedSignature: SIGNATURE,
				preFix: verifyResult({ verified: false, exit_code: 0, new_signature: undefined }),
				postFix: verifyResult({ verified: false, exit_code: 0 }),
			},
			CRITERIA,
		);
		expect(result.accepted).toBe(false);
		expect(result.pre_fix_reproduced).toBe(false);
		expect(result.refused.some((r) => r.includes("never reproduced"))).toBe(true);
	});

	test("refuses when the reproducer still fails after the fix is applied", () => {
		const result = validateReplayFromScratch(
			{
				recordedEnv: env(),
				rebuiltEnv: env(),
				recordedSignature: SIGNATURE,
				preFix: verifyResult({ verified: true, exit_code: 1, new_signature: SIGNATURE }),
				postFix: verifyResult({ verified: true, exit_code: 1, new_signature: SIGNATURE }),
			},
			CRITERIA,
		);
		expect(result.accepted).toBe(false);
		expect(result.post_fix_passed).toBe(false);
		expect(result.refused.some((r) => r.includes("did not pass after the fix"))).toBe(true);
	});

	test("a pre-fix signature below the declared threshold refuses, even with a low threshold caller could have raised", () => {
		const weakSignature: FailureSignature = { exception_type: "TypeError" };
		const result = validateReplayFromScratch(
			{
				recordedEnv: env(),
				rebuiltEnv: env(),
				recordedSignature: SIGNATURE,
				preFix: verifyResult({ verified: true, exit_code: 1, new_signature: weakSignature }),
				postFix: verifyResult({ verified: false, exit_code: 0 }),
			},
			{ ...CRITERIA, min_signature_match: 0.99 },
		);
		expect(result.accepted).toBe(false);
		expect(result.pre_fix_reproduced).toBe(false);
	});
});

describe("renderReplayValidationResult", () => {
	test("renders acceptance and every refusal reason", () => {
		const result = validateReplayFromScratch(
			{
				recordedEnv: env(),
				rebuiltEnv: env({ node_version: "18.0.0" }),
				recordedSignature: SIGNATURE,
				preFix: verifyResult({ verified: false, exit_code: 0, new_signature: undefined }),
				postFix: verifyResult({ verified: false, exit_code: 1 }),
			},
			CRITERIA,
		);
		const text = renderReplayValidationResult(result);
		expect(text).toContain("accepted: false");
		for (const reason of result.refused) {
			expect(text).toContain(reason);
		}
	});
});
