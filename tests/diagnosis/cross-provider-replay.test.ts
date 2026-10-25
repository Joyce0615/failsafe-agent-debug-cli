import { describe, expect, test } from "bun:test";
import {
	MAX_REDACTION_RATE,
	MIN_PROVIDERS,
	PROVIDER_IDENTITY_FIELDS,
	type ProviderRun,
	diffDiagnoses,
	diffRemediation,
	gateCrossProviderReplay,
	renderCrossProviderReplay,
	resolveEvidenceFidelity,
	resolveProviderIdentity,
} from "../../src/diagnosis/cross-provider-replay.js";
import type { RemediationContext } from "../../src/remediation/modes.js";
import { recommend } from "../../src/remediation/modes.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";

function diagnosis(overrides: Partial<FailureDiagnosis> = {}): FailureDiagnosis {
	return {
		schema_version: SCHEMA_VERSION,
		diagnosis_id: "d1",
		failure_id: "f1",
		failure_type: "runtime_exception",
		severity: "error",
		summary: "boom",
		root_cause: { category: "null_reference", explanation: "x is null", confidence: 0.8 },
		evidence: [{ kind: "stack_frame", value: "a" }],
		uncertainty: [],
		minimal_context: [],
		suggested_next_actions: [],
		...overrides,
	};
}

function remediationContext(overrides: Partial<RemediationContext> = {}): RemediationContext {
	return {
		cause: "regression",
		previous_version: "1.2.3",
		previous_version_deployable: true,
		...overrides,
	};
}

// --- REAL GAP (closed by this item): nothing combines provider-identity
// resolution (genai-normalize) + diagnosis comparison (types/diagnosis) +
// remediation recommendation (remediation/modes) in one module.
describe("sanity: no pre-existing module combines these three", () => {
	test("resolveField resolves one field at a time with no notion of a 'run' or comparison", () => {
		// PROVIDER_IDENTITY_FIELDS exists only in the new module -- it is not a
		// re-export of something that already existed combining these fields
		// for comparison purposes.
		expect(PROVIDER_IDENTITY_FIELDS).toEqual(["provider", "model", "agent_version"]);
	});
});

// --- 1. provider identity ----------------------------------------------------
describe("resolveProviderIdentity", () => {
	test("pins when every identity field resolves cleanly", () => {
		const r = resolveProviderIdentity("run1", {
			"gen_ai.provider.name": "anthropic",
			"gen_ai.request.model": "claude-x",
			"gen_ai.agent.version": "1.0.0",
		});
		expect(r.pinned).toBe(true);
		expect(r.identity.provider).toBe("anthropic");
		expect(r.identity.model).toBe("claude-x");
		expect(r.reasons).toEqual([]);
	});

	test("refuses to pin when a field is missing entirely", () => {
		const r = resolveProviderIdentity("run1", {
			"gen_ai.provider.name": "anthropic",
		});
		expect(r.pinned).toBe(false);
		expect(r.reasons.some((reason) => reason.includes("'model'"))).toBe(true);
	});

	test("refuses to pin when two aliases disagree on the same field", () => {
		const r = resolveProviderIdentity("run1", {
			"gen_ai.provider.name": "anthropic",
			"gen_ai.system": "openai",
			"gen_ai.request.model": "claude-x",
			"gen_ai.agent.version": "1.0.0",
		});
		expect(r.pinned).toBe(false);
		expect(r.reasons.some((reason) => reason.includes("conflicted"))).toBe(true);
	});

	test("the same number under two alias names is NOT a conflict", () => {
		const r = resolveProviderIdentity("run1", {
			"gen_ai.provider.name": "anthropic",
			"gen_ai.system": "anthropic",
			"gen_ai.request.model": "claude-x",
			"gen_ai.agent.version": "1.0.0",
		});
		expect(r.pinned).toBe(true);
	});
});

