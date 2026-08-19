import { describe, expect, test } from "bun:test";
import {
	type BuildInput,
	type Consent,
	type DiagnosticBundle,
	BUNDLE_SECTIONS,
	DEFAULT_MIN_TRUST,
	TRUST_HALF_LIFE_DAYS,
	assessTrust,
	buildBundle,
	bundleFingerprint,
	canonicalize,
	consentIssues,
	importBundles,
	normalizeMessage,
	relativize,
	scrubIssues,
	signBundle,
	verifyBundle,
	workspaceHash,
} from "../../src/exchange/bundle.js";

const KEY = "shared-secret-key";
const KEY_ID = "team-alpha";
const NOW = "2026-08-19T00:00:00.000Z";

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
		created_at: NOW,
		workspace: "/Users/dev/project",
		salt: "org-salt",
		tool_version: "0.1.0",
		consent: consent(),
		failure: {
			signature_hash: "sig-abc",
			failure_type: "test_failure",
			message: "KeyError: 'email' at /Users/dev/project/src/auth.py:42 (request 1234567)",
			location: "/Users/dev/project/src/auth.py:42",
		},
		diagnosis: { category: "key_error", explanation: "payload lacks 'email'", confidence: 0.8 },
		repair: {
			summary: "use payload.get('email')",
			files: ["/Users/dev/project/src/auth.py"],
			verified: true,
		},
		...overrides,
	};
}

function built(overrides: Partial<BuildInput> = {}): DiagnosticBundle {
	const result = buildBundle(buildInput(overrides));
	if (!result.ok) throw new Error(`build refused: ${result.refused.join(", ")}`);
	return result.bundle;
}

function signed(overrides: Partial<BuildInput> = {}): DiagnosticBundle {
	return signBundle(built(overrides), KEY, KEY_ID);
}

describe("canonicalization", () => {
	test("key order does not change the encoding", () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
	});

	test("nested objects and arrays are canonicalized too", () => {
		expect(canonicalize({ x: [{ b: 1, a: 2 }] })).toBe(canonicalize({ x: [{ a: 2, b: 1 }] }));
	});

	test("undefined fields are omitted so an absent field equals a missing one", () => {
		expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
	});
});

describe("scrubbing", () => {
	test("absolute paths become repo-relative", () => {
		expect(relativize("/Users/dev/project/src/a.py", "/Users/dev/project")).toBe("src/a.py");
		expect(relativize("src/a.py", "/Users/dev/project")).toBe("src/a.py");
	});

	test("volatile literals are normalized so bundles group across workspaces", () => {
		const a = normalizeMessage("failed after 1234567 ms at 0xdeadbeef", "");
		const b = normalizeMessage("failed after 9999999 ms at 0xcafebabe", "");
		expect(a).toBe(b);
	});

	test("secrets are redacted during normalization", () => {
		expect(normalizeMessage("token sk-abcdefghijklmnopqrstuvwxyz012345", "")).toContain(
			"[REDACTED]",
		);
	});

	test("a built bundle carries no absolute paths", () => {
		const bundle = built();
		expect(bundle.failure?.location).toBe("src/auth.py:42");
		expect(bundle.repair?.files).toEqual(["src/auth.py"]);
		expect(scrubIssues(bundle)).toEqual([]);
	});

	test("the workspace is hashed, not named, and is stable", () => {
		const bundle = built();
		expect(bundle.origin.workspace_hash).not.toContain("project");
		expect(bundle.origin.workspace_hash).toBe(workspaceHash("/Users/dev/project", "org-salt"));
	});

	test("a different salt yields a different hash for the same workspace", () => {
		expect(workspaceHash("/w", "a")).not.toBe(workspaceHash("/w", "b"));
	});

	test("a smuggled secret or absolute path is caught by the re-check", () => {
		const bundle = built();
		bundle.diagnosis = {
			category: "x",
			explanation: "see /Users/dev/secrets and key sk-abcdefghijklmnopqrstuvwxyz012345",
			confidence: 0.5,
		};
		const issues = scrubIssues(bundle);
		expect(issues.some((i) => i.problem.includes("secret pattern"))).toBe(true);
		expect(issues.some((i) => i.problem.includes("absolute filesystem path"))).toBe(true);
	});
});

