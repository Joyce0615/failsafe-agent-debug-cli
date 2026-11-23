/**
 * Trusted-state contamination forensic detection tests (item 55 —
 * distinguish genuine containment from recovery that merely injects an
 * oracle or already-trusted snapshot).
 */
import { describe, expect, test } from "bun:test";
import type { Checkpoint } from "../../src/debug/time-travel.js";
import {
	type RepairAttempt,
	classifyRepairAttempt,
	diagnoseRepairAttempts,
	renderContaminationReport,
} from "../../src/diagnosis/trusted-state-contamination.js";
import type { RecoveryAction } from "../../src/diagnosis/recovery-packet.js";
import type { StateDelta } from "../../src/types/debug.js";

function checkpoint(id: string, sequence: number): Checkpoint {
	return {
		checkpoint_id: id,
		sequence,
		snapshot: { thread_id: "t1", frame_id: "f1", location: { file: "a.py", line: 1 }, scopes: [] },
		delta: null,
	};
}

const action: RecoveryAction = {
	kind: "command",
	command: "pytest tests/test_x.py",
	rationale: "re-run the targeted test",
};

function deltaWith(overrides: Partial<StateDelta> = {}): StateDelta {
	return {
		debug_session_id: "s1",
		from_location: { file: "a.py", line: 1 },
		to_location: { file: "a.py", line: 2 },
		step_kind: "over",
		changed_variables: [],
		branch_events: [],
		exceptions: [],
		console_events: [],
		...overrides,
	};
}

function attempt(overrides: Partial<RepairAttempt> = {}): RepairAttempt {
	return {
		attempt_id: "attempt-1",
		pre_repair: checkpoint("cp-pre", 5),
		action,
		post_repair: checkpoint("cp-post", 6),
		recorded_delta: deltaWith(),
		...overrides,
	};
}

describe("classifyRepairAttempt: unverifiable", () => {
	test("no recorded delta at all is unverifiable, regardless of other evidence", () => {
		const a = attempt({ recorded_delta: null });
		const verdict = classifyRepairAttempt(a, new Set(["cp-post"]), new Set());
		expect(verdict.verdict).toBe("unverifiable");
	});

	test("unverifiable takes priority even when post_repair matches a trusted checkpoint", () => {
		const a = attempt({ recorded_delta: null, post_repair: checkpoint("cp-trusted", 6) });
		const verdict = classifyRepairAttempt(a, new Set(["cp-trusted"]), new Set());
		expect(verdict.verdict).toBe("unverifiable");
	});
});

describe("classifyRepairAttempt: oracle_injection", () => {
	test("matching a trusted checkpoint with zero recorded work is oracle_injection", () => {
		const a = attempt({
			post_repair: checkpoint("cp-trusted", 6),
			recorded_delta: deltaWith(),
		});
		const verdict = classifyRepairAttempt(a, new Set(["cp-trusted"]), new Set());
		expect(verdict.verdict).toBe("oracle_injection");
	});

	test("matching a trusted checkpoint WITH substantial recorded work is genuine, not oracle_injection", () => {
		const a = attempt({
			post_repair: checkpoint("cp-trusted", 6),
			recorded_delta: deltaWith({
				changed_variables: [{ name: "x", before: "1", after: "2" }],
			}),
		});
		const verdict = classifyRepairAttempt(a, new Set(["cp-trusted"]), new Set());
		expect(verdict.verdict).toBe("genuine");
	});

	test("a console event alone counts as recorded work, preventing oracle_injection", () => {
		const a = attempt({
			post_repair: checkpoint("cp-trusted", 6),
			recorded_delta: deltaWith({
				console_events: [{ category: "stdout", text: "fixed" }],
			}),
		});
		const verdict = classifyRepairAttempt(a, new Set(["cp-trusted"]), new Set());
		expect(verdict.verdict).toBe("genuine");
	});
});

