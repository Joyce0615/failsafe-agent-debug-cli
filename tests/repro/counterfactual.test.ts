import { describe, expect, test } from "bun:test";
import {
	ACCEPTING_VERDICTS,
	ARM_EXPECTATIONS,
	CONTROL_ARMS,
	type ArmOutcome,
	type ArmRunner,
	type ControlArm,
	MIN_REPEATS,
	type PatchSummary,
	classifyMatrix,
	mutationSafety,
	renderControlResult,
	runControlMatrix,
} from "../../src/repro/counterfactual.js";

function patch(overrides: Partial<PatchSummary> = {}): PatchSummary {
	return { files: ["src/handler.py"], changed_lines: 3, command: "pytest -q", ...overrides };
}

/** A runner driven by a per-arm script of outcomes. */
function scripted(script: Partial<Record<ControlArm, ArmOutcome[]>>): ArmRunner {
	const defaults: Record<ControlArm, ArmOutcome> = {
		repro_with_fix: "pass",
		repro_control: "fail",
		suite_with_fix: "pass",
		mutation: "fail",
	};
	return (arm, attempt) => {
		const seq = script[arm];
		return { outcome: seq ? (seq[attempt] ?? seq[seq.length - 1]) : defaults[arm] };
	};
}

describe("the control matrix", () => {
	test("all four arms are run, in the declared order", async () => {
		const seen: ControlArm[] = [];
		const result = await runControlMatrix(patch(), (arm) => {
			seen.push(arm);
			return { outcome: ARM_EXPECTATIONS[arm] };
		});
		// Arms run to completion in order, so the first-seen order is declaration order.
		expect([...new Set(seen)]).toEqual([...CONTROL_ARMS]);
		expect(result.arms.map((a) => a.arm)).toEqual([...CONTROL_ARMS]);
	});

	test("a fully correct matrix is the only path to a causal verdict", async () => {
		const result = await runControlMatrix(patch(), scripted({}));
		expect(result.verdict).toBe("causal");
		expect(result.arms.every((a) => a.satisfied)).toBe(true);
		expect(ACCEPTING_VERDICTS).toContain(result.verdict);
	});

	test("the expectations encode the negative-control design", () => {
		expect(ARM_EXPECTATIONS.repro_with_fix).toBe("pass");
		expect(ARM_EXPECTATIONS.repro_control).toBe("fail");
		expect(ARM_EXPECTATIONS.suite_with_fix).toBe("pass");
		expect(ARM_EXPECTATIONS.mutation).toBe("fail");
	});
});

describe("the negative control", () => {
	test("a repro that passes without the fix proves nothing", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ repro_control: ["pass", "pass", "pass"] }),
		);
		expect(result.verdict).toBe("not_reproducible");
		expect(result.deciding_arm).toBe("repro_control");
		expect(result.summary).toContain("no reproducible failure");
	});

	test("a control that flips between runs is a flaky failure, not a fix", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ repro_control: ["fail", "pass", "fail"] }),
		);
		expect(result.verdict).toBe("flaky_failure");
		expect(result.deciding_arm).toBe("repro_control");
	});

	test("not_reproducible outranks regression: there was no defect to regress against", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({
				repro_control: ["pass", "pass", "pass"],
				suite_with_fix: ["fail", "fail", "fail"],
			}),
		);
		expect(result.verdict).toBe("not_reproducible");
	});
});

describe("the mutation counterfactual", () => {
	test("a repro insensitive to the changed code is called incidental", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ mutation: ["pass", "pass", "pass"] }),
		);
		expect(result.verdict).toBe("incidental");
		expect(result.deciding_arm).toBe("mutation");
		expect(result.summary).toContain("does not exercise the changed code");
	});

	test("an intermittently surviving mutant is still not a pass", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ mutation: ["fail", "pass", "fail"] }),
		);
		expect(result.verdict).toBe("incidental");
	});

	test("three good arms without a mutation cap at unproven, never causal", async () => {
		const result = await runControlMatrix(
			patch({ files: ["migrations/0007_add_column.py"] }),
			scripted({}),
		);
		expect(result.verdict).toBe("unproven_no_mutation");
		expect(result.arms.find((a) => a.arm === "mutation")?.skipped_reason).toContain(
			"irreversible",
		);
	});
});

