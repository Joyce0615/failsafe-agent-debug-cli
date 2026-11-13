import { describe, expect, test } from "bun:test";
import {
	type AdjudicationLabel,
	type OperatorAdjudication,
	type PolicyChangeRequest,
	buildCalibrationSetFromAdjudications,
	classDrift,
	gateePolicyChange,
	recordAdjudication,
} from "../../src/diagnosis/operator-adjudication.js";

function adjudication(overrides: Partial<OperatorAdjudication> = {}): OperatorAdjudication {
	return {
		diagnosis_id: "diag-1",
		predicted_location: "src/foo.ts",
		predicted_confidence: 0.8,
		label: "accept",
		operator_id: "op-1",
		adjudicated_at_ms: 1000,
		...overrides,
	};
}

describe("recordAdjudication", () => {
	test("accepts a well-formed, blinded label", () => {
		const result = recordAdjudication([], adjudication());
		expect(result.ok).toBe(true);
	});

	test("refuses when the operator was shown the predicted confidence before labeling (not blinded)", () => {
		const result = recordAdjudication(
			[],
			adjudication({ operator_saw_confidence_before_labeling: true }),
		);
		expect(result.ok).toBe(false);
	});

	test("refuses a duplicate adjudication for the same diagnosis by the same operator", () => {
		const existing = [adjudication()];
		const result = recordAdjudication(existing, adjudication());
		expect(result.ok).toBe(false);
	});

	test("a corrected label requires a corrected_location, never silently blank", () => {
		const result = recordAdjudication(
			[],
			adjudication({ label: "corrected", corrected_location: undefined }),
		);
		expect(result.ok).toBe(false);
	});

	test("a corrected label with a corrected_location is accepted", () => {
		const result = recordAdjudication(
			[],
			adjudication({ label: "corrected", corrected_location: "src/bar.ts" }),
		);
		expect(result.ok).toBe(true);
	});
});

describe("buildCalibrationSetFromAdjudications", () => {
	test("accept maps to a correct prediction, reject/corrected map to incorrect", () => {
		const adjudications: OperatorAdjudication[] = [
			adjudication({ diagnosis_id: "d1", label: "accept" }),
			adjudication({ diagnosis_id: "d2", label: "reject", operator_id: "op-2" }),
			adjudication({
				diagnosis_id: "d3",
				label: "corrected",
				corrected_location: "src/bar.ts",
				operator_id: "op-3",
			}),
		];
		const predictions = buildCalibrationSetFromAdjudications(adjudications);
		expect(predictions).toHaveLength(3);
		const accepted = predictions.find((p) => p.id === "d1");
		expect(accepted?.ranked[0]).toBe(accepted?.truth);
		const rejected = predictions.find((p) => p.id === "d2");
		expect(rejected?.ranked[0]).not.toBe(rejected?.truth);
		const corrected = predictions.find((p) => p.id === "d3");
		expect(corrected?.truth).toBe("src/bar.ts");
	});
});

describe("classDrift", () => {
	// Interleaved labels with distinct, increasing timestamps: an alternating
	// accept/reject pattern at a fixed rate has no internal change point, so a
	// verdict of "no drift" reflects the windows' RATES agreeing, not an
	// artifact of label ordering within a window.
	function interleavedWindow(
		acceptCount: number,
		rejectCount: number,
		startMs: number,
		prefix: string,
	): OperatorAdjudication[] {
		const total = acceptCount + rejectCount;
		const acceptEvery = total / acceptCount;
		const out: OperatorAdjudication[] = [];
		let accepted = 0;
		for (let i = 0; i < total; i++) {
			const label: AdjudicationLabel =
				accepted < acceptCount && Math.floor(i / acceptEvery) > accepted - 1 ? "accept" : "reject";
			if (label === "accept") accepted++;
			out.push(
				adjudication({
					diagnosis_id: `${prefix}${i}`,
					label,
					operator_id: `${prefix}op${i}`,
					adjudicated_at_ms: startMs + i,
				}),
			);
		}
		return out;
	}

	test("identical label distributions across two windows report no drift", () => {
		const baseline = interleavedWindow(20, 10, 0, "b");
		const recent = interleavedWindow(20, 10, 1000, "r");
		const result = classDrift(baseline, recent);
		expect(result.drifted).toBe(false);
	});

	test("a shift in the accept rate between windows is reported as drift, not hidden", () => {
		const baseline = interleavedWindow(30, 5, 0, "b");
		const recent = interleavedWindow(5, 30, 1000, "r");
		const result = classDrift(baseline, recent);
		expect(result.drifted).toBe(true);
	});

	test("too few adjudications in either window refuses a verdict rather than guessing", () => {
		const result = classDrift(
			[adjudication({ diagnosis_id: "a" })],
			[adjudication({ diagnosis_id: "b", operator_id: "op-2" })],
		);
		expect(result.drifted).toBe(false);
		expect(result.insufficient_data).toBe(true);
	});
});

describe("gateePolicyChange", () => {
	function change(overrides: Partial<PolicyChangeRequest> = {}): PolicyChangeRequest {
		return {
			kind: "learned_ranking",
			policy_id: "policy-1",
			requested_by: "requester",
			...overrides,
		};
	}

	test("refuses a policy change with no approval grant", () => {
		const result = gateePolicyChange(change(), undefined);
		expect(result.allowed).toBe(false);
	});

	test("refuses self-approval (approver equals requester)", () => {
		const result = gateePolicyChange(change(), {
			approver: "requester",
			approved_at_ms: 1000,
		});
		expect(result.allowed).toBe(false);
	});

	test("allows a policy change approved by someone other than the requester", () => {
		const result = gateePolicyChange(change(), {
			approver: "reviewer",
			approved_at_ms: 1000,
		});
		expect(result.allowed).toBe(true);
	});

	test("refuses a stopping-policy change with no approval, same as a ranking-policy change", () => {
		const result = gateePolicyChange(change({ kind: "stopping_policy" }), undefined);
		expect(result.allowed).toBe(false);
	});
});