describe("consent", () => {
	test("building refuses rather than silently dropping an unconsented section", () => {
		const result = buildBundle(buildInput({ consent: consent({ scope: ["failure"] }) }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.refused).toContain("'diagnosis' requested but not covered by consent scope");
			expect(result.refused).toContain("'repair' requested but not covered by consent scope");
		}
	});

	test("building refuses without a grant at all", () => {
		const result = buildBundle(buildInput({ consent: consent({ granted: false }) }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.refused).toContain("consent was not granted");
	});

	test("a narrower consent produces a narrower but valid bundle", () => {
		const result = buildBundle(
			buildInput({
				consent: consent({ scope: ["failure"] }),
				diagnosis: undefined,
				repair: undefined,
			}),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bundle.failure).toBeDefined();
			expect(result.bundle.diagnosis).toBeUndefined();
		}
	});

	test("expiry is evaluated against the importer's clock, not the sender's", () => {
		const bundle = built({ consent: consent({ expires_at: "2026-08-10T00:00:00.000Z" }) });
		expect(consentIssues(bundle, "2026-08-09T00:00:00.000Z")).toEqual([]);
		expect(consentIssues(bundle, NOW).some((i) => i.problem.includes("expired"))).toBe(true);
	});

	test("a section added after building is caught at import time", () => {
		const bundle = built({
			consent: consent({ scope: ["failure"] }),
			diagnosis: undefined,
			repair: undefined,
		});
		bundle.repair = { summary: "sneaked in", files: [], verified: false };
		expect(consentIssues(bundle, NOW).some((i) => i.section === "repair")).toBe(true);
	});
});

describe("signatures", () => {
	test("a signed bundle verifies with the same key", () => {
		expect(verifyBundle(signed(), KEY)).toBe(true);
	});

	test("a different key does not verify", () => {
		expect(verifyBundle(signed(), "other-key")).toBe(false);
	});

	test("an unsigned bundle never verifies", () => {
		expect(verifyBundle(built(), KEY)).toBe(false);
	});

	test("tampering with any covered field invalidates the signature", () => {
		const bundle = signed();
		bundle.diagnosis = { category: "wrong", explanation: "changed", confidence: 0.1 };
		expect(verifyBundle(bundle, KEY)).toBe(false);
	});

	test("re-serializing with different key order still verifies", () => {
		const bundle = signed();
		const reordered = JSON.parse(
			JSON.stringify({
				signature: bundle.signature,
				repair: bundle.repair,
				diagnosis: bundle.diagnosis,
				failure: bundle.failure,
				consent: bundle.consent,
				origin: bundle.origin,
				created_at: bundle.created_at,
				bundle_id: bundle.bundle_id,
				schema_version: bundle.schema_version,
			}),
		) as DiagnosticBundle;
		expect(verifyBundle(reordered, KEY)).toBe(true);
	});
});

describe("fingerprinting", () => {
	test("the same finding under a new bundle id has the same fingerprint", () => {
		expect(bundleFingerprint(built())).toBe(bundleFingerprint(built({ bundle_id: "b2" })));
	});

	test("a different repair is a different finding", () => {
		expect(bundleFingerprint(built())).not.toBe(
			bundleFingerprint(built({ repair: { summary: "different fix" } })),
		);
	});

	test("workspace-specific noise in the message does not change the fingerprint", () => {
		const a = built();
		const b = built({
			failure: {
				signature_hash: "sig-abc",
				failure_type: "test_failure",
				message: "KeyError: 'email' at /Users/dev/project/src/auth.py:42 (request 7654321)",
				location: "/Users/dev/project/src/auth.py:42",
			},
		});
		expect(bundleFingerprint(a)).toBe(bundleFingerprint(b));
	});
});

