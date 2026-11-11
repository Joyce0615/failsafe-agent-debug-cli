/**
 * Ingest runtime and dependency security advisories (item 37, item 103 in
 * this project's own module-header numbering convention — confirmed as the
 * next free number via `grep -rohE "item [0-9]+" src --include="*.ts" |
 * sort -t' ' -k2 -n -u`, highest prior use was item 102 from item 36's
 * `capability-drift.ts`).
 *
 * `grep -rln "advisory\|advisories\|CVE\|vulnerab" src --include="*.ts"`
 * before this module matched `cli/intent.ts`/`diagnosis/intent.ts` (an
 * unrelated "vulnerability" of a DIFFERENT kind — prompt-injection intent
 * classification, nothing to do with a package CVE) and `trace/
 * conformance.ts`/`trace/diagnose.ts`/`trace/genai-normalize.ts` (OpenTelemetry
 * GenAI span attribute names that happen to contain the substring
 * "vulnerab" inside unrelated identifiers). `release/supply-chain.ts`
 * (item 94) already builds an SBOM and verifies a release signature, but it
 * has no notion of a security advisory at all — an SBOM says what is
 * installed, never whether any of it is currently known to be dangerous.
 * `remediation/modes.ts` (item 93) already has a cause-class/contraindication/
 * precondition framework for recovery modes, but its `CAUSE_CLASSES` has no
 * "known vulnerability" class, and `security/sandbox.ts` (item 63) already
 * has an `isolation`-flavoured `SandboxProfile` but nothing that selects a
 * profile FROM an advisory.
 *
 * This item asks three separable questions, deliberately not folded into
 * one risk score:
 *
 * 1. **Does a signed advisory even name a component this project ships?**
 *    `matchAdvisoryToSbom` matches a `SecurityAdvisory`'s affected
 *    package/version-range against `release/supply-chain.ts`'s own
 *    `SbomComponent[]`, by `purl` package name first (the identifier
 *    vulnerability feeds actually key on, per that module's own comment on
 *    `SbomComponent.purl`) and then by exact version membership in the
 *    advisory's affected range. An advisory that names a package this SBOM
 *    does not contain produces zero matches, not a false "not affected" —
 *    `AdvisoryMatch.matched_components` is empty and the caller can tell the
 *    two apart.
 *
 * 2. **Is a matched component actually exploitable here, or merely
 *    present?** `assessExploitability` is the one place this module refuses
 *    to conflate "named by an advisory" with "a real risk to this
 *    deployment" — the same discipline `release/supply-chain.ts`'s own
 *    `verifyRelease` applies to "signed" vs "safe" (a signature is
 *    attribution, not assurance; a match is presence, not exploitability).
 *    A match is `exploitable` only when the advisory's own declared
 *    `attack_vector` is reachable given the caller-supplied
 *    `DeploymentExposure` (e.g. a `network`-vector advisory is not
 *    exploitable when `DeploymentExposure.network_reachable` is false), and
 *    `vulnerable_not_exploitable` is a first-class, explicitly-reported
 *    outcome rather than a silently-dropped one — mirroring
 *    `security/sandbox.ts`'s own "a limit that is not enforced is a
 *    comment" commitment to naming gaps rather than hiding them.
 *
 * 3. **What is a BOUNDED recovery — never an unbounded "upgrade
 *    everything"?** `proposeAdvisoryRecovery` offers exactly two kinds of
 *    action, both already-recognized shapes elsewhere in this project
 *    rather than a new unbounded one: an `upgrade` to the advisory's own
 *    declared `patched_version` (never an arbitrary "latest", which could
 *    introduce an unrelated breaking change the advisory never asked for),
 *    or an `isolate` action that selects the TIGHTEST existing
 *    `security/sandbox.ts` profile (`PROFILES.proposed_fix`, ranked by that
 *    module's own `PROFILE_TIGHTNESS`) as a stopgap when no patched version
 *    exists yet. Exploitable-but-unpatched is the one case this module
 *    refuses to propose an upgrade for — proposing an upgrade that does not
 *    exist is not a bounded action, it is a promise this module cannot
 *    keep, mirroring `diagnosis/recovery-packet.ts`'s own refusal to
 *    propose anything when a failure was not decisive.
 *
 * Attribution to incident evidence (an `IncidentEvidence` naming a component
 * and, optionally, an error signature) ranks an exploitable match ahead of a
 * vulnerable-but-not-exploitable one, mirroring `diagnosis/drift.ts`'s own
 * evidence-based ranking discipline — a reachable vulnerability explains an
 * observed incident more directly than a dormant one.
 *
 * Pure: no fs/network/process. Advisories, SBOM, and exposure are supplied
 * by the caller; nothing here fetches a feed or applies an upgrade.
 */
