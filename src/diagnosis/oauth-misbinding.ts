/**
 * Diagnose OAuth issuer, CIMD, DPoP, and delegation misbinding (item 54,
 * module-header numbering: item 119, confirmed next-free via
 * `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u |
 * tail`, highest prior being item 118 from item 53's
 * `shared-state-race.ts`).
 *
 * `grep -rln "oauth\|dpop\|cimd\|issuer\|audience\|client.metadata" src
 * --include="*.ts" -i` before this module matched only
 * `security/redaction.ts`'s `GitHub OAuth Token` pattern constant (a
 * secret-scanning regex, unrelated to validating an OAuth credential's
 * own claims). No module modeled an OAuth access token's issuer/
 * audience/client-metadata/DPoP-binding/delegation-chain claims at all.
 *
 * **Never exposes token contents.** `OAuthCredentialUsage.token_ref` is
 * documented and typed as an opaque reference or fingerprint, never the
 * raw token string; every other field here is a CLAIM or piece of
 * validation metadata (issuer, audience, client id, a DPoP key's public
 * JWK thumbprint, a nonce, an actor id) that an access-control decision
 * legitimately needs to reason about openly -- none of it is the bearer
 * secret itself. No function in this module accepts, stores, or renders
 * a raw credential value; a caller that feeds one in as `token_ref`
 * anyway is violating this module's own contract, not something this
 * module can detect from inside.
 *
 * Six independently testable checks, one `OAuthCredentialUsage` at a
 * time (four of the five item categories map one-to-one; "DPoP key/nonce
 * failures" is deliberately split into `dpop_key_mismatch` and
 * `dpop_nonce_mismatch` -- mirroring `async-lifecycle-race.ts`'s (item 47)
 * own discipline of splitting a combined phrase into distinct,
 * evidence-specific finding kinds, because a key mismatch and a nonce
 * mismatch point at different fixes: a leaked/wrong private key vs. a
 * replayed or stale proof):
 *
 * 1. **Issuer/audience mismatch.** The token's `issuer` differs from
 *    what the relying party expected, OR `expected_audience` is not
 *    among the token's `audiences`. Either on its own is enough; this
 *    module does not require both to be wrong before reporting.
 * 2. **Cross-AS credential reuse.** The SAME `token_ref` presented in
 *    usage records validated against two DIFFERENT
 *    `authorization_server_id`s. One opaque credential reference should
 *    only ever be validated by the one authorization server that issued
 *    it; seeing it validated twice under two different AS ids is direct
 *    evidence of reuse across trust domains, detectable from the usage
 *    records alone with no external registry needed.
 * 3. **Stale client metadata (CIMD).** Either the elapsed time between
 *    `cimd.fetched_at_ms` and `used_at_ms` exceeds `cimd.ttl_ms` (the
 *    cached Client ID Metadata Document outlived its own declared
 *    lifetime), or `cimd_used_hash` (what was actually relied on when
 *    authorizing this specific request) differs from `cimd.metadata_hash`
 *    (what the latest fetch actually says) EVEN WITHIN the TTL window --
 *    the second case catches a request that used an in-memory snapshot
 *    that had already been superseded by a fresher fetch.
 * 4. **DPoP key mismatch.** `dpop.proof_jkt` (the JWK thumbprint of the
 *    key that signed THIS presentation's proof) differs from
 *    `dpop.bound_jkt` (the `cnf.jkt` the access token itself is bound
 *    to) -- the token is sender-constrained to one key and this proof
 *    was not signed by it.
 * 5. **DPoP nonce mismatch.** `dpop.nonce_issued` is present (the
 *    authorization server actually issued a DPoP nonce for this
 *    binding) but `dpop.proof_nonce` does not match it, including being
 *    absent entirely -- the proof did not echo the server's own
 *    anti-replay nonce.
 * 6. **Delegation binding error.** `delegation_chain`'s last entry (the
 *    actor the token's own delegation claims say should be the final
 *    delegate) does not equal `actual_caller_actor` (who actually
 *    presented the credential) -- the credential is being used by an
 *    actor other than the one its own delegation chain names.
 *
 * Pure: no fs/network/process/crypto. The caller supplies already-
 * extracted claim and validation metadata per usage attempt; this
 * module never parses, verifies signatures on, or otherwise touches a
 * raw token or proof JWT itself.
 */

