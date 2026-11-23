/**
 * OAuth issuer/CIMD/DPoP/delegation misbinding diagnosis tests (item 54
 * — detect issuer/audience mismatch, cross-AS credential reuse, stale
 * client metadata assumptions, DPoP key/nonce failures, and delegation
 * binding errors without exposing token contents).
 */
import { describe, expect, test } from "bun:test";
import {
	type OAuthCredentialUsage,
	diagnoseOAuthMisbinding,
	renderOAuthMisbindingReport,
} from "../../src/diagnosis/oauth-misbinding.js";

function baseUsage(overrides: Partial<OAuthCredentialUsage> = {}): OAuthCredentialUsage {
	return {
		token_ref: "tok-1",
		issuer: "https://as.example.com",
		expected_issuer: "https://as.example.com",
		audiences: ["https://api.example.com"],
		expected_audience: "https://api.example.com",
		authorization_server_id: "as-1",
		client_id: "client-1",
		...overrides,
	};
}

describe("diagnoseOAuthMisbinding: issuer/audience mismatch", () => {
	test("a mismatched issuer is flagged", () => {
		const usage = baseUsage({ issuer: "https://evil.example.com" });
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "issuer_audience_mismatch")).toBe(true);
	});

	test("an audience missing the expected value is flagged", () => {
		const usage = baseUsage({ audiences: ["https://other.example.com"] });
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "issuer_audience_mismatch")).toBe(true);
	});

	test("a matching issuer and audience is not flagged", () => {
		const usage = baseUsage();
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.find((f) => f.kind === "issuer_audience_mismatch")).toBeUndefined();
	});
});

describe("diagnoseOAuthMisbinding: cross-AS credential reuse", () => {
	test("the same token_ref validated against two different authorization servers is flagged", () => {
		const usages = [
			baseUsage({ token_ref: "tok-shared", authorization_server_id: "as-1" }),
			baseUsage({ token_ref: "tok-shared", authorization_server_id: "as-2" }),
		];
		const findings = diagnoseOAuthMisbinding(usages);
		expect(findings.some((f) => f.kind === "cross_as_credential_reuse")).toBe(true);
	});

	test("the same token_ref validated repeatedly against the SAME authorization server is not flagged", () => {
		const usages = [
			baseUsage({ token_ref: "tok-shared", authorization_server_id: "as-1" }),
			baseUsage({ token_ref: "tok-shared", authorization_server_id: "as-1" }),
		];
		const findings = diagnoseOAuthMisbinding(usages);
		expect(findings.find((f) => f.kind === "cross_as_credential_reuse")).toBeUndefined();
	});
});

describe("diagnoseOAuthMisbinding: stale client metadata (CIMD)", () => {
	test("a CIMD used past its TTL is flagged", () => {
		const usage = baseUsage({
			cimd: { fetched_at_ms: 0, ttl_ms: 1000, metadata_hash: "h1" },
			used_at_ms: 5000,
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "stale_client_metadata")).toBe(true);
	});

	test("a CIMD used within TTL but relying on a superseded snapshot hash is flagged", () => {
		const usage = baseUsage({
			cimd: { fetched_at_ms: 0, ttl_ms: 10000, metadata_hash: "h-latest" },
			cimd_used_hash: "h-stale",
			used_at_ms: 500,
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "stale_client_metadata")).toBe(true);
	});

	test("a CIMD used within TTL with a matching hash is not flagged", () => {
		const usage = baseUsage({
			cimd: { fetched_at_ms: 0, ttl_ms: 10000, metadata_hash: "h1" },
			cimd_used_hash: "h1",
			used_at_ms: 500,
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.find((f) => f.kind === "stale_client_metadata")).toBeUndefined();
	});
});

describe("diagnoseOAuthMisbinding: DPoP key/nonce failures", () => {
	test("a proof signed by a different key than the token is bound to is dpop_key_mismatch", () => {
		const usage = baseUsage({
			dpop: { bound_jkt: "jkt-a", proof_jkt: "jkt-b" },
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "dpop_key_mismatch")).toBe(true);
	});

	test("a proof signed by the bound key is not dpop_key_mismatch", () => {
		const usage = baseUsage({
			dpop: { bound_jkt: "jkt-a", proof_jkt: "jkt-a" },
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.find((f) => f.kind === "dpop_key_mismatch")).toBeUndefined();
	});

	test("a proof that does not echo the issued nonce is dpop_nonce_mismatch", () => {
		const usage = baseUsage({
			dpop: { bound_jkt: "jkt-a", proof_jkt: "jkt-a", nonce_issued: "n1", proof_nonce: "n2" },
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "dpop_nonce_mismatch")).toBe(true);
	});

	test("a proof missing the nonce entirely when one was issued is dpop_nonce_mismatch", () => {
		const usage = baseUsage({
			dpop: { bound_jkt: "jkt-a", proof_jkt: "jkt-a", nonce_issued: "n1" },
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "dpop_nonce_mismatch")).toBe(true);
	});

	test("a proof echoing the issued nonce correctly is not dpop_nonce_mismatch", () => {
		const usage = baseUsage({
			dpop: { bound_jkt: "jkt-a", proof_jkt: "jkt-a", nonce_issued: "n1", proof_nonce: "n1" },
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.find((f) => f.kind === "dpop_nonce_mismatch")).toBeUndefined();
	});

	test("no nonce issued at all means no nonce mismatch finding, regardless of proof_nonce", () => {
		const usage = baseUsage({
			dpop: { bound_jkt: "jkt-a", proof_jkt: "jkt-a" },
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.find((f) => f.kind === "dpop_nonce_mismatch")).toBeUndefined();
	});
});

describe("diagnoseOAuthMisbinding: delegation binding error", () => {
	test("a credential presented by an actor other than the chain's final delegate is flagged", () => {
		const usage = baseUsage({
			delegation_chain: ["user-1", "agent-a"],
			actual_caller_actor: "agent-b",
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.some((f) => f.kind === "delegation_binding_error")).toBe(true);
	});

	test("a credential presented by the chain's final delegate is not flagged", () => {
		const usage = baseUsage({
			delegation_chain: ["user-1", "agent-a"],
			actual_caller_actor: "agent-a",
		});
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.find((f) => f.kind === "delegation_binding_error")).toBeUndefined();
	});

	test("no delegation chain supplied means no delegation finding", () => {
		const usage = baseUsage({ actual_caller_actor: "agent-b" });
		const findings = diagnoseOAuthMisbinding([usage]);
		expect(findings.find((f) => f.kind === "delegation_binding_error")).toBeUndefined();
	});
});

describe("diagnoseOAuthMisbinding: never exposes token contents", () => {
	test("rendered findings reference only token_ref, never a raw token value", () => {
		const usage = baseUsage({ issuer: "https://evil.example.com" });
		const findings = diagnoseOAuthMisbinding([usage]);
		const text = renderOAuthMisbindingReport(findings);
		expect(text).toContain("tok-1");
		expect(text).not.toContain("Bearer ");
	});
});

describe("renderOAuthMisbindingReport", () => {
	test("renders a clean usage with no findings", () => {
		const findings = diagnoseOAuthMisbinding([baseUsage()]);
		const text = renderOAuthMisbindingReport(findings);
		expect(text).toContain("No misbinding findings.");
	});
});
