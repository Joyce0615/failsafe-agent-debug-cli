/**
 * Counterfactual negative controls for proposed repairs (item 55).
 *
 * "The tests pass now" is the weakest possible evidence that a repair fixed
 * anything. It is equally consistent with four other stories: the failure was
 * flaky and would have passed anyway; the repro never exercised the changed
 * code and passes for unrelated reasons; the patch masked the symptom while
 * breaking something else; or the harness itself misbehaved. Every one of those
 * is common, and none is distinguishable from a real fix by re-running the
 * suite.
 *
 * This module runs a four-arm control matrix and refuses to call anything
 * causal unless all four behave as they must:
 *
 * | arm               | what it runs                         | must |
 * |-------------------|--------------------------------------|------|
 * | `repro_with_fix`  | the minimal repro, patch applied     | pass |
 * | `repro_control`   | the minimal repro, patch reverted    | fail |
 * | `suite_with_fix`  | the original suite, patch applied    | pass |
 * | `mutation`        | the repro against a re-broken patch  | fail |
 *
 * `repro_control` is the negative control proper: if the repro passes *without*
 * the fix, then whatever was observed was not deterministic and the fix has
 * demonstrated nothing. `mutation` is the counterfactual: deliberately undo the
 * semantic content of the patch and confirm the repro breaks again. If it does
 * not, the repro is not sensitive to the changed code and the pass was
 * incidental — the single most common way a green run lies.
 *
 * Two rules keep the instrument honest:
 *
 * - **Repeats are mandatory.** One run per arm cannot distinguish "passes" from
 *   "passed this time", so a matrix below `MIN_REPEATS` returns
 *   `insufficient_repeats` rather than a verdict it has not earned.
 * - **An unsafe mutation is skipped and named.** Mutating a database migration
 *   or anything a deploy command touches is not worth a stronger verdict, so
 *   `mutationSafety` refuses and the result caps at `unproven_no_mutation`
 *   instead of silently reporting `causal` on three arms.
 *
 * Pure: execution happens behind the `ArmRunner` seam, so this module contains
 * no process spawning and the tests contain no subprocesses.
 */

export const CONTROL_ARMS = [
	"repro_with_fix",
	"repro_control",
	"suite_with_fix",
	"mutation",
] as const;
export type ControlArm = (typeof CONTROL_ARMS)[number];

/** What each arm must do for the repair to be called causal. */
export const ARM_EXPECTATIONS: Record<ControlArm, "pass" | "fail"> = {
	repro_with_fix: "pass",
	repro_control: "fail",
	suite_with_fix: "pass",
	mutation: "fail",
};

export type ArmOutcome = "pass" | "fail" | "error";

export type ArmRun = {
	outcome: ArmOutcome;
	duration_ms?: number;
	/** Harness detail; only meaningful for `error`. */
	detail?: string;
};

/** Executes one repetition of one arm. Injected so this module stays pure. */
export type ArmRunner = (arm: ControlArm, attempt: number) => Promise<ArmRun> | ArmRun;

/**
 * Below this, flakiness is invisible and no causal claim is defensible.
 *
 * Three is the smallest number that can distinguish "always" from "usually":
 * with two runs, one disagreement is a 50/50 split and says nothing about which
 * behaviour is the norm.
 */
export const MIN_REPEATS = 3;
export const DEFAULT_REPEATS = 3;

export type ArmResult = {
	arm: ControlArm;
	expected: "pass" | "fail";
	runs: ArmRun[];
	/** Runs matching the expectation. */
	as_expected: number;
	/** Runs contradicting it. */
	contrary: number;
	errors: number;
	/**
	 * `consistent` — every non-error run agreed with itself.
	 * `inconsistent` — the arm produced both outcomes, i.e. it is flaky.
	 * `errored` — at least one run failed to execute at all.
	 */
	stability: "consistent" | "inconsistent" | "errored";
	/** True only when the arm consistently did what it had to do. */
	satisfied: boolean;
	skipped_reason?: string;
};