// --- 2. evidence fidelity ----------------------------------------------------
describe("resolveEvidenceFidelity", () => {
	test("faithful when there is no truncation, no structural issues, and no redaction", () => {
		const f = resolveEvidenceFidelity({ run_id: "r1" });
		expect(f.faithful).toBe(true);
		expect(f.reasons).toEqual([]);
	});

	test("truncation alone is enough to make evidence unfaithful", () => {
		const f = resolveEvidenceFidelity({ run_id: "r1", trace_truncated: true });
		expect(f.faithful).toBe(false);
		expect(f.reasons[0]).toContain("truncated");
	});

	test("structural issues alone are enough", () => {
		const f = resolveEvidenceFidelity({ run_id: "r1", structure_issues: 3 });
		expect(f.faithful).toBe(false);
		expect(f.reasons[0]).toContain("structural issue");
	});

	test("a redaction rate at or below the ceiling is still faithful", () => {
		const f = resolveEvidenceFidelity({
			run_id: "r1",
			redacted_events: 5,
			total_events: 10,
		});
		expect(f.redaction_rate).toBe(0.5);
		expect(f.redaction_rate).toBeLessThanOrEqual(MAX_REDACTION_RATE);
		expect(f.faithful).toBe(true);
	});

	test("a redaction rate above the ceiling is NOT faithful", () => {
		const f = resolveEvidenceFidelity({
			run_id: "r1",
			redacted_events: 6,
			total_events: 10,
		});
		expect(f.faithful).toBe(false);
		expect(f.reasons[0]).toContain("redacted");
	});
});

// --- 3. diagnosis drift -------------------------------------------------------
describe("diffDiagnoses", () => {
	test("identical root-cause categories across runs agree", () => {
		const runs: ProviderRun[] = [
			{ run_id: "a", diagnosis: diagnosis() },
			{ run_id: "b", diagnosis: diagnosis() },
		];
		const drift = diffDiagnoses(runs);
		expect(drift.category_agreement).toBe(true);
		expect(drift.confidence_spread).toBe(0);
		expect(drift.evidence_kind_overlap).toBe(1);
	});

	test("different root-cause categories disagree, reported by name not by a blended score", () => {
		const runs: ProviderRun[] = [
			{ run_id: "a", diagnosis: diagnosis() },
			{
				run_id: "b",
				diagnosis: diagnosis({
					root_cause: { category: "type_error", explanation: "y", confidence: 0.6 },
				}),
			},
		];
		const drift = diffDiagnoses(runs);
		expect(drift.category_agreement).toBe(false);
		expect(Object.keys(drift.categories).sort()).toEqual(["null_reference", "type_error"]);
		expect(drift.confidence_spread).toBeCloseTo(0.2, 5);
	});

	test("disjoint evidence-kind sets produce zero overlap", () => {
		const runs: ProviderRun[] = [
			{ run_id: "a", diagnosis: diagnosis({ evidence: [{ kind: "stack_frame", value: "x" }] }) },
			{ run_id: "b", diagnosis: diagnosis({ evidence: [{ kind: "git_diff", value: "y" }] }) },
		];
		const drift = diffDiagnoses(runs);
		expect(drift.evidence_kind_overlap).toBe(0);
	});

	test("runs with no root_cause at all are excluded from category/confidence comparison", () => {
		const runs: ProviderRun[] = [
			{ run_id: "a", diagnosis: diagnosis({ root_cause: undefined }) },
			{ run_id: "b", diagnosis: diagnosis({ root_cause: undefined }) },
		];
		const drift = diffDiagnoses(runs);
		expect(drift.category_agreement).toBe(true);
		expect(drift.confidence_spread).toBe(0);
		expect(Object.keys(drift.categories)).toEqual([]);
	});
});

// --- remediation drift --------------------------------------------------------
describe("diffRemediation", () => {
	test("returns null when no run carries a recommendation", () => {
		const runs: ProviderRun[] = [{ run_id: "a", diagnosis: diagnosis() }];
		expect(diffRemediation(runs)).toBeNull();
	});

	test("agreeing recommended mode sets agree", () => {
		const rec = recommend(remediationContext());
		const runs: ProviderRun[] = [
			{ run_id: "a", diagnosis: diagnosis(), recommendation: rec },
			{ run_id: "b", diagnosis: diagnosis(), recommendation: rec },
		];
		const drift = diffRemediation(runs);
		expect(drift?.mode_set_agreement).toBe(true);
	});

	test("disagreeing recommended mode sets are reported by name, not a blended score", () => {
		const recA = recommend(remediationContext({ cause: "regression" }));
		const recB = recommend(
			remediationContext({ cause: "transient_dependency", failure_is_transient: true }),
		);
		const runs: ProviderRun[] = [
			{ run_id: "a", diagnosis: diagnosis(), recommendation: recA },
			{ run_id: "b", diagnosis: diagnosis(), recommendation: recB },
		];
		const drift = diffRemediation(runs);
		expect(drift?.mode_set_agreement).toBe(false);
		expect(Object.keys(drift?.mode_sets ?? {}).length).toBeGreaterThan(1);
	});
});