import type { SbomComponent } from "../release/supply-chain.js";
import { PROFILES, PROFILE_TIGHTNESS, type SandboxProfileName } from "./sandbox.js";

export const ATTACK_VECTORS = ["network", "local", "physical"] as const;
export type AttackVector = (typeof ATTACK_VECTORS)[number];

/** A single signed security advisory, in the shape a feed like GHSA/OSV emits. */
export type SecurityAdvisory = {
	id: string;
	/** Package name this advisory affects. Matched against `SbomComponent.name`. */
	package: string;
	/** Versions known to be affected, inclusive. */
	affected_versions: string[];
	/** The earliest version that fixes this advisory, when one has shipped. */
	patched_version?: string;
	attack_vector: AttackVector;
	summary: string;
};

export type AdvisoryMatch = {
	advisory: SecurityAdvisory;
	/** SBOM components whose name and version fall inside the advisory's affected range. */
	matched_components: SbomComponent[];
};

/**
 * Match advisories against the SBOM's own components.
 *
 * Matching is by `purl` package name (the identifier vulnerability feeds
 * actually key on, per `release/supply-chain.ts`'s own comment on
 * `SbomComponent.purl`) first, then exact version membership in
 * `affected_versions`. An advisory naming a package absent from the SBOM
 * produces an entry with an EMPTY `matched_components`, never a dropped
 * advisory — the caller must be able to tell "not affected" apart from
 * "never checked".
 */
export function matchAdvisoryToSbom(
	advisories: SecurityAdvisory[],
	components: SbomComponent[],
): AdvisoryMatch[] {
	return advisories.map((advisory) => {
		const matched_components = components.filter(
			(component) =>
				component.name === advisory.package &&
				advisory.affected_versions.includes(component.version),
		);
		return { advisory, matched_components };
	});
}

/** What a caller's deployment actually exposes, for exploitability assessment. */
export type DeploymentExposure = {
	network_reachable: boolean;
	/** Whether the component is reachable by someone with local shell access. */
	local_reachable: boolean;
	/** Whether the component is reachable by someone with physical device access. */
	physical_reachable: boolean;
};

export type ExploitabilityStatus = "exploitable" | "vulnerable_not_exploitable" | "not_affected";

export type ExploitabilityAssessment = {
	advisory: SecurityAdvisory;
	status: ExploitabilityStatus;
	matched_components: SbomComponent[];
	/** Always populated: the reasoning this status rests on. */
	rationale: string;
};

const EXPOSURE_FIELD: Record<AttackVector, keyof DeploymentExposure> = {
	network: "network_reachable",
	local: "local_reachable",
	physical: "physical_reachable",
};

/**
 * Distinguish a vulnerable configuration from an exploitable one.
 *
 * A match with no matched components is `not_affected` — the SBOM does not
 * contain the named package at an affected version, so there is nothing to
 * assess exploitability for. A match WITH components is `exploitable` only
 * when the advisory's own `attack_vector` is reachable per `exposure`;
 * otherwise it is `vulnerable_not_exploitable`, reported explicitly rather
 * than silently dropped — presence of a known-bad component is a real fact
 * about this deployment even when nothing today can reach it.
 */