describe("the other failure modes", () => {
	test("a repro still failing with the fix is refuted", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ repro_with_fix: ["fail", "fail", "fail"] }),
		);
		expect(result.verdict).toBe("refuted");
		expect(result.deciding_arm).toBe("repro_with_fix");
	});

	test("a repro that only sometimes passes with the fix is flaky, not refuted", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ repro_with_fix: ["pass", "fail", "pass"] }),
		);
		expect(result.verdict).toBe("flaky_failure");
		expect(result.deciding_arm).toBe("repro_with_fix");
	});

	test("a green repro with a red suite is a regression", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ suite_with_fix: ["fail", "fail", "fail"] }),
		);
		expect(result.verdict).toBe("regression");
		expect(result.deciding_arm).toBe("suite_with_fix");
	});

	test("a harness error invalidates everything, whatever the other arms said", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({ suite_with_fix: ["error", "pass", "pass"] }),
		);
		expect(result.verdict).toBe("inconclusive_harness_error");
		expect(result.deciding_arm).toBe("suite_with_fix");
	});

	test("a harness error outranks even a refuted repro", async () => {
		const result = await runControlMatrix(
			patch(),
			scripted({
				repro_with_fix: ["fail", "fail", "fail"],
				mutation: ["error", "error", "error"],
			}),
		);
		expect(result.verdict).toBe("inconclusive_harness_error");
	});
});

describe("mandatory repeats", () => {
	test("a single repetition cannot earn any verdict", async () => {
		const result = await runControlMatrix(patch(), scripted({}), { repeats: 1 });
		expect(result.verdict).toBe("insufficient_repeats");
		expect(result.summary).toContain(String(MIN_REPEATS));
	});

	test("two repetitions are still not enough to tell always from usually", async () => {
		const result = await runControlMatrix(patch(), scripted({}), { repeats: 2 });
		expect(result.verdict).toBe("insufficient_repeats");
	});

	test("the minimum is enough", async () => {
		const result = await runControlMatrix(patch(), scripted({}), { repeats: MIN_REPEATS });
		expect(result.verdict).toBe("causal");
	});

	test("more repetitions expose flakiness a shorter run would miss", async () => {
		const flakyAtFive: ArmRunner = (arm, attempt) => {
			if (arm === "repro_control" && attempt === 4) return { outcome: "pass" };
			return { outcome: ARM_EXPECTATIONS[arm] };
		};
		expect((await runControlMatrix(patch(), flakyAtFive, { repeats: 3 })).verdict).toBe("causal");
		expect((await runControlMatrix(patch(), flakyAtFive, { repeats: 5 })).verdict).toBe(
			"flaky_failure",
		);
	});
});

describe("early stopping", () => {
	test("an arm stops at its first contrary run", async () => {
		let calls = 0;
		const result = await runControlMatrix(
			patch(),
			(arm) => {
				calls++;
				return { outcome: arm === "repro_with_fix" ? "fail" : ARM_EXPECTATIONS[arm] };
			},
			{ repeats: 5, early_stop: true },
		);
		expect(result.verdict).toBe("refuted");
		// One run of the failing arm, then five each of the remaining three.
		expect(calls).toBe(1 + 5 * 3);
	});

	test("early stopping never converts a failing arm into a passing verdict", async () => {
		for (const arm of CONTROL_ARMS) {
			const contrary = ARM_EXPECTATIONS[arm] === "pass" ? "fail" : "pass";
			const runner: ArmRunner = (a) =>
				({ outcome: a === arm ? contrary : ARM_EXPECTATIONS[a] }) as const;
			const result = await runControlMatrix(patch(), runner, {
				repeats: 3,
				early_stop: true,
			});
			expect(result.verdict).not.toBe("causal");
		}
	});

	test("without early stopping every arm runs the full count", async () => {
		let calls = 0;
		await runControlMatrix(
			patch(),
			(arm) => {
				calls++;
				return { outcome: arm === "repro_with_fix" ? "fail" : ARM_EXPECTATIONS[arm] };
			},
			{ repeats: 4 },
		);
		expect(calls).toBe(16);
	});
});

