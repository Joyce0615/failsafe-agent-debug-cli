import { describe, expect, test } from "bun:test";
import {
	DEFAULT_EVIDENCE_BUDGET_POLICY,
	DEFAULT_PRIVACY_WEIGHT,
	EvidenceBudgetLedger,
	type EvidenceCollectionOption,
	collectionCost,
	decideEvidenceEscalation,
	rankEvidenceOptions,
} from "../../src/capture/evidence-budget.js";

/** A decisive probe: perfectly separates two hypotheses, 1 bit. */
const DECISIVE_PRIORS = [0.5, 0.5];
const DECISIVE_LIKELIHOODS = [
	[1, 0],
	[0, 1],
];

/** A useless probe: identical outcome distribution under every hypothesis. */
const USELESS_LIKELIHOODS = [
	[0.5, 0.5],
	[0.5, 0.5],
];

function option(overrides: Partial<EvidenceCollectionOption> = {}): EvidenceCollectionOption {
	return {
		id: "peak-memory-sample",
		description: "collect the peak memory sample",
		tier: "summary",
		privacy_classes: [],
		storage_bytes: 1024,
		runtime_ms: 50,
		...overrides,
	};
}

describe("collectionCost", () => {
	test("privacy classes dominate storage/runtime for a tiny payload", () => {
		const noPrivacy = collectionCost(option({ privacy_classes: [] }));
		const withSecret = collectionCost(option({ privacy_classes: ["secret"] }));
		expect(withSecret).toBeGreaterThan(noPrivacy);
		expect(withSecret - noPrivacy).toBe(DEFAULT_PRIVACY_WEIGHT.secret);
	});

	test("a secret-bearing option costs more than a tool-payload-only one at equal size", () => {
		const secretCost = collectionCost(option({ privacy_classes: ["secret"] }));
		const toolCost = collectionCost(option({ privacy_classes: ["tool_payload"] }));
		expect(secretCost).toBeGreaterThan(toolCost);
	});

	test("cost is zero for a free, private-nothing option", () => {
		expect(collectionCost(option({ privacy_classes: [], storage_bytes: 0, runtime_ms: 0 }))).toBe(0);
	});

	test("multiple privacy classes on one option sum, not max: the resource portion is unaffected", () => {
		const resourceOnly = collectionCost(option({ privacy_classes: [] }));
		const single = collectionCost(option({ privacy_classes: ["pii"] }));
		const double = collectionCost(option({ privacy_classes: ["pii", "pii"] }));
		expect(single - resourceOnly).toBeCloseTo(DEFAULT_PRIVACY_WEIGHT.pii, 6);
		expect(double - resourceOnly).toBeCloseTo(DEFAULT_PRIVACY_WEIGHT.pii * 2, 6);
	});
});