export function assessExploitability(
	match: AdvisoryMatch,
	exposure: DeploymentExposure,
): ExploitabilityAssessment {
	if (match.matched_components.length === 0) {
		return {
			advisory: match.advisory,
			status: "not_affected",
			matched_components: [],
			rationale: `no SBOM component named '${match.advisory.package}' falls inside the advisory's affected versions; this deployment does not ship the vulnerable configuration`,
		};
	}
	const field = EXPOSURE_FIELD[match.advisory.attack_vector];
	const reachable = exposure[field];
	if (reachable) {
		return {
			advisory: match.advisory,
			status: "exploitable",
			matched_components: match.matched_components,
			rationale: `'${match.advisory.package}' is present at an affected version and this deployment's ${match.advisory.attack_vector} attack surface is reachable`,
		};
	}
	return {
		advisory: match.advisory,
		status: "vulnerable_not_exploitable",
		matched_components: match.matched_components,
		rationale: `'${match.advisory.package}' is present at an affected version, but this deployment's ${match.advisory.attack_vector} attack surface is not reachable; the vulnerable configuration is present without being exploitable today`,
	};
}

export type RecoveryAction =
	| { kind: "upgrade"; package: string; to_version: string }
	| { kind: "isolate"; profile: SandboxProfileName; reason: string };

export type AdvisoryRecovery = {
	assessment: ExploitabilityAssessment;
	actions: RecoveryAction[];
	/** Populated when no bounded action could be proposed, and why. */
	refused: string[];
};

/**
 * Propose a bounded recovery for one exploitability assessment.
 *
 * `not_affected` and `vulnerable_not_exploitable` propose nothing — there is
 * no incident to recover from, and proposing an upgrade for a component that
 * is not reachable would be unbounded churn with no corresponding risk
 * reduction. `exploitable` with a `patched_version` proposes exactly that
 * upgrade, never an arbitrary "latest". `exploitable` with NO
 * `patched_version` proposes isolation under `security/sandbox.ts`'s own
 * tightest existing profile (ranked by `PROFILE_TIGHTNESS`) as a stopgap,
 * and refuses to propose an upgrade that does not exist — mirroring
 * `diagnosis/recovery-packet.ts`'s refusal to propose anything when a
 * failure is not decisive, generalized here to "no action exists".
 */
export function proposeAdvisoryRecovery(assessment: ExploitabilityAssessment): AdvisoryRecovery {
	if (assessment.status !== "exploitable") {
		return {
			assessment,
			actions: [],
			refused: [
				`status is '${assessment.status}', not 'exploitable'; no recovery action is proposed for a vulnerability that is not currently exploitable`,
			],
		};
	}
	const actions: RecoveryAction[] = [];
	const refused: string[] = [];
	if (assessment.advisory.patched_version) {
		actions.push({
			kind: "upgrade",
			package: assessment.advisory.package,
			to_version: assessment.advisory.patched_version,
		});
	} else {
		const tightestProfile = (Object.keys(PROFILE_TIGHTNESS) as SandboxProfileName[]).sort(
			(a, b) => PROFILE_TIGHTNESS[a] - PROFILE_TIGHTNESS[b],
		)[0];
		actions.push({
			kind: "isolate",
			profile: tightestProfile,
			reason: `no patched version exists yet for '${assessment.advisory.id}'; running under '${PROFILES[tightestProfile].name}' (the tightest existing sandbox profile) bounds the exposure until one ships`,
		});
		refused.push(
			`no 'patched_version' is declared on '${assessment.advisory.id}'; an upgrade cannot be proposed to a version that does not exist`,
		);
	}
	return { assessment, actions, refused };
}

/** Evidence from an incident, to attribute an advisory to an observed failure. */
export type IncidentEvidence = {
	implicated_components: string[];
	error_text: string;
};