describe("trust scoring", () => {
	test("an unsigned bundle scores zero regardless of content", () => {
		const trust = assessTrust(built(), { now: NOW, key: KEY });
		expect(trust.score).toBe(0);
		expect(trust.reasons).toContain("bundle is unsigned");
	});

	test("a bad signature is disqualifying, not a deduction", () => {
		const trust = assessTrust(signed(), { now: NOW, key: "wrong-key" });
		expect(trust.score).toBe(0);
	});

	test("lapsed consent is disqualifying even with a valid signature", () => {
		const bundle = signed({ consent: consent({ expires_at: "2026-01-01T00:00:00.000Z" }) });
		const trust = assessTrust(bundle, { now: NOW, key: KEY, known_key_ids: [KEY_ID] });
		expect(trust.score).toBe(0);
		expect(trust.reasons.some((r) => r.includes("consent"))).toBe(true);
	});

	test("a bundle failing the importer's own scrub check is disqualifying", () => {
		const bundle = built();
		bundle.repair = { summary: "edit /Users/dev/secrets", files: [], verified: false };
		const trust = assessTrust(signBundle(bundle, KEY, KEY_ID), {
			now: NOW,
			key: KEY,
			known_key_ids: [KEY_ID],
		});
		expect(trust.score).toBe(0);
		expect(trust.reasons.some((r) => r.includes("scrub"))).toBe(true);
	});

	test("a known key scores higher than an unknown one", () => {
		const known = assessTrust(signed(), { now: NOW, key: KEY, known_key_ids: [KEY_ID] });
		const unknown = assessTrust(signed(), { now: NOW, key: KEY, known_key_ids: [] });
		expect(known.score).toBeGreaterThan(unknown.score);
		expect(unknown.reasons.some((r) => r.includes("known-key list"))).toBe(true);
	});

	test("corroboration counts distinct origins, so re-sending does not inflate trust", () => {
		const bundle = signed();
		const fingerprint = bundleFingerprint(bundle);
		const sameOrigin = new Map([
			[fingerprint, new Set([bundle.origin.workspace_hash])],
		]);
		const otherOrigin = new Map([
			[fingerprint, new Set([bundle.origin.workspace_hash, "other-workspace"])],
		]);
		const alone = assessTrust(bundle, { now: NOW, key: KEY, corroboration: sameOrigin });
		const corroborated = assessTrust(bundle, {
			now: NOW,
			key: KEY,
			corroboration: otherOrigin,
		});
		expect(corroborated.score).toBeGreaterThan(alone.score);
		expect(alone.reasons).toContain("no corroboration from another origin");
	});

	test("corroboration has diminishing returns", () => {
		const bundle = signed();
		const fingerprint = bundleFingerprint(bundle);
		const withN = (n: number) =>
			assessTrust(bundle, {
				now: NOW,
				key: KEY,
				corroboration: new Map([
					[fingerprint, new Set(Array.from({ length: n }, (_, i) => `w${i}`))],
				]),
			}).score;
		const gain1 = withN(2) - withN(1);
		const gain2 = withN(3) - withN(2);
		expect(gain2).toBeLessThan(gain1);
	});

	test("age decays trust by half over the half-life", () => {
		const fresh = assessTrust(signed(), { now: NOW, key: KEY, known_key_ids: [KEY_ID] });
		const oldNow = new Date(
			Date.parse(NOW) + TRUST_HALF_LIFE_DAYS * 86_400_000,
		).toISOString();
		const aged = assessTrust(signed(), { now: oldNow, key: KEY, known_key_ids: [KEY_ID] });
		expect(aged.score).toBeCloseTo(fresh.score / 2, 5);
		expect(aged.reasons.some((r) => r.includes("age decay"))).toBe(true);
	});
});

describe("import gate", () => {
	test("a trusted bundle is accepted", () => {
		const result = importBundles([signed()], {
			now: NOW,
			key: KEY,
			known_key_ids: [KEY_ID],
			min_trust: 0.5,
		});
		expect(result.accepted).toHaveLength(1);
		expect(result.decisions[0].accepted).toBe(true);
	});

	test("an untrusted bundle is rejected with the reasons attached", () => {
		const result = importBundles([built()], { now: NOW, key: KEY });
		expect(result.accepted).toEqual([]);
		expect(result.decisions[0].reason).toContain("below the");
		expect(result.decisions[0].reason).toContain("unsigned");
	});

	test("the default threshold rejects an unsigned bundle", () => {
		expect(DEFAULT_MIN_TRUST).toBeGreaterThan(0);
		expect(importBundles([built()], { now: NOW, key: KEY }).accepted).toEqual([]);
	});

	test("a duplicate finding is not imported twice but still corroborates", () => {
		const first = signed();
		const second = signBundle(
			{ ...built({ bundle_id: "b2" }), origin: { ...first.origin, workspace_hash: "other" } },
			KEY,
			KEY_ID,
		);
		const result = importBundles([first, second], {
			now: NOW,
			key: KEY,
			known_key_ids: [KEY_ID],
			min_trust: 0.5,
		});
		expect(result.accepted).toHaveLength(1);
		expect(result.decisions[1].reason).toContain("duplicate");
		expect(result.corroboration.get(bundleFingerprint(first))?.size).toBe(2);
	});

	test("prior corroboration is carried forward, not discarded", () => {
		const bundle = signed();
		const fingerprint = bundleFingerprint(bundle);
		const result = importBundles([bundle], {
			now: NOW,
			key: KEY,
			min_trust: 0.5,
			corroboration: new Map([[fingerprint, new Set(["earlier-workspace"])]]),
		});
		expect(result.corroboration.get(fingerprint)?.size).toBe(2);
	});

	test("the caller's corroboration map is not mutated", () => {
		const bundle = signed();
		const original = new Map([[bundleFingerprint(bundle), new Set(["w0"])]]);
		importBundles([bundle], { now: NOW, key: KEY, min_trust: 0.5, corroboration: original });
		expect(original.get(bundleFingerprint(bundle))?.size).toBe(1);
	});

	test("an empty batch is a no-op", () => {
		const result = importBundles([], { now: NOW, key: KEY });
		expect(result.accepted).toEqual([]);
		expect(result.decisions).toEqual([]);
	});
});
