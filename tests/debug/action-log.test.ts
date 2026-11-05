import { describe, expect, test } from "bun:test";
import {
	ACTION_KINDS,
	ActionRecorder,
	fromJsonl,
	gradeActionLog,
	toJsonl,
	validateActionLog,
} from "../../src/debug/action-log.js";

describe("ActionRecorder", () => {
	test("redacts secrets in input/output/evidence before persisting, same as data-classes.ts's applyDataPolicy", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		const record = recorder.record("tool_call", undefined, {
			input: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz1234567890'",
			output: "200 OK",
			evidence: ["token=sk-abcdefghijklmnopqrstuvwxyz1234567890"],
		});
		expect(record.input).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
		expect(record.evidence.join("")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
		expect(record.privacy_labels).toContain("secret");
	});

	test("stamps a causal_id link when a child action is recorded against a parent action's id", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		const parent = recorder.record("mcp_call", undefined, {
			input: "tools/call diagnose",
			output: "ok",
			evidence: [],
		});
		const child = recorder.record("tool_call", parent.id, {
			input: "run pytest",
			output: "1 failed",
			evidence: [],
		});
		expect(child.causal_id).toBe(parent.id);
	});

	test("every action kind in ACTION_KINDS can be recorded", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		for (const kind of ACTION_KINDS) {
			const record = recorder.record(kind, undefined, {
				input: "x",
				output: "y",
				evidence: [],
			});
			expect(record.kind).toBe(kind);
		}
	});
});

describe("validateActionLog", () => {
	test("a causal_id referencing an action that does not exist is invalid", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		const record = recorder.record("tool_call", "nonexistent-id", {
			input: "x",
			output: "y",
			evidence: [],
		});
		const result = validateActionLog([record]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("nonexistent-id"))).toBe(true);
	});

	test("a causal_id pointing FORWARD (to a later action) is invalid", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		const a = recorder.record("tool_call", undefined, { input: "a", output: "a", evidence: [] });
		const b = recorder.record("tool_call", undefined, { input: "b", output: "b", evidence: [] });
		// Manually corrupt: make the earlier action claim to be caused by the later one.
		const corrupted = { ...a, causal_id: b.id };
		const result = validateActionLog([corrupted, b]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("forward"))).toBe(true);
	});

	test("a well-formed log with a valid causal chain is valid", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		const parent = recorder.record("mcp_call", undefined, {
			input: "a",
			output: "a",
			evidence: [],
		});
		recorder.record("tool_call", parent.id, { input: "b", output: "b", evidence: [] });
		const result = validateActionLog(recorder.actions());
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("gradeActionLog", () => {
	test("deterministic replay: grading the same log twice yields identical results", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		recorder.record("mcp_call", undefined, {
			input: "a",
			output: "a",
			evidence: ["evidence-1"],
		});
		const records = recorder.actions();
		const grade1 = gradeActionLog(records);
		const grade2 = gradeActionLog(records);
		expect(grade1).toEqual(grade2);
	});

	test("actions with no evidence attached are flagged under_evidenced below the completeness threshold", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		recorder.record("tool_call", undefined, { input: "a", output: "a", evidence: [] });
		recorder.record("tool_call", undefined, { input: "b", output: "b", evidence: [] });
		const report = gradeActionLog(recorder.actions());
		expect(report.verdict).toBe("under_evidenced");
		expect(report.evidence_completeness).toBe(0);
	});

	test("a fully evidenced log is graded well_evidenced and counts actions by kind", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		recorder.record("mcp_call", undefined, { input: "a", output: "a", evidence: ["e1"] });
		recorder.record("file_op", undefined, { input: "b", output: "b", evidence: ["e2"] });
		const report = gradeActionLog(recorder.actions());
		expect(report.verdict).toBe("well_evidenced");
		expect(report.by_kind.mcp_call).toBe(1);
		expect(report.by_kind.file_op).toBe(1);
	});
});

describe("toJsonl / fromJsonl", () => {
	test("round-trips a recorded action log", () => {
		const recorder = new ActionRecorder({ task_id: "t1" });
		recorder.record("a2a_message", undefined, { input: "hi", output: "ack", evidence: [] });
		const jsonl = toJsonl(recorder.actions());
		const parsed = fromJsonl(jsonl);
		expect(parsed).toEqual(recorder.actions());
	});
});
