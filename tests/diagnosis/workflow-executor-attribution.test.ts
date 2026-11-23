/**
 * Workflow/executor defect attribution tests (item 57 — analyze
 * same-workflow/different-executor and same-executor/different-workflow
 * evidence as a 2×2 matrix, attributing decomposition, execution, and
 * interaction effects only when evidence is sufficient).
 */
import { describe, expect, test } from "bun:test";
import {
	type WorkflowExecutorRun,
	attributeDefect,
	renderAttributionReport,
} from "../../src/diagnosis/workflow-executor-attribution.js";

function run(overrides: Partial<WorkflowExecutorRun>): WorkflowExecutorRun {
	return {
		run_id: "r1",
		workflow_id: "wf-a",
		executor_id: "ex-a",
		outcome: "fail",
		...overrides,
	};
}

describe("attributeDefect: decomposition_effect (workflow-author defect)", () => {
	test("a workflow failing across a majority of other executors is a decomposition effect", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "fail" }),
			run({ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "fail" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.decomposition_effect).toBe("present");
	});

	test("a workflow passing cleanly with every other executor is not a decomposition effect", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "pass" }),
			run({ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.decomposition_effect).toBe("absent");
	});

	test("too few distinct other executors abstains with insufficient_evidence", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "fail" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.decomposition_effect).toBe("insufficient_evidence");
	});

	test("an exact 50/50 failure split among sufficient others is insufficient_evidence, not present", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "fail" }),
			run({ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.decomposition_effect).toBe("insufficient_evidence");
	});
});

describe("attributeDefect: execution_effect (executor defect)", () => {
	test("an executor failing across a majority of other workflows is an execution effect", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-b", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r3", workflow_id: "wf-c", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r4", workflow_id: "wf-a", executor_id: "ex-b", outcome: "pass" }),
			run({ run_id: "r5", workflow_id: "wf-a", executor_id: "ex-c", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.execution_effect).toBe("present");
	});

	test("an executor passing cleanly with every other workflow is not an execution effect", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-b", executor_id: "ex-a", outcome: "pass" }),
			run({ run_id: "r3", workflow_id: "wf-c", executor_id: "ex-a", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.execution_effect).toBe("absent");
	});
});

describe("attributeDefect: interaction_effect", () => {
	test("neither main effect present but the target run failed is an interaction effect", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "pass" }),
			run({ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "pass" }),
			run({ run_id: "r4", workflow_id: "wf-b", executor_id: "ex-a", outcome: "pass" }),
			run({ run_id: "r5", workflow_id: "wf-c", executor_id: "ex-a", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.decomposition_effect).toBe("absent");
		expect(result.execution_effect).toBe("absent");
		expect(result.interaction_effect).toBe("present");
	});

	test("interaction effect is absent when a main effect already explains the failure", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "fail" }),
			run({ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "fail" }),
			run({ run_id: "r4", workflow_id: "wf-b", executor_id: "ex-a", outcome: "pass" }),
			run({ run_id: "r5", workflow_id: "wf-c", executor_id: "ex-a", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.decomposition_effect).toBe("present");
		expect(result.interaction_effect).toBe("absent");
	});

	test("interaction effect cannot be called when a main effect is itself insufficient_evidence", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "pass" }),
			run({ run_id: "r4", workflow_id: "wf-b", executor_id: "ex-a", outcome: "pass" }),
			run({ run_id: "r5", workflow_id: "wf-c", executor_id: "ex-a", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.decomposition_effect).toBe("insufficient_evidence");
		expect(result.interaction_effect).toBe("insufficient_evidence");
	});

	test("interaction effect is absent when the target run passed and neither main effect is present", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "pass" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "pass" }),
			run({ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "pass" }),
			run({ run_id: "r4", workflow_id: "wf-b", executor_id: "ex-a", outcome: "pass" }),
			run({ run_id: "r5", workflow_id: "wf-c", executor_id: "ex-a", outcome: "pass" }),
		];
		const result = attributeDefect("target", runs);
		expect(result.interaction_effect).toBe("absent");
	});
});

describe("attributeDefect: error handling", () => {
	test("throws when the target run_id is not found", () => {
		const runs = [run({ run_id: "other" })];
		expect(() => attributeDefect("missing", runs)).toThrow();
	});
});

describe("renderAttributionReport", () => {
	test("renders all three effect verdicts and reasons", () => {
		const runs = [
			run({ run_id: "target", workflow_id: "wf-a", executor_id: "ex-a", outcome: "fail" }),
			run({ run_id: "r2", workflow_id: "wf-a", executor_id: "ex-b", outcome: "fail" }),
			run({ run_id: "r3", workflow_id: "wf-a", executor_id: "ex-c", outcome: "fail" }),
		];
		const result = attributeDefect("target", runs);
		const text = renderAttributionReport(result);
		expect(text).toContain("decomposition_effect: present");
		expect(text).toContain("execution_effect:");
		expect(text).toContain("interaction_effect:");
	});
});