describe("mutation safety", () => {
	test("an ordinary source patch is safe to mutate", () => {
		expect(mutationSafety(patch())).toEqual({ safe: true, reasons: [] });
	});

	test("migrations are refused", () => {
		const safety = mutationSafety(patch({ files: ["db/migrations/0003_add_index.sql"] }));
		expect(safety.safe).toBe(false);
		expect(safety.reasons[0]).toContain("irreversible");
	});

	test("infrastructure and workflow paths are refused", () => {
		for (const file of [
			".github/workflows/ci.yml",
			"terraform/main.tf",
			"infra/deploy.yaml",
			"Dockerfile",
			"alembic/versions/abc.py",
		]) {
			expect(mutationSafety(patch({ files: [file] })).safe).toBe(false);
		}
	});

	test("a command with effects outside the tree is refused", () => {
		const safety = mutationSafety(patch({ command: "npm publish && git push" }));
		expect(safety.safe).toBe(false);
		expect(safety.reasons.some((r) => r.includes("outside the working tree"))).toBe(true);
	});

	test("a patch with nothing to mutate is refused rather than trivially passing", () => {
		expect(mutationSafety(patch({ changed_lines: 0 })).safe).toBe(false);
		expect(mutationSafety(patch({ files: [] })).safe).toBe(false);
	});

	test("every reason is reported, not just the first", () => {
		const safety = mutationSafety({
			files: ["migrations/1.sql", "terraform/main.tf"],
			changed_lines: 0,
			command: "terraform apply",
		});
		expect(safety.reasons.length).toBeGreaterThanOrEqual(4);
	});

	test("an ordinary path containing the word deploy in a filename is not refused", () => {
		// The guard is on directories and commands, not on any occurrence of the word.
		expect(mutationSafety(patch({ files: ["src/deployment_helpers.py"] })).safe).toBe(true);
	});
});

describe("classification is deterministic and total", () => {
	test("classifyMatrix reaches a verdict for any matrix shape", () => {
		const outcomes: ArmOutcome[] = ["pass", "fail", "error"];
		const seen = new Set<string>();
		for (const a of outcomes) {
			for (const b of outcomes) {
				for (const c of outcomes) {
					for (const d of outcomes) {
						const arms = CONTROL_ARMS.map((arm, i) => {
							const outcome = [a, b, c, d][i];
							const runs = [{ outcome }, { outcome }, { outcome }];
							const expected = ARM_EXPECTATIONS[arm];
							const satisfied = outcome === expected;
							return {
								arm,
								expected,
								runs,
								as_expected: satisfied ? 3 : 0,
								contrary: satisfied || outcome === "error" ? 0 : 3,
								errors: outcome === "error" ? 3 : 0,
								stability: outcome === "error" ? ("errored" as const) : ("consistent" as const),
								satisfied,
							};
						});
						const result = classifyMatrix(arms, 3, { safe: true, reasons: [] });
						seen.add(result.verdict);
						expect(result.summary.length).toBeGreaterThan(0);
					}
				}
			}
		}
		expect(seen.has("causal")).toBe(true);
		expect(seen.has("inconclusive_harness_error")).toBe(true);
	});

	test("exactly one matrix out of 81 is causal", () => {
		let causal = 0;
		const outcomes: ArmOutcome[] = ["pass", "fail", "error"];
		for (const a of outcomes) {
			for (const b of outcomes) {
				for (const c of outcomes) {
					for (const d of outcomes) {
						const arms = CONTROL_ARMS.map((arm, i) => {
							const outcome = [a, b, c, d][i];
							const expected = ARM_EXPECTATIONS[arm];
							const satisfied = outcome === expected;
							return {
								arm,
								expected,
								runs: [{ outcome }, { outcome }, { outcome }],
								as_expected: satisfied ? 3 : 0,
								contrary: satisfied || outcome === "error" ? 0 : 3,
								errors: outcome === "error" ? 3 : 0,
								stability: outcome === "error" ? ("errored" as const) : ("consistent" as const),
								satisfied,
							};
						});
						if (classifyMatrix(arms, 3, { safe: true, reasons: [] }).verdict === "causal") {
							causal++;
						}
					}
				}
			}
		}
		expect(causal).toBe(1);
	});
});

describe("rendering", () => {
	test("a skipped arm is reported, not omitted", async () => {
		const result = await runControlMatrix(patch({ files: ["migrations/1.sql"] }), scripted({}));
		const text = renderControlResult(result);
		expect(text).toContain("mutation: SKIPPED");
		expect(text).toContain("verdict: unproven_no_mutation");
	});

	test("every arm and its outcomes appear in the rendering", async () => {
		const text = renderControlResult(await runControlMatrix(patch(), scripted({})));
		for (const arm of CONTROL_ARMS) expect(text).toContain(arm);
		expect(text).toContain("satisfied");
	});
});
