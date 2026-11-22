/**
 * Causal continuity across agent/operator handoffs (item 49 — preserve
 * incident hypotheses, rejected causes, evidence budgets, privacy
 * decisions, ownership, and recovery state across handoffs without
 * stale-confidence inheritance).
 */
import { describe, expect, test } from "bun:test";
import {
	type HandoffPackage,
	STALE_POSTERIOR_CEILING,
	buildHandoffPackage,
	receiveHandoff,
	renderHandoffReceipt,
} from "../../src/diagnosis/handoff-continuity.js";
import type { Hypothesis } from "../../src/diagnosis/hypothesis.js";

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
	return {
		id: "h1",
		failure_id: "f1",
		level: "function",
		statement: "auth.py reads a key that may be absent",
		location: "auth.py:42",
		prior: 0.5,
		posterior: 0.8,
		status: "open",
		observations: [],
		...overrides,
	};
}

function basePackage(overrides: Partial<HandoffPackage> = {}): HandoffPackage {
	return buildHandoffPackage({
		handoff_id: "ho1",
		failure_id: "f1",
		captured_at_ms: 1_000_000,
		hypotheses: [hyp()],
		abandoned_with_reasons: [],
		evidence_spent: { storage_bytes: 100, runtime_ms: 50 },
		privacy_floor: { pii: "hash" },
		ownership: { current_owner: "agent-a", owner_kind: "agent" },
		recovery_state: { run_id: "run1", phase: "attribute", status: "in_progress" },
		...overrides,
	});
}

describe("buildHandoffPackage", () => {
	test("maps abandoned_with_reasons into rejected_causes using the hypothesis statement/location", () => {
		const h = hyp({ id: "h2", status: "abandoned" });
		const pkg = buildHandoffPackage({
			handoff_id: "ho1",
			failure_id: "f1",
			captured_at_ms: 1000,
			hypotheses: [h],
			abandoned_with_reasons: [{ id: "h2", reason: "ruled out by probe" }],
			evidence_spent: { storage_bytes: 0, runtime_ms: 0 },
			privacy_floor: {},
			ownership: { current_owner: "agent-a", owner_kind: "agent" },
			recovery_state: { run_id: "run1", phase: "detect", status: "in_progress" },
		});
		expect(pkg.rejected_causes).toEqual([
			{
				hypothesis_id: "h2",
				statement: h.statement,
				location: h.location,
				reason: "ruled out by probe",
			},
		]);
	});
});

describe("receiveHandoff — staleness", () => {
	test("within threshold: posteriors are inherited verbatim", () => {
		const pkg = basePackage();
		const result = receiveHandoff(pkg, { now_ms: 1_000_500, staleness_threshold_ms: 60_000 });
		expect(result.within_staleness_threshold).toBe(true);
		expect(result.effective_hypotheses[0].posterior).toBe(0.8);
		expect(result.stale_hypotheses).toEqual([]);
	});

	test("past threshold: an open hypothesis above the ceiling is capped and reported", () => {
		const pkg = basePackage();
		const result = receiveHandoff(pkg, { now_ms: 2_000_000, staleness_threshold_ms: 60_000 });
		expect(result.within_staleness_threshold).toBe(false);
		expect(result.effective_hypotheses[0].posterior).toBe(STALE_POSTERIOR_CEILING);
		expect(result.effective_hypotheses[0].status).toBe("open");
		expect(result.stale_hypotheses).toHaveLength(1);
		expect(result.stale_hypotheses[0].original_posterior).toBe(0.8);
	});

	test("past threshold: a confirmed hypothesis above the ceiling is also capped and downgraded to open", () => {
		const pkg = basePackage({ hypotheses: [hyp({ status: "confirmed", posterior: 0.95 })] });
		const result = receiveHandoff(pkg, { now_ms: 2_000_000, staleness_threshold_ms: 60_000 });
		expect(result.effective_hypotheses[0].status).toBe("open");
		expect(result.effective_hypotheses[0].posterior).toBe(STALE_POSTERIOR_CEILING);
	});

	test("past threshold: a refuted hypothesis is never revived or capped", () => {
		const pkg = basePackage({ hypotheses: [hyp({ status: "refuted", posterior: 0.01 })] });
		const result = receiveHandoff(pkg, { now_ms: 2_000_000, staleness_threshold_ms: 60_000 });
		expect(result.effective_hypotheses[0].status).toBe("refuted");
		expect(result.effective_hypotheses[0].posterior).toBe(0.01);
		expect(result.stale_hypotheses).toEqual([]);
	});

	test("past threshold: an open hypothesis already below the ceiling is left untouched", () => {
		const pkg = basePackage({ hypotheses: [hyp({ posterior: 0.1 })] });
		const result = receiveHandoff(pkg, { now_ms: 2_000_000, staleness_threshold_ms: 60_000 });
		expect(result.effective_hypotheses[0].posterior).toBe(0.1);
		expect(result.stale_hypotheses).toEqual([]);
	});
});