describe("decideEvidenceEscalation: the gate, not a term in the objective", () => {
	test("a decisive, free, in-tier probe is authorized", () => {
		const decision = decideEvidenceEscalation({
			option: option({ storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
			priors: DECISIVE_PRIORS,
			likelihoods: DECISIVE_LIKELIHOODS,
			spent: { storage_bytes: 0, runtime_ms: 0 },
		});
		expect(decision.escalate).toBe(true);
		expect(decision.expected_information_gain).toBeCloseTo(1, 6);
	});

	test("a useless probe never clears the threshold, however cheap", () => {
		const decision = decideEvidenceEscalation({
			option: option({ storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
			priors: DECISIVE_PRIORS,
			likelihoods: USELESS_LIKELIHOODS,
			spent: { storage_bytes: 0, runtime_ms: 0 },
		});
		expect(decision.escalate).toBe(false);
		expect(decision.expected_information_gain).toBeCloseTo(0, 6);
		expect(decision.reason).toContain("does not justify");
	});

	test("a decisive probe above the authorized tier is refused regardless of its gain", () => {
		const decision = decideEvidenceEscalation({
			option: option({ tier: "destructive", storage_bytes: 0, runtime_ms: 0 }),
			priors: DECISIVE_PRIORS,
			likelihoods: DECISIVE_LIKELIHOODS,
			spent: { storage_bytes: 0, runtime_ms: 0 },
			policy: { ...DEFAULT_EVIDENCE_BUDGET_POLICY, max_tier: "detailed" },
		});
		expect(decision.escalate).toBe(false);
		expect(decision.reason).toContain("exceeds the authorized");
	});

	test("tier gate fires even when bits-per-cost would otherwise clear the threshold", () => {
		// Same decisive, free probe as the first test — would authorize at
		// 'summary', but is parked at 'destructive' here. The gate must win.
		const decision = decideEvidenceEscalation({
			option: option({ tier: "destructive", storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
			priors: DECISIVE_PRIORS,
			likelihoods: DECISIVE_LIKELIHOODS,
			spent: { storage_bytes: 0, runtime_ms: 0 },
		});
		expect(decision.escalate).toBe(false);
	});

	test("exceeding the storage ceiling refuses even a decisive probe", () => {
		const decision = decideEvidenceEscalation({
			option: option({ storage_bytes: 10, runtime_ms: 0 }),
			priors: DECISIVE_PRIORS,
			likelihoods: DECISIVE_LIKELIHOODS,
			spent: { storage_bytes: DEFAULT_EVIDENCE_BUDGET_POLICY.max_storage_bytes - 5, runtime_ms: 0 },
		});
		expect(decision.escalate).toBe(false);
		expect(decision.reason).toContain("storage");
	});

	test("exceeding the runtime ceiling refuses even a decisive probe", () => {
		const decision = decideEvidenceEscalation({
			option: option({ storage_bytes: 0, runtime_ms: 10 }),
			priors: DECISIVE_PRIORS,
			likelihoods: DECISIVE_LIKELIHOODS,
			spent: { storage_bytes: 0, runtime_ms: DEFAULT_EVIDENCE_BUDGET_POLICY.max_runtime_ms - 5 },
		});
		expect(decision.escalate).toBe(false);
		expect(decision.reason).toContain("runtime");
	});

	test("a privacy-heavy probe is refused when its gain cannot cover the privacy cost", () => {
		const decision = decideEvidenceEscalation({
			option: option({ privacy_classes: ["secret"], storage_bytes: 0, runtime_ms: 0 }),
			priors: DECISIVE_PRIORS,
			// Mildly informative, but nowhere near enough to pay for a secret.
			likelihoods: [
				[0.55, 0.45],
				[0.45, 0.55],
			],
		});
		expect(decision.escalate).toBe(false);
		expect(decision.reason).toContain("does not justify");
	});

	test("zero expected gain and zero cost never divides by zero into a spurious authorization", () => {
		const decision = decideEvidenceEscalation({
			option: option({ storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
			priors: DECISIVE_PRIORS,
			likelihoods: USELESS_LIKELIHOODS,
			spent: { storage_bytes: 0, runtime_ms: 0 },
		});
		expect(Number.isFinite(decision.bits_per_cost)).toBe(true);
		expect(decision.escalate).toBe(false);
	});

	test("a free, decisive probe reports Infinity bits-per-cost without being mistaken for a refusal", () => {
		const decision = decideEvidenceEscalation({
			option: option({ storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
			priors: DECISIVE_PRIORS,
			likelihoods: DECISIVE_LIKELIHOODS,
			spent: { storage_bytes: 0, runtime_ms: 0 },
		});
		expect(decision.bits_per_cost).toBe(Number.POSITIVE_INFINITY);
		expect(decision.escalate).toBe(true);
	});
});

describe("rankEvidenceOptions", () => {
	test("options that fail the gate are never ranked above one that passes it", () => {
		const options = [
			option({ id: "expensive-useless", privacy_classes: ["secret", "pii"], storage_bytes: 10 }),
			option({ id: "cheap-decisive", privacy_classes: [], storage_bytes: 0, runtime_ms: 0 }),
		];
		const ranked = rankEvidenceOptions(options, DECISIVE_PRIORS, [DECISIVE_LIKELIHOODS[0], USELESS_LIKELIHOODS[1]], {
			storage_bytes: 0,
			runtime_ms: 0,
		});
		// cheap-decisive is informative for this option's own likelihood row set;
		// what matters here is that a refused option never sorts ahead of an
		// authorized one.
		const firstAuthorizedIndex = ranked.findIndex((r) => r.escalate);
		const firstRefusedIndex = ranked.findIndex((r) => !r.escalate);
		if (firstAuthorizedIndex !== -1 && firstRefusedIndex !== -1) {
			expect(firstAuthorizedIndex).toBeLessThan(firstRefusedIndex);
		}
	});

	test("a destructive-tier option never outranks an authorized summary-tier option, however good its ratio", () => {
		const options = [
			option({ id: "destructive-great-ratio", tier: "destructive", storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
			option({ id: "summary-ok", tier: "summary", storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
		];
		const ranked = rankEvidenceOptions(options, DECISIVE_PRIORS, DECISIVE_LIKELIHOODS, {
			storage_bytes: 0,
			runtime_ms: 0,
		});
		const destructive = ranked.find((r) => r.option_id === "destructive-great-ratio")!;
		const summary = ranked.find((r) => r.option_id === "summary-ok")!;
		expect(destructive.escalate).toBe(false);
		expect(summary.escalate).toBe(true);
		expect(ranked.indexOf(summary)).toBeLessThan(ranked.indexOf(destructive));
	});
});

describe("EvidenceBudgetLedger", () => {
	test("an authorized collection is charged against the running total", () => {
		const ledger = new EvidenceBudgetLedger();
		const decision = ledger.consider(
			option({ storage_bytes: 1000, runtime_ms: 10, privacy_classes: [] }),
			DECISIVE_PRIORS,
			DECISIVE_LIKELIHOODS,
		);
		expect(decision.escalate).toBe(true);
		expect(ledger.spent).toEqual({ storage_bytes: 1000, runtime_ms: 10 });
	});

	test("a refused collection is never charged", () => {
		const ledger = new EvidenceBudgetLedger();
		const decision = ledger.consider(
			option({ tier: "destructive", storage_bytes: 1000, runtime_ms: 10 }),
			DECISIVE_PRIORS,
			DECISIVE_LIKELIHOODS,
		);
		expect(decision.escalate).toBe(false);
		expect(ledger.spent).toEqual({ storage_bytes: 0, runtime_ms: 0 });
	});

	test("the ceiling is a real bound across a sequence of calls, not just a single one", () => {
		const policy = {
			...DEFAULT_EVIDENCE_BUDGET_POLICY,
			max_storage_bytes: 1500,
		};
		const ledger = new EvidenceBudgetLedger(policy);
		const first = ledger.consider(
			option({ id: "a", storage_bytes: 1000, runtime_ms: 0, privacy_classes: [] }),
			DECISIVE_PRIORS,
			DECISIVE_LIKELIHOODS,
		);
		const second = ledger.consider(
			option({ id: "b", storage_bytes: 1000, runtime_ms: 0, privacy_classes: [] }),
			DECISIVE_PRIORS,
			DECISIVE_LIKELIHOODS,
		);
		expect(first.escalate).toBe(true);
		expect(second.escalate).toBe(false);
		expect(second.reason).toContain("storage");
		expect(ledger.spent.storage_bytes).toBe(1000);
	});

	test("report lists every decision considered, in order, authorized and refused alike", () => {
		const ledger = new EvidenceBudgetLedger();
		ledger.consider(
			option({ id: "ok", storage_bytes: 0, runtime_ms: 0, privacy_classes: [] }),
			DECISIVE_PRIORS,
			DECISIVE_LIKELIHOODS,
		);
		ledger.consider(
			option({ id: "blocked", tier: "destructive" }),
			DECISIVE_PRIORS,
			DECISIVE_LIKELIHOODS,
		);
		const report = ledger.report();
		expect(report.decisions.map((d) => d.option_id)).toEqual(["ok", "blocked"]);
		expect(report.authorized_count).toBe(1);
		expect(report.refused_count).toBe(1);
		expect(report.spent).toEqual({ storage_bytes: 0, runtime_ms: 0 });
	});
});
