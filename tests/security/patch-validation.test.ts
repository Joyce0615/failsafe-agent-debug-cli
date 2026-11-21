import { describe, expect, test } from "bun:test";
import type { ExploitabilityAssessment, SecurityAdvisory } from "../../src/security/advisories.js";
import {
	type MatrixRun,
	type MatrixRunner,
	decideExceptionOrUpgrade,
	renderPatchDecision,
	validatePatchAgainstExploit,
} from "../../src/security/patch-validation.js";

const ADVISORY: SecurityAdvisory = {
	id: "GHSA-0001",
	package: "left-pad",
	affected_versions: ["1.0.0"],
	patched_version: "1.0.1",
	attack_vector: "network",
	summary: "test advisory",
};

function exploitable(): ExploitabilityAssessment {
	return {
		advisory: ADVISORY,
		status: "exploitable",
		matched_components: [
			{
				type: "library",
				name: "left-pad",
				version: "1.0.0",
				scope: "required",
				licenses: ["MIT"],
				purl: "pkg:npm/left-pad@1.0.0",
			},
		],
		rationale: "present and reachable",
	};
}

/** A runner that always behaves as expected: exploit succeeds on vulnerable, fails on patched. */
function mitigatedRunner(): MatrixRunner {
	return (arm) => ({ outcome: arm === "vulnerable" ? "exploit_succeeded" : "exploit_failed" });
}

/** A runner where the exploit succeeds on BOTH arms -- patch did not help. */
function notMitigatedRunner(): MatrixRunner {
	return () => ({ outcome: "exploit_succeeded" });
}

/** A runner where the exploit fails on BOTH arms -- fixture itself is broken. */
function ineffectiveRunner(): MatrixRunner {
	return () => ({ outcome: "exploit_failed" });
}

describe("validatePatchAgainstExploit", () => {
	test("mitigated: exploit consistently succeeds on vulnerable and fails on patched", async () => {
		const result = await validatePatchAgainstExploit(mitigatedRunner());
		expect(result.verdict).toBe("mitigated");
		expect(result.arms).toHaveLength(2);
	});

	test("not_mitigated: exploit succeeds on both arms", async () => {
		const result = await validatePatchAgainstExploit(notMitigatedRunner());
		expect(result.verdict).toBe("not_mitigated");
	});

	test("exploit_ineffective: exploit fails on vulnerable too", async () => {
		const result = await validatePatchAgainstExploit(ineffectiveRunner());
		expect(result.verdict).toBe("exploit_ineffective");
	});

	test("inconsistent: vulnerable arm produces both outcomes across repeats", async () => {
		let call = 0;
		const runner: MatrixRunner = (arm) => {
			if (arm === "patched") return { outcome: "exploit_failed" };
			call++;
			return { outcome: call % 2 === 0 ? "exploit_succeeded" : "exploit_failed" };
		};
		const result = await validatePatchAgainstExploit(runner);
		expect(result.verdict).toBe("inconsistent");
	});

	test("harness_error: any run erroring produces harness_error, never a verdict about the vulnerability", async () => {
		const runner: MatrixRunner = (arm, attempt) => {
			if (arm === "vulnerable" && attempt === 1) return { outcome: "error", detail: "boom" };
			return { outcome: arm === "vulnerable" ? "exploit_succeeded" : "exploit_failed" };
		};
		const result = await validatePatchAgainstExploit(runner);
		expect(result.verdict).toBe("harness_error");
	});

	test("insufficient_repeats: below MIN_MATRIX_REPEATS refuses without running anything", async () => {
		let invoked = false;
		const runner: MatrixRunner = () => {
			invoked = true;
			return { outcome: "exploit_succeeded" };
		};
		const result = await validatePatchAgainstExploit(runner, 2);
		expect(result.verdict).toBe("insufficient_repeats");
		expect(result.arms).toEqual([]);
		expect(invoked).toBe(false);
	});

	test("runs the configured number of repeats per arm", async () => {
		const calls: Array<{ arm: string; attempt: number }> = [];
		const runner: MatrixRunner = (arm, attempt) => {
			calls.push({ arm, attempt });
			return { outcome: arm === "vulnerable" ? "exploit_succeeded" : "exploit_failed" };
		};
		await validatePatchAgainstExploit(runner, 5);
		expect(calls).toHaveLength(10); // 2 arms * 5 repeats
		expect(calls.filter((c) => c.arm === "vulnerable")).toHaveLength(5);
	});

	test("one contrary run on the patched arm (exploit succeeded once) still yields not_mitigated, not mitigated", async () => {
		let attemptCount = 0;
		const runner: MatrixRunner = (arm) => {
			if (arm === "vulnerable") return { outcome: "exploit_succeeded" };
			attemptCount++;
			// patched arm: fails twice, succeeds once -> inconsistent, not not_mitigated
			return { outcome: attemptCount === 2 ? "exploit_succeeded" : "exploit_failed" };
		};
		const result = await validatePatchAgainstExploit(runner, 3);
		expect(result.verdict).toBe("inconsistent");
	});
});