describe("receiveHandoff — rejected causes never resurface", () => {
	test("reopening a rejected cause with no new reason is refused", () => {
		const h = hyp({ id: "h2", status: "abandoned" });
		const pkg = buildHandoffPackage({
			handoff_id: "ho1",
			failure_id: "f1",
			captured_at_ms: 1_000_000,
			hypotheses: [h],
			abandoned_with_reasons: [{ id: "h2", reason: "ruled out by probe" }],
			evidence_spent: { storage_bytes: 0, runtime_ms: 0 },
			privacy_floor: {},
			ownership: { current_owner: "agent-a", owner_kind: "agent" },
			recovery_state: { run_id: "run1", phase: "detect", status: "in_progress" },
		});
		const result = receiveHandoff(pkg, {
			now_ms: 1_000_500,
			staleness_threshold_ms: 60_000,
			new_hypotheses: [{ statement: h.statement, location: h.location }],
		});
		expect(result.refusals).toHaveLength(1);
		expect(result.refusals[0].code).toBe("revived_rejected_cause");
	});

	test("reopening a rejected cause WITH a new reason is allowed", () => {
		const h = hyp({ id: "h2", status: "abandoned" });
		const pkg = buildHandoffPackage({
			handoff_id: "ho1",
			failure_id: "f1",
			captured_at_ms: 1_000_000,
			hypotheses: [h],
			abandoned_with_reasons: [{ id: "h2", reason: "ruled out by probe" }],
			evidence_spent: { storage_bytes: 0, runtime_ms: 0 },
			privacy_floor: {},
			ownership: { current_owner: "agent-a", owner_kind: "agent" },
			recovery_state: { run_id: "run1", phase: "detect", status: "in_progress" },
		});
		const result = receiveHandoff(pkg, {
			now_ms: 1_000_500,
			staleness_threshold_ms: 60_000,
			new_hypotheses: [
				{
					statement: h.statement,
					location: h.location,
					reason_for_reopening: "new log line found that contradicts the earlier rejection",
				},
			],
		});
		expect(result.refusals).toEqual([]);
	});

	test("a never-rejected candidate statement is never refused", () => {
		const pkg = basePackage();
		const result = receiveHandoff(pkg, {
			now_ms: 1_000_500,
			staleness_threshold_ms: 60_000,
			new_hypotheses: [{ statement: "a totally new statement" }],
		});
		expect(result.refusals).toEqual([]);
	});
});

describe("receiveHandoff — privacy floor ratchet", () => {
	test("a receiver declaring a looser action than the sender's enforced floor is refused", () => {
		const pkg = basePackage({ privacy_floor: { pii: "hash" } });
		const result = receiveHandoff(pkg, {
			now_ms: 1_000_500,
			staleness_threshold_ms: 60_000,
			declared_privacy_floor: { pii: "allow" },
		});
		expect(result.refusals).toHaveLength(1);
		expect(result.refusals[0].code).toBe("privacy_loosened");
	});

	test("a receiver declaring an equally or more strict action is allowed", () => {
		const pkg = basePackage({ privacy_floor: { pii: "hash" } });
		const result = receiveHandoff(pkg, {
			now_ms: 1_000_500,
			staleness_threshold_ms: 60_000,
			declared_privacy_floor: { pii: "drop" },
		});
		expect(result.refusals).toEqual([]);
	});
});

describe("receiveHandoff — ownership must be reassigned", () => {
	test("previous_owner equal to current_owner is refused", () => {
		const pkg = basePackage({
			ownership: { current_owner: "agent-a", owner_kind: "agent", previous_owner: "agent-a" },
		});
		const result = receiveHandoff(pkg, { now_ms: 1_000_500, staleness_threshold_ms: 60_000 });
		expect(result.refusals).toHaveLength(1);
		expect(result.refusals[0].code).toBe("ownership_unchanged");
	});

	test("a genuine reassignment is allowed", () => {
		const pkg = basePackage({
			ownership: { current_owner: "operator-1", owner_kind: "operator", previous_owner: "agent-a" },
		});
		const result = receiveHandoff(pkg, { now_ms: 1_000_500, staleness_threshold_ms: 60_000 });
		expect(result.refusals).toEqual([]);
	});

	test("the first-ever owner (no previous_owner) is never flagged", () => {
		const pkg = basePackage({ ownership: { current_owner: "agent-a", owner_kind: "agent" } });
		const result = receiveHandoff(pkg, { now_ms: 1_000_500, staleness_threshold_ms: 60_000 });
		expect(result.refusals).toEqual([]);
	});
});

describe("receiveHandoff — recovery state cannot be rewound", () => {
	test("declaring an earlier phase than the package's recorded phase is refused", () => {
		const pkg = basePackage({
			recovery_state: { run_id: "run1", phase: "rerun", status: "in_progress" },
		});
		const result = receiveHandoff(pkg, {
			now_ms: 1_000_500,
			staleness_threshold_ms: 60_000,
			declared_recovery_phase: "attribute",
		});
		expect(result.refusals).toHaveLength(1);
		expect(result.refusals[0].code).toBe("recovery_rewound");
	});

	test("declaring the same or a later phase is allowed", () => {
		const pkg = basePackage({
			recovery_state: { run_id: "run1", phase: "attribute", status: "in_progress" },
		});
		const result = receiveHandoff(pkg, {
			now_ms: 1_000_500,
			staleness_threshold_ms: 60_000,
			declared_recovery_phase: "recover",
		});
		expect(result.refusals).toEqual([]);
	});
});

describe("renderHandoffReceipt", () => {
	test("renders stale hypotheses and refusals", () => {
		const pkg = basePackage();
		const result = receiveHandoff(pkg, {
			now_ms: 2_000_000,
			staleness_threshold_ms: 60_000,
			declared_privacy_floor: { pii: "allow" },
		});
		const text = renderHandoffReceipt(result);
		expect(text).toContain("Handoff Continuity Report");
		expect(text).toContain("Stale hypotheses capped on inheritance");
		expect(text).toContain("privacy_loosened");
	});

	test("renders 'No continuity violations detected.' when nothing is refused and nothing is stale", () => {
		const pkg = basePackage();
		const result = receiveHandoff(pkg, { now_ms: 1_000_500, staleness_threshold_ms: 60_000 });
		const text = renderHandoffReceipt(result);
		expect(text).toContain("No continuity violations detected.");
	});
});