describe("classifyRepairAttempt: stale_snapshot_reuse", () => {
	test("matching a prior checkpoint from earlier in the trajectory is stale_snapshot_reuse", () => {
		const a = attempt({
			post_repair: checkpoint("cp-old", 6),
			recorded_delta: deltaWith({
				changed_variables: [{ name: "x", before: "1", after: "2" }],
			}),
		});
		const verdict = classifyRepairAttempt(a, new Set(), new Set(["cp-old"]));
		expect(verdict.verdict).toBe("stale_snapshot_reuse");
	});

	test("stale_snapshot_reuse fires even with substantial recorded work", () => {
		const a = attempt({
			post_repair: checkpoint("cp-old", 6),
			recorded_delta: deltaWith({
				changed_variables: [{ name: "x", before: "1", after: "2" }],
				branch_events: [{ location: { file: "a.py", line: 2 }, taken: true }],
			}),
		});
		const verdict = classifyRepairAttempt(a, new Set(), new Set(["cp-old"]));
		expect(verdict.verdict).toBe("stale_snapshot_reuse");
	});
});

describe("classifyRepairAttempt: genuine", () => {
	test("a non-empty delta with a novel resulting state is genuine", () => {
		const a = attempt({
			post_repair: checkpoint("cp-new", 6),
			recorded_delta: deltaWith({
				changed_variables: [{ name: "x", before: "1", after: "2" }],
			}),
		});
		const verdict = classifyRepairAttempt(a, new Set(["cp-other-trusted"]), new Set(["cp-other-prior"]));
		expect(verdict.verdict).toBe("genuine");
	});
});

describe("diagnoseRepairAttempts", () => {
	test("names the first contaminated attempt, not later genuine ones", () => {
		const attempts = [
			attempt({ attempt_id: "a1", post_repair: checkpoint("cp1", 6), recorded_delta: deltaWith() }),
			attempt({
				attempt_id: "a2",
				post_repair: checkpoint("cp2", 7),
				recorded_delta: deltaWith({ changed_variables: [{ name: "x", before: "1", after: "2" }] }),
			}),
		];
		const report = diagnoseRepairAttempts(attempts, new Set(["cp1"]), new Set());
		expect(report.first_contaminated_attempt_id).toBe("a1");
	});

	test("reports undefined first_contaminated_attempt_id when all attempts are genuine", () => {
		const attempts = [
			attempt({
				attempt_id: "a1",
				post_repair: checkpoint("cp1", 6),
				recorded_delta: deltaWith({ changed_variables: [{ name: "x", before: "1", after: "2" }] }),
			}),
		];
		const report = diagnoseRepairAttempts(attempts, new Set(), new Set());
		expect(report.first_contaminated_attempt_id).toBeUndefined();
	});

	test("unverifiable attempts are not counted as contamination", () => {
		const attempts = [
			attempt({
				attempt_id: "a1",
				post_repair: checkpoint("cp1", 6),
				recorded_delta: deltaWith({ changed_variables: [{ name: "x", before: "1", after: "2" }] }),
			}),
			attempt({ attempt_id: "a2", post_repair: checkpoint("cp2", 7), recorded_delta: null }),
		];
		const report = diagnoseRepairAttempts(attempts, new Set(), new Set());
		expect(report.first_contaminated_attempt_id).toBeUndefined();
	});
});

describe("renderContaminationReport", () => {
	test("renders a report with no attempts", () => {
		const text = renderContaminationReport({ verdicts: [] });
		expect(text).toContain("No repair attempts supplied.");
	});

	test("renders a clean report naming no contamination", () => {
		const attempts = [
			attempt({
				attempt_id: "a1",
				post_repair: checkpoint("cp1", 6),
				recorded_delta: deltaWith({ changed_variables: [{ name: "x", before: "1", after: "2" }] }),
			}),
		];
		const report = diagnoseRepairAttempts(attempts, new Set(), new Set());
		const text = renderContaminationReport(report);
		expect(text).toContain("No contamination detected.");
	});

	test("renders the first contaminated attempt id", () => {
		const attempts = [
			attempt({ attempt_id: "a1", post_repair: checkpoint("cp1", 6), recorded_delta: deltaWith() }),
		];
		const report = diagnoseRepairAttempts(attempts, new Set(["cp1"]), new Set());
		const text = renderContaminationReport(report);
		expect(text).toContain("First contaminated attempt: a1");
	});
});
