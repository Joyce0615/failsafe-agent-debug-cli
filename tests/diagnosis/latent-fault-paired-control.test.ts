/**
 * Latent-fault diagnosis with paired controls tests (item 56 — align
 * failing traces with no-fault references to locate semantic
 * corruption, guardrail bypass, and ambiguous delegation invisible in
 * surface telemetry; reduce confidence or abstain without a comparable
 * branch).
 */
import { describe, expect, test } from "bun:test";
import {
	type PairedControlStep,
	type PairedControlTrajectory,
	diagnoseLatentFaults,
	renderLatentFaultReport,
} from "../../src/diagnosis/latent-fault-paired-control.js";

function step(overrides: Partial<PairedControlStep> = {}): PairedControlStep {
	return {
		id: "s1",
		action: "fetch_doc",
		outcome: "ok",
		...overrides,
	};
}

function trajectory(id: string, steps: PairedControlStep[]): PairedControlTrajectory {
	return { id, steps };
}

describe("diagnoseLatentFaults: semantic_corruption", () => {
	test("a matched step with differing result fingerprints is flagged", () => {
		const failing = trajectory("f1", [step({ result_fingerprint: "hash-stale" })]);
		const control = trajectory("c1", [step({ result_fingerprint: "hash-fresh" })]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.some((f) => f.kind === "semantic_corruption")).toBe(true);
	});

	test("a matched step with identical result fingerprints is not flagged", () => {
		const failing = trajectory("f1", [step({ result_fingerprint: "hash-same" })]);
		const control = trajectory("c1", [step({ result_fingerprint: "hash-same" })]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.find((f) => f.kind === "semantic_corruption")).toBeUndefined();
		expect(report.confidence).toBe("full");
	});

	test("missing a result_fingerprint on either side abstains rather than guessing", () => {
		const failing = trajectory("f1", [step({})]);
		const control = trajectory("c1", [step({ result_fingerprint: "hash-fresh" })]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.find((f) => f.kind === "semantic_corruption")).toBeUndefined();
		expect(report.abstained_steps.length).toBe(1);
	});
});

describe("diagnoseLatentFaults: guardrail_bypass", () => {
	test("a control block decision with no matching failing decision is flagged", () => {
		const failing = trajectory("f1", [step({})]);
		const control = trajectory("c1", [
			step({ guardrail_decision: { guardrail_id: "g1", decision: "block" } }),
		]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.some((f) => f.kind === "guardrail_bypass")).toBe(true);
	});

	test("a control warn decision with the failing run allowing is flagged", () => {
		const failing = trajectory("f1", [
			step({ guardrail_decision: { guardrail_id: "g1", decision: "allow" } }),
		]);
		const control = trajectory("c1", [
			step({ guardrail_decision: { guardrail_id: "g1", decision: "warn" } }),
		]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.some((f) => f.kind === "guardrail_bypass")).toBe(true);
	});

	test("both runs blocking is not flagged", () => {
		const failing = trajectory("f1", [
			step({ guardrail_decision: { guardrail_id: "g1", decision: "block" } }),
		]);
		const control = trajectory("c1", [
			step({ guardrail_decision: { guardrail_id: "g1", decision: "block" } }),
		]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.find((f) => f.kind === "guardrail_bypass")).toBeUndefined();
	});

	test("control allowing is never flagged regardless of failing side", () => {
		const failing = trajectory("f1", [step({})]);
		const control = trajectory("c1", [
			step({ guardrail_decision: { guardrail_id: "g1", decision: "allow" } }),
		]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.find((f) => f.kind === "guardrail_bypass")).toBeUndefined();
	});
});

describe("diagnoseLatentFaults: ambiguous_delegation", () => {
	test("a control delegation with no failing delegate is flagged", () => {
		const failing = trajectory("f1", [step({})]);
		const control = trajectory("c1", [step({ delegate_actor_id: "agent-a" })]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.some((f) => f.kind === "ambiguous_delegation")).toBe(true);
	});

	test("a matching delegate on both sides is not flagged", () => {
		const failing = trajectory("f1", [step({ delegate_actor_id: "agent-a" })]);
		const control = trajectory("c1", [step({ delegate_actor_id: "agent-a" })]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.find((f) => f.kind === "ambiguous_delegation")).toBeUndefined();
	});

	test("no delegation point in the control means no finding even with no failing delegate", () => {
		const failing = trajectory("f1", [step({})]);
		const control = trajectory("c1", [step({})]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings.find((f) => f.kind === "ambiguous_delegation")).toBeUndefined();
	});
});

describe("diagnoseLatentFaults: non-match pairs are left to trajectory-diff.ts", () => {
	test("a different action between failing and control produces no latent-fault findings for that step", () => {
		const failing = trajectory("f1", [step({ action: "write_file" })]);
		const control = trajectory("c1", [step({ action: "read_file" })]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.findings).toEqual([]);
	});
});

describe("diagnoseLatentFaults: confidence and abstention", () => {
	test("zero comparable (match) steps yields confidence 'abstained'", () => {
		const failing = trajectory("f1", [step({ action: "write_file" })]);
		const control = trajectory("c1", [step({ action: "read_file" })]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.confidence).toBe("abstained");
	});

	test("some abstained steps alongside at least one evaluated step yields 'reduced'", () => {
		const failing = trajectory("f1", [
			step({ id: "s1", result_fingerprint: "h1" }),
			step({ id: "s2", action: "other_action" }),
		]);
		const control = trajectory("c1", [
			step({ id: "s1", result_fingerprint: "h1" }),
			step({ id: "s2", action: "other_action" }),
		]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.confidence).toBe("reduced");
	});

	test("first_finding names the earliest finding by failing index", () => {
		const failing = trajectory("f1", [
			step({ id: "s1", result_fingerprint: "stale" }),
			step({ id: "s2", delegate_actor_id: undefined }),
		]);
		const control = trajectory("c1", [
			step({ id: "s1", result_fingerprint: "fresh" }),
			step({ id: "s2", delegate_actor_id: "agent-a" }),
		]);
		const report = diagnoseLatentFaults(failing, control);
		expect(report.first_finding?.at_failing_index).toBe(0);
	});
});

describe("renderLatentFaultReport", () => {
	test("renders an abstained report with no comparable branch", () => {
		const failing = trajectory("f1", [step({ action: "write_file" })]);
		const control = trajectory("c1", [step({ action: "read_file" })]);
		const report = diagnoseLatentFaults(failing, control);
		const text = renderLatentFaultReport(report);
		expect(text).toContain("No comparable branch");
	});

	test("renders a clean report with no findings", () => {
		const failing = trajectory("f1", [step({ result_fingerprint: "h1" })]);
		const control = trajectory("c1", [step({ result_fingerprint: "h1" })]);
		const report = diagnoseLatentFaults(failing, control);
		const text = renderLatentFaultReport(report);
		expect(text).toContain("No latent faults found");
	});

	test("renders a finding and an abstained step together", () => {
		const failing = trajectory("f1", [step({})]);
		const control = trajectory("c1", [
			step({ guardrail_decision: { guardrail_id: "g1", decision: "block" } }),
		]);
		const report = diagnoseLatentFaults(failing, control);
		const text = renderLatentFaultReport(report);
		expect(text).toContain("guardrail_bypass");
	});
});