function summarizeArm(arm: ControlArm, runs: ArmRun[]): ArmResult {
	const expected = ARM_EXPECTATIONS[arm];
	const errors = runs.filter((r) => r.outcome === "error").length;
	const passes = runs.filter((r) => r.outcome === "pass").length;
	const fails = runs.filter((r) => r.outcome === "fail").length;
	const asExpected = expected === "pass" ? passes : fails;
	const contrary = expected === "pass" ? fails : passes;

	const stability: ArmResult["stability"] =
		errors > 0 ? "errored" : passes > 0 && fails > 0 ? "inconsistent" : "consistent";

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

/** A skipped arm, carrying the reason it was not run. */
function skippedArm(arm: ControlArm, reason: string): ArmResult {
	return {
		arm,
		expected: ARM_EXPECTATIONS[arm],
		runs: [],
		as_expected: 0,
		contrary: 0,
		errors: 0,
		stability: "consistent",
		satisfied: false,
		skipped_reason: reason,
	};
}

export type PatchSummary = {
	/** Files the repair touches. */
	files: string[];
	/** Lines added/removed, used to judge whether a targeted mutation is meaningful. */
	changed_lines: number;
	/** The command the arms will run. */
	command: string;
};

export type MutationSafety = {
	safe: boolean;
	/** Every reason it is unsafe. Empty when safe. */
	reasons: string[];
};

/**
 * Paths where re-breaking the code on purpose is not a controlled experiment.
 *
 * A mutated migration can leave a database in a state no subsequent run can
 * recover from; a mutated workflow or deploy manifest can act on the world. The
 * point of a negative control is to learn something cheaply, and none of these
 * are cheap.
 */
const IRREVERSIBLE_PATHS = [
	/(^|\/)migrations?\//i,
	/(^|\/)\.github\/workflows\//i,
	/(^|\/)(terraform|infra|deploy|helm|k8s|kubernetes)\//i,
	/(^|\/)Dockerfile/,
	/\.(tf|tfvars)$/,
	/(^|\/)(alembic|flyway|liquibase)\//i,
];

/** Commands whose side effects escape the working tree. */
const SIDE_EFFECTING_COMMANDS =
	/\b(deploy|publish|release|terraform\s+apply|kubectl\s+apply|helm\s+(install|upgrade)|npm\s+publish|git\s+push|rm\s+-rf|migrate|flyway|alembic\s+upgrade)\b/i;

/**
 * Decide whether a targeted mutation is safe to run.
 *
 * Deny-by-default on anything irreversible. A patch with no changed lines is
 * also refused: there is nothing to mutate, and running the arm anyway would
 * produce a "mutation passed" result that means only that nothing was mutated.
 */
export function mutationSafety(patch: PatchSummary): MutationSafety {
	const reasons: string[] = [];

	for (const file of patch.files) {
		if (IRREVERSIBLE_PATHS.some((re) => re.test(file))) {
			reasons.push(
				`'${file}' is in an irreversible path; mutating it is not a controlled experiment`,
			);
		}
	}
	if (SIDE_EFFECTING_COMMANDS.test(patch.command)) {
		reasons.push(`command '${patch.command}' has effects outside the working tree`);
	}
	if (patch.changed_lines <= 0) {
		reasons.push("patch changes no lines, so there is nothing to mutate");
	}
	if (patch.files.length === 0) {
		reasons.push("patch touches no files, so there is nothing to mutate");
	}

	return { safe: reasons.length === 0, reasons };
}

export const VERDICTS = [
	"causal",
	"refuted",
	"not_reproducible",
	"flaky_failure",
	"regression",
	"incidental",
	"unproven_no_mutation",
	"insufficient_repeats",
	"inconclusive_harness_error",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Verdicts that permit acting on the repair. */
export const ACCEPTING_VERDICTS: readonly Verdict[] = ["causal"];

export type ControlResult = {
	verdict: Verdict;
	/** The arm whose behaviour decided the verdict, when one did. */
	deciding_arm?: ControlArm;
	/** One sentence a human can act on. */
	summary: string;
	repeats: number;
	arms: ArmResult[];
	mutation_safety: MutationSafety;
};

function armOf(arms: ArmResult[], name: ControlArm): ArmResult {
	// Every arm is always present in the matrix, skipped or not.
	return arms.find((a) => a.arm === name)!;
}

/**
 * Turn a completed matrix into exactly one verdict.
 *
 * Order matters and is deliberate. A harness error invalidates everything, so
 * it comes first. `not_reproducible` outranks `regression` because if the
 * control never failed there was no defect to regress against — reporting the
 * regression first would send someone to investigate a suite failure caused by
 * a patch for a bug that does not exist.
 */
export function classifyMatrix(
	arms: ArmResult[],
	repeats: number,
	safety: MutationSafety,
): ControlResult {
	const base = { repeats, arms, mutation_safety: safety };

	if (repeats < MIN_REPEATS) {
		return {
			...base,
			verdict: "insufficient_repeats",
			summary: `${repeats} repetition(s) per arm cannot distinguish a deterministic result from a lucky one; ${MIN_REPEATS} are required`,
		};
	}

	const errored = arms.find((a) => a.stability === "errored");
	if (errored) {
		return {
			...base,
			verdict: "inconclusive_harness_error",
			deciding_arm: errored.arm,
			summary: `arm '${errored.arm}' failed to execute (${errored.errors} of ${errored.runs.length} runs errored); no conclusion can be drawn`,
		};
	}

	const withFix = armOf(arms, "repro_with_fix");
	if (withFix.stability === "inconsistent") {
		return {
			...base,
			verdict: "flaky_failure",
			deciding_arm: "repro_with_fix",
			summary:
				"the repro passes only sometimes with the fix applied; the behaviour is not deterministic and no repair can be validated against it",
		};
	}
	if (!withFix.satisfied) {
		return {
			...base,
			verdict: "refuted",
			deciding_arm: "repro_with_fix",
			summary:
				"the repro still fails with the fix applied: the repair does not address the failure",
		};
	}

	const control = armOf(arms, "repro_control");
	if (control.stability === "inconsistent") {
		return {
			...base,
			verdict: "flaky_failure",
			deciding_arm: "repro_control",
			summary:
				"the unchanged control passed on some runs and failed on others: the original failure is flaky, so a passing fix proves nothing",
		};
	}
	if (!control.satisfied) {
		return {
			...base,
			verdict: "not_reproducible",
			deciding_arm: "repro_control",
			summary:
				"the repro passes with the fix reverted: there is no reproducible failure for this repair to have fixed",
		};
	}

	const suite = armOf(arms, "suite_with_fix");
	if (!suite.satisfied) {
		return {
			...base,
			verdict: "regression",
			deciding_arm: "suite_with_fix",
			summary:
				"the repro is fixed but the original suite now fails: the repair trades one failure for another",
		};
	}

	const mutation = armOf(arms, "mutation");
	if (mutation.skipped_reason) {
		return {
			...base,
			verdict: "unproven_no_mutation",
			deciding_arm: "mutation",
			summary: `three arms behaved correctly, but the mutation control was skipped (${mutation.skipped_reason}), so the repro's sensitivity to the changed code is unverified`,
		};
	}
	if (!mutation.satisfied) {
		return {
			...base,
			verdict: "incidental",
			deciding_arm: "mutation",
			summary:
				"the repro still passes against a deliberately re-broken patch: it does not exercise the changed code, so the earlier pass was incidental",
		};
	}

	return {
		...base,
		verdict: "causal",
		summary:
			"the repro fails without the fix, passes with it, fails again when the fix is mutated, and the suite is green: the repair is causally responsible",
	};
}

export type ControlOptions = {
	repeats?: number;
	/** Stop an arm early once its outcome can no longer change the verdict. */
	early_stop?: boolean;
};

/**
 * Run the full control matrix.
 *
 * Arms run in a fixed order — cheapest and most decisive first — so a repair
 * that does not even fix the repro never pays for a full suite run. With
 * `early_stop`, an arm stops as soon as it has produced a contrary outcome,
 * because one contrary run already denies `satisfied` and further repetitions
 * cannot change the verdict. Early stopping never *creates* a stronger verdict:
 * it only ends arms that have already failed.
 */
export async function runControlMatrix(
	patch: PatchSummary,
	runner: ArmRunner,
	options: ControlOptions = {},
): Promise<ControlResult> {
	const repeats = options.repeats ?? DEFAULT_REPEATS;
	const safety = mutationSafety(patch);
	const arms: ArmResult[] = [];

	for (const arm of CONTROL_ARMS) {
		if (arm === "mutation" && !safety.safe) {
			arms.push(skippedArm(arm, safety.reasons.join("; ")));
			continue;
		}

		const runs: ArmRun[] = [];
		for (let attempt = 0; attempt < repeats; attempt++) {
			const run = await runner(arm, attempt);
			runs.push(run);
			if (options.early_stop) {
				const contrary =
					run.outcome === "error" ||
					(ARM_EXPECTATIONS[arm] === "pass" ? run.outcome === "fail" : run.outcome === "pass");
				if (contrary) break;
			}
		}
		arms.push(summarizeArm(arm, runs));
	}

	return classifyMatrix(arms, repeats, safety);
}

/**
 * A compact, agent-readable rendering of the matrix.
 *
 * Reports every arm including the skipped one, because "we did not run this"
 * is the information a reader most needs and the easiest to omit.
 */
export function renderControlResult(result: ControlResult): string {
	const lines = [
		`verdict: ${result.verdict}`,
		`summary: ${result.summary}`,
		`repeats: ${result.repeats}`,
	];
	for (const arm of result.arms) {
		if (arm.skipped_reason) {
			lines.push(`  ${arm.arm}: SKIPPED (${arm.skipped_reason})`);
			continue;
		}
		const outcomes = arm.runs.map((r) => r.outcome).join(",");
		lines.push(
			`  ${arm.arm}: expected ${arm.expected}, got [${outcomes}] — ${
				arm.satisfied ? "satisfied" : `NOT satisfied (${arm.stability})`
			}`,
		);
	}
	return lines.join("\n");
}