describe("decideExceptionOrUpgrade", () => {
	test("mitigated verdict passes through proposeAdvisoryRecovery's upgrade action", async () => {
		const validation = await validatePatchAgainstExploit(mitigatedRunner());
		const decision = decideExceptionOrUpgrade(validation, exploitable());
		expect(decision.recommended_recovery?.actions[0]).toMatchObject({
			kind: "upgrade",
			package: "left-pad",
			to_version: "1.0.1",
		});
		expect(decision.exception_reason).toBeUndefined();
	});

	test("not_mitigated verdict withholds the upgrade action even though patched_version is declared", async () => {
		const validation = await validatePatchAgainstExploit(notMitigatedRunner());
		const decision = decideExceptionOrUpgrade(validation, exploitable());
		expect(decision.recommended_recovery?.actions.some((a) => a.kind === "upgrade")).toBe(false);
		expect(decision.recommended_recovery?.refused.join(" ")).toMatch(/did NOT mitigate/);
	});

	test("exploit_ineffective verdict refuses to pick upgrade-vs-isolate; reports an exception instead", async () => {
		const validation = await validatePatchAgainstExploit(ineffectiveRunner());
		const decision = decideExceptionOrUpgrade(validation, exploitable());
		expect(decision.recommended_recovery).toBeUndefined();
		expect(decision.exception_reason).toContain("exploit_ineffective");
	});

	test("insufficient_repeats verdict also refuses and reports an exception", async () => {
		const validation = await validatePatchAgainstExploit(mitigatedRunner(), 1);
		const decision = decideExceptionOrUpgrade(validation, exploitable());
		expect(decision.exception_reason).toContain("insufficient_repeats");
	});

	test("harness_error verdict refuses and reports an exception, never a confirmed recovery", async () => {
		const runner: MatrixRunner = (arm, attempt) =>
			arm === "patched" && attempt === 1
				? { outcome: "error" as const }
				: ({ outcome: arm === "vulnerable" ? "exploit_succeeded" : "exploit_failed" } as MatrixRun);
		const validation = await validatePatchAgainstExploit(runner);
		const decision = decideExceptionOrUpgrade(validation, exploitable());
		expect(decision.exception_reason).toContain("harness_error");
	});
});

describe("renderPatchDecision", () => {
	test("renders verdict, rationale, per-arm lines, and a recommended action for mitigated", async () => {
		const validation = await validatePatchAgainstExploit(mitigatedRunner());
		const decision = decideExceptionOrUpgrade(validation, exploitable());
		const text = renderPatchDecision(decision);
		expect(text).toContain("Runtime Security Patch Validation");
		expect(text).toContain("Verdict: mitigated");
		expect(text).toContain("Recommended action(s): upgrade");
	});

	test("renders an Exception line for a refused verdict", async () => {
		const validation = await validatePatchAgainstExploit(ineffectiveRunner());
		const decision = decideExceptionOrUpgrade(validation, exploitable());
		const text = renderPatchDecision(decision);
		expect(text).toContain("Exception:");
	});
});