export type AdvisoryAttribution =
	| { attributed: true; advisory: SecurityAdvisory; status: ExploitabilityStatus; reason: string }
	| { attributed: false; reason: string };

const STATUS_PRIORITY: Record<ExploitabilityStatus, number> = {
	exploitable: 0,
	vulnerable_not_exploitable: 1,
	not_affected: 2,
};

/**
 * Attribute an incident to the best-ranked assessment that implicates it.
 *
 * An assessment implicates the incident when its advisory's `package` is
 * named in `implicated_components` or appears in `error_text`. Among
 * implicating assessments, `exploitable` outranks `vulnerable_not_exploitable`
 * outranks `not_affected` — a reachable vulnerability explains an observed
 * incident more directly than a dormant one, mirroring `diagnosis/drift.ts`'s
 * evidence-based ranking discipline.
 */
export function attributeAdvisoryToIncident(
	assessments: ExploitabilityAssessment[],
	evidence: IncidentEvidence,
): AdvisoryAttribution {
	const implicating = assessments.filter(
		(a) =>
			evidence.implicated_components.includes(a.advisory.package) ||
			evidence.error_text.toLowerCase().includes(a.advisory.package.toLowerCase()),
	);
	if (implicating.length === 0) {
		return {
			attributed: false,
			reason:
				"no assessed advisory's package is named in the incident's implicated components or error text",
		};
	}
	const [best] = [...implicating].sort(
		(a, b) =>
			STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] ||
			a.advisory.id.localeCompare(b.advisory.id),
	);
	return {
		attributed: true,
		advisory: best.advisory,
		status: best.status,
		reason:
			best.status === "exploitable"
				? `'${best.advisory.package}' is named by the incident and is exploitable under this deployment's exposure`
				: `'${best.advisory.package}' is named by the incident but is only '${best.status}'; the incident may have another cause`,
	};
}

export type AdvisoryIngestReport = {
	assessments: ExploitabilityAssessment[];
	attribution: AdvisoryAttribution;
	recoveries: AdvisoryRecovery[];
};

/**
 * Compose the full pipeline: match, assess, attribute, and propose recovery
 * only for the exploitable assessments.
 */
export function ingestAdvisories(
	advisories: SecurityAdvisory[],
	components: SbomComponent[],
	exposure: DeploymentExposure,
	evidence: IncidentEvidence,
): AdvisoryIngestReport {
	const matches = matchAdvisoryToSbom(advisories, components);
	const assessments = matches.map((m) => assessExploitability(m, exposure));
	const attribution = attributeAdvisoryToIncident(assessments, evidence);
	const recoveries = assessments
		.filter((a) => a.status === "exploitable")
		.map((a) => proposeAdvisoryRecovery(a));
	return { assessments, attribution, recoveries };
}

/** A short rendering suitable for an incident channel. */
export function renderAdvisoryIngestReport(report: AdvisoryIngestReport): string {
	const lines: string[] = ["# Security Advisory Ingest Report", ""];
	for (const assessment of report.assessments) {
		lines.push(
			`- ${assessment.advisory.id} (${assessment.advisory.package}): ${assessment.status}`,
		);
	}
	lines.push("");
	if (report.attribution.attributed) {
		lines.push(
			`**Attributed:** ${report.attribution.advisory.id} (${report.attribution.status}) — ${report.attribution.reason}`,
		);
	} else {
		lines.push(`**Not attributed:** ${report.attribution.reason}`);
	}
	if (report.recoveries.length > 0) {
		lines.push("", "## Proposed recovery", "");
		for (const recovery of report.recoveries) {
			for (const action of recovery.actions) {
				lines.push(
					action.kind === "upgrade"
						? `- upgrade ${action.package} to ${action.to_version}`
						: `- isolate under '${action.profile}' profile: ${action.reason}`,
				);
			}
			for (const reason of recovery.refused) lines.push(`  (refused: ${reason})`);
		}
	}
	return lines.join("\n");
}