// --- 4. the abstention gate ----------------------------------------------------
describe("gateCrossProviderReplay", () => {
	function cleanIdentityAttrs(suffix: string) {
		return {
			"gen_ai.provider.name": "anthropic",
			"gen_ai.request.model": `claude-${suffix}`,
			"gen_ai.agent.version": "1.0.0",
		};
	}

	test("MIN_PROVIDERS is 2: a single run always abstains for insufficient providers", () => {
		const report = gateCrossProviderReplay({
			runs: [{ run_id: "a", diagnosis: diagnosis() }],
			identities: { a: cleanIdentityAttrs("a") },
			fidelity: {},
		});
		expect(MIN_PROVIDERS).toBe(2);
		expect(report.abstain).toBe(true);
		expect(report.abstain_reasons.some((r) => r.includes("at least 2"))).toBe(true);
	});

	test("two pinned, faithful, agreeing runs do not abstain", () => {
		const report = gateCrossProviderReplay({
			runs: [
				{ run_id: "a", diagnosis: diagnosis() },
				{ run_id: "b", diagnosis: diagnosis() },
			],
			identities: { a: cleanIdentityAttrs("a"), b: cleanIdentityAttrs("b") },
			fidelity: {},
		});
		expect(report.abstain).toBe(false);
		expect(report.abstain_reasons).toEqual([]);
		expect(report.diagnosis_drift?.category_agreement).toBe(true);
	});

	test("ONE unpinned run abstains the WHOLE comparison, even with a clean majority", () => {
		const report = gateCrossProviderReplay({
			runs: [
				{ run_id: "a", diagnosis: diagnosis() },
				{ run_id: "b", diagnosis: diagnosis() },
				{ run_id: "c", diagnosis: diagnosis() },
			],
			identities: {
				a: cleanIdentityAttrs("a"),
				b: cleanIdentityAttrs("b"),
				c: {}, // unpinned: no identity attributes at all
			},
			fidelity: {},
		});
		expect(report.abstain).toBe(true);
		expect(report.abstain_reasons.some((r) => r.includes("'c' is not pinned"))).toBe(true);
	});

	test("ONE unfaithful run's evidence abstains the whole comparison", () => {
		const report = gateCrossProviderReplay({
			runs: [
				{ run_id: "a", diagnosis: diagnosis() },
				{ run_id: "b", diagnosis: diagnosis() },
			],
			identities: { a: cleanIdentityAttrs("a"), b: cleanIdentityAttrs("b") },
			fidelity: { b: { run_id: "b", trace_truncated: true } },
		});
		expect(report.abstain).toBe(true);
		expect(report.abstain_reasons.some((r) => r.includes("'b' evidence is not faithful"))).toBe(
			true,
		);
	});

	test("drift is still computed and returned even when abstaining, for audit", () => {
		const report = gateCrossProviderReplay({
			runs: [
				{ run_id: "a", diagnosis: diagnosis() },
				{
					run_id: "b",
					diagnosis: diagnosis({
						root_cause: { category: "type_error", explanation: "y", confidence: 0.6 },
					}),
				},
			],
			identities: { a: cleanIdentityAttrs("a"), b: {} },
			fidelity: {},
		});
		expect(report.abstain).toBe(true);
		expect(report.diagnosis_drift).not.toBeNull();
		expect(report.diagnosis_drift?.category_agreement).toBe(false);
	});
});

// --- rendering -----------------------------------------------------------------
describe("renderCrossProviderReplay", () => {
	test("renders an abstained report with its reasons, and a clean one without them", () => {
		const abstained = gateCrossProviderReplay({
			runs: [{ run_id: "a", diagnosis: diagnosis() }],
			identities: { a: { "gen_ai.provider.name": "anthropic" } },
			fidelity: {},
		});
		const md = renderCrossProviderReplay(abstained);
		expect(md).toContain("ABSTAINED");
		expect(md).toContain("at least 2 pinned providers");

		const clean = gateCrossProviderReplay({
			runs: [
				{ run_id: "a", diagnosis: diagnosis() },
				{ run_id: "b", diagnosis: diagnosis() },
			],
			identities: {
				a: {
					"gen_ai.provider.name": "anthropic",
					"gen_ai.request.model": "claude-a",
					"gen_ai.agent.version": "1.0.0",
				},
				b: {
					"gen_ai.provider.name": "anthropic",
					"gen_ai.request.model": "claude-b",
					"gen_ai.agent.version": "1.0.0",
				},
			},
			fidelity: {},
		});
		const cleanMd = renderCrossProviderReplay(clean);
		expect(cleanMd).not.toContain("ABSTAINED");
		expect(cleanMd).toContain("category agreement: true");
	});
});
