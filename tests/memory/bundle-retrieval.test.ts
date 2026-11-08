import { describe, expect, test } from "bun:test";
import {
	type BuildInput,
	type Consent,
	BUNDLE_SECTIONS,
	buildBundle,
	bundleFingerprint,
	signBundle,
} from "../../src/exchange/bundle.js";
import {
	type BundleUsageOutcome,
	type MemoryCandidate,
	MIN_APPLICABILITY_CONFIDENCE,
	measureRetrievalLift,
	retrievePrivacySafeMemory,
	scoreApplicability,
} from "../../src/memory/bundle-retrieval.js";

const KEY = "shared-secret-key";
const KEY_ID = "team-alpha";
const NOW_MS = Date.parse("2026-08-19T00:00:00.000Z");

function consent(overrides: Partial<Consent> = {}): Consent {
	return {
		granted: true,
		scope: [...BUNDLE_SECTIONS],
		grantor: "team-alpha",
		granted_at: "2026-08-01T00:00:00.000Z",
		...overrides,
	};
}

function buildInput(overrides: Partial<BuildInput> = {}): BuildInput {
	return {
		bundle_id: "b1",
		created_at: new Date(NOW_MS).toISOString(),
		workspace: "/Users/dev/project",
		salt: "org-salt",
		tool_version: "0.1.0",
		consent: consent(),
		failure: {
			signature_hash: "sig-abc",
			failure_type: "test_failure",
			message: "KeyError: 'email'",
		},
		diagnosis: { category: "key_error", explanation: "payload lacks 'email'", confidence: 0.8 },
		...overrides,
	};
}

function signedBundle(overrides: Partial<BuildInput> = {}) {
	const result = buildBundle(buildInput(overrides));
	if (!result.ok) throw new Error(`build refused: ${result.refused.join(", ")}`);
	return signBundle(result.bundle, KEY, KEY_ID);
}

function usage(fingerprint: string, successes: number, failures: number): Map<string, BundleUsageOutcome[]> {
	const outcomes: BundleUsageOutcome[] = [
		...Array.from({ length: successes }, () => ({ bundle_fingerprint: fingerprint, succeeded: true })),
		...Array.from({ length: failures }, () => ({ bundle_fingerprint: fingerprint, succeeded: false })),
	];
	return new Map([[fingerprint, outcomes]]);
}

describe("scoreApplicability", () => {
	test("fewer than MIN_SAMPLES_FOR_RANKING attempts is insufficient_data, not a verdict", () => {
		const result = scoreApplicability([{ bundle_fingerprint: "x", succeeded: true }]);
		expect(result.verdict).toBe("insufficient_data");
	});

	test("enough samples with a strong success rate is applicable", () => {
		const outcomes: BundleUsageOutcome[] = Array.from({ length: 20 }, () => ({
			bundle_fingerprint: "x",
			succeeded: true,
		}));
		const result = scoreApplicability(outcomes);
		expect(result.verdict).toBe("applicable");
		expect(result.wilson_lower_bound).toBeGreaterThanOrEqual(MIN_APPLICABILITY_CONFIDENCE);
	});

	test("enough samples with a weak success rate is not_applicable", () => {
		const outcomes: BundleUsageOutcome[] = [
			...Array.from({ length: 2 }, () => ({ bundle_fingerprint: "x", succeeded: true })),
			...Array.from({ length: 18 }, () => ({ bundle_fingerprint: "x", succeeded: false })),
		];
		const result = scoreApplicability(outcomes);
		expect(result.verdict).toBe("not_applicable");
	});
});

describe("measureRetrievalLift", () => {
	test("reuse success rate above the no-retrieval baseline is positive_transfer", () => {
		const outcomes: BundleUsageOutcome[] = Array.from({ length: 20 }, () => ({
			bundle_fingerprint: "x",
			succeeded: true,
		}));
		const result = measureRetrievalLift("x", outcomes, 0.3);
		expect(result.verdict).toBe("positive_transfer");
		expect(result.lift).toBeGreaterThan(0);
	});

	test("reuse success rate below the no-retrieval baseline is negative_transfer, not merely a lower rank", () => {
		const outcomes: BundleUsageOutcome[] = [
			...Array.from({ length: 2 }, () => ({ bundle_fingerprint: "x", succeeded: true })),
			...Array.from({ length: 18 }, () => ({ bundle_fingerprint: "x", succeeded: false })),
		];
		const result = measureRetrievalLift("x", outcomes, 0.9);
		expect(result.verdict).toBe("negative_transfer");
		expect(result.lift).toBeLessThan(0);
	});
});

describe("retrievePrivacySafeMemory", () => {
	test("a query with no tenant and no cross-tenant authorization is refused, preventing tenant leakage", () => {
		const bundle = signedBundle();
		const candidates: MemoryCandidate[] = [{ bundle, tenant: "acme" }];
		const result = retrievePrivacySafeMemory(candidates, {}, { now_ms: NOW_MS, trust: { now: new Date(NOW_MS).toISOString(), key: KEY, known_key_ids: [KEY_ID] } });
		expect(result.ok).toBe(false);
	});

	test("a bundle past the governed exchange_bundle TTL is refused for transfer as stale, not merely discounted", () => {
		const createdAt = NOW_MS - 30 * 86_400_000; // 30 days old
		const bundle = signedBundle({ created_at: new Date(createdAt).toISOString() });
		const candidates: MemoryCandidate[] = [{ bundle, tenant: "acme" }];
		const result = retrievePrivacySafeMemory(candidates, { tenant: "acme" }, {
			now_ms: NOW_MS,
			trust: { now: new Date(NOW_MS).toISOString(), key: KEY, known_key_ids: [KEY_ID] },
			stale_after_ms: 14 * 86_400_000, // the real DEFAULT_RETENTION.exchange_bundle value
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.retrieved).toHaveLength(0);
		expect(result.rejected[0]?.reason).toBe("stale_transfer");
	});

	test("a fresh, trusted, well-evidenced bundle is retrieved and scoped to its tenant", () => {
		const bundle = signedBundle();
		const fp = bundleFingerprint(bundle);
		const candidates: MemoryCandidate[] = [{ bundle, tenant: "acme" }];
		const result = retrievePrivacySafeMemory(candidates, { tenant: "acme" }, {
			now_ms: NOW_MS,
			trust: { now: new Date(NOW_MS).toISOString(), key: KEY, known_key_ids: [KEY_ID] },
			usage: usage(fp, 18, 2),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.scope).toBe("tenant 'acme'");
		expect(result.retrieved).toHaveLength(1);
		expect(result.retrieved[0]?.applicability.verdict).toBe("applicable");
	});

	test("a bundle that measurably performs worse than the no-retrieval baseline is rejected as negative_transfer", () => {
		const bundle = signedBundle();
		const fp = bundleFingerprint(bundle);
		const candidates: MemoryCandidate[] = [{ bundle, tenant: "acme" }];
		const result = retrievePrivacySafeMemory(candidates, { tenant: "acme" }, {
			now_ms: NOW_MS,
			trust: { now: new Date(NOW_MS).toISOString(), key: KEY, known_key_ids: [KEY_ID] },
			usage: usage(fp, 16, 4),
			baseline_success_rate: 0.95,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.retrieved).toHaveLength(0);
		expect(result.rejected[0]?.reason).toBe("negative_transfer");
	});
});