export type OAuthCredentialUsage = {
	/** Opaque reference/fingerprint identifying this credential across usage records. NEVER the raw token value. */
	token_ref: string;
	/** The `iss` claim as the relying party extracted it. */
	issuer: string;
	/** The relying party's own expected issuer for this resource. */
	expected_issuer: string;
	/** The `aud` claim(s) as extracted. */
	audiences: string[];
	/** The relying party's own identifier, which must appear in `audiences`. */
	expected_audience: string;
	/** Which authorization server actually validated this usage. */
	authorization_server_id: string;
	client_id: string;
	cimd?: {
		fetched_at_ms: number;
		ttl_ms: number;
		/** Hash/fingerprint of the Client ID Metadata Document as most recently fetched, NOT its raw content. */
		metadata_hash: string;
	};
	/** Hash/fingerprint of the metadata actually relied upon when authorizing THIS usage -- may lag behind `cimd.metadata_hash` if a snapshot was cached. */
	cimd_used_hash?: string;
	dpop?: {
		/** The `cnf.jkt` thumbprint the access token is bound to. */
		bound_jkt: string;
		/** The JWK thumbprint of the key that signed this presentation's DPoP proof. */
		proof_jkt: string;
		/** The nonce the authorization server last issued for this binding, if any. */
		nonce_issued?: string;
		/** The nonce actually presented in this DPoP proof, if any. */
		proof_nonce?: string;
	};
	/** Ordered list of actor ids from originator to claimed final delegate, as encoded in the token's own delegation claims. */
	delegation_chain?: string[];
	/** The actor id that actually presented this credential. */
	actual_caller_actor?: string;
	used_at_ms?: number;
};

export const OAUTH_FINDING_KINDS = [
	"issuer_audience_mismatch",
	"cross_as_credential_reuse",
	"stale_client_metadata",
	"dpop_key_mismatch",
	"dpop_nonce_mismatch",
	"delegation_binding_error",
] as const;
export type OAuthFindingKind = (typeof OAUTH_FINDING_KINDS)[number];

export type OAuthFinding = {
	kind: OAuthFindingKind;
	token_ref: string;
	detail: string;
};

function checkIssuerAudience(usage: OAuthCredentialUsage): OAuthFinding | null {
	if (usage.issuer !== usage.expected_issuer) {
		return {
			kind: "issuer_audience_mismatch",
			token_ref: usage.token_ref,
			detail: `token '${usage.token_ref}' has issuer '${usage.issuer}', but '${usage.expected_issuer}' was expected`,
		};
	}
	if (!usage.audiences.includes(usage.expected_audience)) {
		return {
			kind: "issuer_audience_mismatch",
			token_ref: usage.token_ref,
			detail: `token '${usage.token_ref}' audiences [${usage.audiences.join(", ")}] do not include the expected audience '${usage.expected_audience}'`,
		};
	}
	return null;
}

function checkStaleClientMetadata(usage: OAuthCredentialUsage): OAuthFinding | null {
	if (!usage.cimd) return null;
	const { fetched_at_ms, ttl_ms, metadata_hash } = usage.cimd;
	if (usage.used_at_ms !== undefined && usage.used_at_ms - fetched_at_ms > ttl_ms) {
		return {
			kind: "stale_client_metadata",
			token_ref: usage.token_ref,
			detail: `client '${usage.client_id}' CIMD was fetched at ${fetched_at_ms}ms with ttl ${ttl_ms}ms, but used at ${usage.used_at_ms}ms -- the document had already expired`,
		};
	}
	if (usage.cimd_used_hash !== undefined && usage.cimd_used_hash !== metadata_hash) {
		return {
			kind: "stale_client_metadata",
			token_ref: usage.token_ref,
			detail: `client '${usage.client_id}' usage relied on a CIMD snapshot (hash '${usage.cimd_used_hash}') that differs from the latest fetched document (hash '${metadata_hash}'), even within the TTL window`,
		};
	}
	return null;
}

