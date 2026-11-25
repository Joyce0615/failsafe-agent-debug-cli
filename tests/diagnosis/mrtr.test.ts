/**
 * MRTR stall & response-mismatch diagnosis tests (item 51 — diagnose
 * input-required round stalls, missing/replayed responses, request-state
 * mismatch, retry parameter drift, and infinite input loops).
 */
import { describe, expect, test } from "bun:test";
import {
	MAX_ROUND_REPEATS,
	type MrtrRound,
	diagnoseMrtrExchange,
	diagnoseMrtrStalls,
	renderMrtrReport,
} from "../../src/diagnosis/mrtr.js";

describe("diagnoseMrtrStalls: missing_response", () => {
	test("an input_required round with no response is a missing_response stall", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
		];
		const findings = diagnoseMrtrStalls(rounds);
		expect(findings).toHaveLength(1);
		expect(findings[0].kind).toBe("missing_response");
		expect(findings[0].round_id).toBe("r1");
	});

	test("an input_required round WITH a response is not a stall", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "response", request_state: "s1", payload: "answer" },
		];
		expect(diagnoseMrtrStalls(rounds)).toHaveLength(0);
	});
});

describe("diagnoseMrtrStalls: replayed_response", () => {
	test("two responses for the same round_id are reported, with identical payload noted", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "response", request_state: "s1", payload: "answer" },
			{ sequence: 3, round_id: "r1", kind: "response", request_state: "s1", payload: "answer" },
		];
		const findings = diagnoseMrtrStalls(rounds);
		const replay = findings.find((f) => f.kind === "replayed_response");
		expect(replay).toBeDefined();
		expect(replay?.detail).toContain("identical");
	});

	test("two DIFFERING responses for the same round_id are flagged as conflicting, not merely duplicate", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "response", request_state: "s1", payload: "answer-a" },
			{ sequence: 3, round_id: "r1", kind: "response", request_state: "s1", payload: "answer-b" },
		];
		const findings = diagnoseMrtrStalls(rounds);
		const replay = findings.find((f) => f.kind === "replayed_response");
		expect(replay?.detail).toContain("DIFFERENT");
	});
});

describe("diagnoseMrtrStalls: request_state_mismatch", () => {
	test("a response whose request_state does not match the latest preceding ask is a mismatch", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "input_required", request_state: "s2" },
			{
				sequence: 3,
				round_id: "r1",
				kind: "response",
				request_state: "s1",
				payload: "late-answer",
			},
		];
		const findings = diagnoseMrtrStalls(rounds);
		const mismatch = findings.find((f) => f.kind === "request_state_mismatch");
		expect(mismatch).toBeDefined();
		expect(mismatch?.detail).toContain("no longer applies");
	});

	test("a response whose request_state matches the latest ask is not a mismatch", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "input_required", request_state: "s2" },
			{ sequence: 3, round_id: "r1", kind: "response", request_state: "s2", payload: "ok" },
		];
		const findings = diagnoseMrtrStalls(rounds);
		expect(findings.find((f) => f.kind === "request_state_mismatch")).toBeUndefined();
	});
});

describe("diagnoseMrtrStalls: retry_parameter_drift", () => {
	test("two input_required rounds with differing retry_params for the same round_id drift", () => {
		const rounds: MrtrRound[] = [
			{
				sequence: 1,
				round_id: "r1",
				kind: "input_required",
				request_state: "s1",
				retry_params: { field: "email" },
			},
			{
				sequence: 2,
				round_id: "r1",
				kind: "input_required",
				request_state: "s2",
				retry_params: { field: "phone" },
			},
		];
		const findings = diagnoseMrtrStalls(rounds);
		const drift = findings.find((f) => f.kind === "retry_parameter_drift");
		expect(drift).toBeDefined();
	});

	test("two input_required rounds with IDENTICAL retry_params do not drift", () => {
		const rounds: MrtrRound[] = [
			{
				sequence: 1,
				round_id: "r1",
				kind: "input_required",
				request_state: "s1",
				retry_params: { field: "email" },
			},
			{
				sequence: 2,
				round_id: "r1",
				kind: "input_required",
				request_state: "s2",
				retry_params: { field: "email" },
			},
		];
		const findings = diagnoseMrtrStalls(rounds);
		expect(findings.find((f) => f.kind === "retry_parameter_drift")).toBeUndefined();
	});
});

describe("diagnoseMrtrStalls: infinite_input_loop", () => {
	test("MAX_ROUND_REPEATS or more unanswered asks for the same round_id is a loop, not N missing_response findings", () => {
		const rounds: MrtrRound[] = Array.from({ length: MAX_ROUND_REPEATS }, (_, i) => ({
			sequence: i + 1,
			round_id: "r1",
			kind: "input_required" as const,
			request_state: `s${i + 1}`,
		}));
		const findings = diagnoseMrtrStalls(rounds);
		expect(findings).toHaveLength(1);
		expect(findings[0].kind).toBe("infinite_input_loop");
		expect(findings[0].evidence_sequences).toHaveLength(MAX_ROUND_REPEATS);
	});

	test("fewer than MAX_ROUND_REPEATS unanswered asks is a plain missing_response, not a loop", () => {
		const rounds: MrtrRound[] = Array.from({ length: MAX_ROUND_REPEATS - 1 }, (_, i) => ({
			sequence: i + 1,
			round_id: "r1",
			kind: "input_required" as const,
			request_state: `s${i + 1}`,
		}));
		const findings = diagnoseMrtrStalls(rounds);
		expect(findings).toHaveLength(1);
		expect(findings[0].kind).toBe("missing_response");
	});
});

describe("diagnoseMrtrExchange: first_violated_round", () => {
	test("names the earliest-sequence finding across multiple round_ids", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "response", request_state: "s1", payload: "ok" },
			{ sequence: 3, round_id: "r2", kind: "input_required", request_state: "t1" },
			// r2 never answered -> missing_response at sequence 3
			{ sequence: 4, round_id: "r3", kind: "input_required", request_state: "u1" },
			{ sequence: 5, round_id: "r3", kind: "input_required", request_state: "u2" },
			{
				sequence: 6,
				round_id: "r3",
				kind: "response",
				request_state: "u1",
				payload: "late",
			},
		];
		const report = diagnoseMrtrExchange(rounds);
		expect(report.first_violated_round).not.toBeNull();
		expect(report.first_violated_round?.round_id).toBe("r2");
		expect(report.first_violated_round?.kind).toBe("missing_response");
	});

	test("an exchange with no violations reports first_violated_round: null", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "response", request_state: "s1", payload: "ok" },
		];
		const report = diagnoseMrtrExchange(rounds);
		expect(report.first_violated_round).toBeNull();
		expect(report.findings).toEqual([]);
	});
});

describe("renderMrtrReport", () => {
	test("renders the first violated round and every finding", () => {
		const rounds: MrtrRound[] = [
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
		];
		const report = diagnoseMrtrExchange(rounds);
		const text = renderMrtrReport(report);
		expect(text).toContain("MRTR Stall & Response Mismatch Report");
		expect(text).toContain("First violated round");
		expect(text).toContain("missing_response");
	});

	test("renders a clean exchange with no violations", () => {
		const report = diagnoseMrtrExchange([
			{ sequence: 1, round_id: "r1", kind: "input_required", request_state: "s1" },
			{ sequence: 2, round_id: "r1", kind: "response", request_state: "s1", payload: "ok" },
		]);
		const text = renderMrtrReport(report);
		expect(text).toContain("No MRTR violations found.");
	});
});