function checkDpop(usage: OAuthCredentialUsage): OAuthFinding[] {
	if (!usage.dpop) return [];
	const findings: OAuthFinding[] = [];
	const { bound_jkt, proof_jkt, nonce_issued, proof_nonce } = usage.dpop;
	if (proof_jkt !== bound_jkt) {
		findings.push({
			kind: "dpop_key_mismatch",
			token_ref: usage.token_ref,
			detail: `token '${usage.token_ref}' is bound to key thumbprint '${bound_jkt}', but this proof was signed by key thumbprint '${proof_jkt}'`,
		});
	}
	if (nonce_issued !== undefined && proof_nonce !== nonce_issued) {
		findings.push({
			kind: "dpop_nonce_mismatch",
			token_ref: usage.token_ref,
			detail: `the authorization server issued nonce '${nonce_issued}' for this binding, but the proof presented ${proof_nonce === undefined ? "no nonce at all" : `nonce '${proof_nonce}'`}`,
		});
	}
	return findings;
}

function checkDelegationBinding(usage: OAuthCredentialUsage): OAuthFinding | null {
	if (!usage.delegation_chain || usage.delegation_chain.length === 0) return null;
	if (usage.actual_caller_actor === undefined) return null;
	const claimedDelegate = usage.delegation_chain[usage.delegation_chain.length - 1];
	if (claimedDelegate !== usage.actual_caller_actor) {
		return {
			kind: "delegation_binding_error",
			token_ref: usage.token_ref,
			detail: `token '${usage.token_ref}'s delegation chain [${usage.delegation_chain.join(" -> ")}] names '${claimedDelegate}' as the final delegate, but the credential was actually presented by '${usage.actual_caller_actor}'`,
		};
	}
	return null;
}

function checkCrossAsReuse(usages: OAuthCredentialUsage[]): OAuthFinding[] {
	const findings: OAuthFinding[] = [];
	const byToken = new Map<string, Set<string>>();
	for (const u of usages) {
		const set = byToken.get(u.token_ref);
		if (set) set.add(u.authorization_server_id);
		else byToken.set(u.token_ref, new Set([u.authorization_server_id]));
	}
	for (const [tokenRef, asIds] of byToken) {
		if (asIds.size > 1) {
			findings.push({
				kind: "cross_as_credential_reuse",
				token_ref: tokenRef,
				detail: `token '${tokenRef}' was validated against multiple authorization servers: [${[...asIds].sort().join(", ")}]`,
			});
		}
	}
	return findings;
}

/** Diagnose every finding kind across every usage record supplied. */
export function diagnoseOAuthMisbinding(usages: OAuthCredentialUsage[]): OAuthFinding[] {
	const findings: OAuthFinding[] = [];
	for (const usage of usages) {
		const issuerAudience = checkIssuerAudience(usage);
		if (issuerAudience) findings.push(issuerAudience);
		const stale = checkStaleClientMetadata(usage);
		if (stale) findings.push(stale);
		findings.push(...checkDpop(usage));
		const delegation = checkDelegationBinding(usage);
		if (delegation) findings.push(delegation);
	}
	findings.push(...checkCrossAsReuse(usages));
	return findings;
}

/** Render a human-readable OAuth misbinding diagnosis report. */
export function renderOAuthMisbindingReport(findings: OAuthFinding[]): string {
	const lines: string[] = ["# OAuth Issuer/CIMD/DPoP/Delegation Misbinding Report", ""];
	if (findings.length === 0) {
		lines.push("No misbinding findings.");
		return lines.join("\n");
	}
	for (const f of findings) {
		lines.push(`- [${f.kind}] token '${f.token_ref}': ${f.detail}`);
	}
	return lines.join("\n");
}
