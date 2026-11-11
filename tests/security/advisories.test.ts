import { describe, expect, test } from "bun:test";
import type { SbomComponent } from "../../src/release/supply-chain.js";
import {
	type DeploymentExposure,
	type IncidentEvidence,
	type SecurityAdvisory,
	assessExploitability,
	attributeAdvisoryToIncident,
	ingestAdvisories,
	matchAdvisoryToSbom,
	proposeAdvisoryRecovery,
	renderAdvisoryIngestReport,
} from "../../src/security/advisories.js";

function component(name: string, version: string): SbomComponent {
	return {
		type: "library",
		name,
		version,
		scope: "required",
		licenses: ["MIT"],
		purl: `pkg:npm/${name}@${version}`,
	};
}

function advisory(
	partial: Partial<SecurityAdvisory> & { id: string; package: string },
): SecurityAdvisory {
	return {
		affected_versions: ["1.0.0"],
		attack_vector: "network",
		summary: "test advisory",
		...partial,
	};
}

const FULL_EXPOSURE: DeploymentExposure = {
	network_reachable: true,
	local_reachable: true,
	physical_reachable: true,
};
const NO_EXPOSURE: DeploymentExposure = {
	network_reachable: false,
	local_reachable: false,
	physical_reachable: false,
};

describe("matchAdvisoryToSbom", () => {
	test("an advisory naming a package at an affected version matches that component", () => {
		const components = [component("left-pad", "1.0.0")];
		const advisories = [advisory({ id: "GHSA-1", package: "left-pad" })];
		const matches = matchAdvisoryToSbom(advisories, components);
		expect(matches).toHaveLength(1);
		expect(matches[0].matched_components).toHaveLength(1);
		expect(matches[0].matched_components[0].name).toBe("left-pad");
	});

	test("an advisory naming a package absent from the SBOM matches nothing, not dropped", () => {
		const components = [component("other-pkg", "2.0.0")];
		const advisories = [advisory({ id: "GHSA-2", package: "left-pad" })];
		const matches = matchAdvisoryToSbom(advisories, components);
		expect(matches).toHaveLength(1);
		expect(matches[0].matched_components).toHaveLength(0);
	});

	test("a component at a version outside the affected range does not match", () => {
		const components = [component("left-pad", "9.9.9")];
		const advisories = [
			advisory({ id: "GHSA-3", package: "left-pad", affected_versions: ["1.0.0"] }),
		];
		const matches = matchAdvisoryToSbom(advisories, components);
		expect(matches[0].matched_components).toHaveLength(0);
	});
});

describe("assessExploitability", () => {
	test("no matched components is not_affected", () => {
		const match = {
			advisory: advisory({ id: "GHSA-4", package: "left-pad" }),
			matched_components: [],
		};
		const result = assessExploitability(match, FULL_EXPOSURE);
		expect(result.status).toBe("not_affected");
	});

	test("a matched component with a reachable attack vector is exploitable", () => {
		const match = {
			advisory: advisory({ id: "GHSA-5", package: "left-pad", attack_vector: "network" }),
			matched_components: [component("left-pad", "1.0.0")],
		};
		const result = assessExploitability(match, FULL_EXPOSURE);
		expect(result.status).toBe("exploitable");
	});

	test("a matched component with an unreachable attack vector is vulnerable_not_exploitable, not dropped", () => {
		const match = {
			advisory: advisory({ id: "GHSA-6", package: "left-pad", attack_vector: "network" }),
			matched_components: [component("left-pad", "1.0.0")],
		};
		const result = assessExploitability(match, NO_EXPOSURE);
		expect(result.status).toBe("vulnerable_not_exploitable");
		expect(result.matched_components).toHaveLength(1);
	});

	test("a local-vector advisory is assessed against local_reachable, not network_reachable", () => {
		const match = {
			advisory: advisory({ id: "GHSA-7", package: "left-pad", attack_vector: "local" }),
			matched_components: [component("left-pad", "1.0.0")],
		};
		const exposure: DeploymentExposure = {
			network_reachable: true,
			local_reachable: false,
			physical_reachable: true,
		};
		const result = assessExploitability(match, exposure);
		expect(result.status).toBe("vulnerable_not_exploitable");
	});
});

describe("proposeAdvisoryRecovery", () => {
	test("an exploitable advisory with a patched_version proposes exactly that upgrade", () => {
		const assessment = {
			advisory: advisory({ id: "GHSA-8", package: "left-pad", patched_version: "1.0.1" }),
			status: "exploitable" as const,
			matched_components: [component("left-pad", "1.0.0")],
			rationale: "test",
		};
		const recovery = proposeAdvisoryRecovery(assessment);
		expect(recovery.actions).toHaveLength(1);
		expect(recovery.actions[0]).toEqual({
			kind: "upgrade",
			package: "left-pad",
			to_version: "1.0.1",
		});
		expect(recovery.refused).toHaveLength(0);
	});

	test("an exploitable advisory with no patched_version proposes isolation, not an upgrade that does not exist", () => {
		const assessment = {
			advisory: advisory({ id: "GHSA-9", package: "left-pad" }),
			status: "exploitable" as const,
			matched_components: [component("left-pad", "1.0.0")],
			rationale: "test",
		};
		const recovery = proposeAdvisoryRecovery(assessment);
		expect(recovery.actions).toHaveLength(1);
		expect(recovery.actions[0].kind).toBe("isolate");
		if (recovery.actions[0].kind === "isolate") {
			expect(recovery.actions[0].profile).toBe("proposed_fix");
		}
		expect(recovery.refused.length).toBeGreaterThan(0);
	});

	test("a not_affected or vulnerable_not_exploitable assessment proposes nothing", () => {
		const assessment = {
			advisory: advisory({ id: "GHSA-10", package: "left-pad" }),
			status: "not_affected" as const,
			matched_components: [],
			rationale: "test",
		};
		const recovery = proposeAdvisoryRecovery(assessment);
		expect(recovery.actions).toHaveLength(0);
		expect(recovery.refused.length).toBeGreaterThan(0);
	});
});

describe("attributeAdvisoryToIncident", () => {
	test("an exploitable assessment naming the incident's component is attributed ahead of a merely-vulnerable one", () => {
		const assessments = [
			{
				advisory: advisory({ id: "GHSA-11", package: "dormant-pkg" }),
				status: "vulnerable_not_exploitable" as const,
				matched_components: [component("dormant-pkg", "1.0.0")],
				rationale: "test",
			},
			{
				advisory: advisory({ id: "GHSA-12", package: "left-pad" }),
				status: "exploitable" as const,
				matched_components: [component("left-pad", "1.0.0")],
				rationale: "test",
			},
		];
		const evidence: IncidentEvidence = {
			implicated_components: ["dormant-pkg", "left-pad"],
			error_text: "",
		};
		const attribution = attributeAdvisoryToIncident(assessments, evidence);
		expect(attribution.attributed).toBe(true);
		if (attribution.attributed) expect(attribution.advisory.id).toBe("GHSA-12");
	});

	test("no implicated package yields an explicit non-attribution, not a silent guess", () => {
		const assessments = [
			{
				advisory: advisory({ id: "GHSA-13", package: "left-pad" }),
				status: "exploitable" as const,
				matched_components: [component("left-pad", "1.0.0")],
				rationale: "test",
			},
		];
		const evidence: IncidentEvidence = {
			implicated_components: [],
			error_text: "unrelated failure",
		};
		const attribution = attributeAdvisoryToIncident(assessments, evidence);
		expect(attribution.attributed).toBe(false);
	});
});

describe("ingestAdvisories", () => {
	test("composes match, assess, attribute, and recovery into one report", () => {
		const components = [component("left-pad", "1.0.0")];
		const advisories = [advisory({ id: "GHSA-14", package: "left-pad", patched_version: "1.0.1" })];
		const evidence: IncidentEvidence = { implicated_components: ["left-pad"], error_text: "" };
		const report = ingestAdvisories(advisories, components, FULL_EXPOSURE, evidence);
		expect(report.assessments).toHaveLength(1);
		expect(report.assessments[0].status).toBe("exploitable");
		expect(report.attribution.attributed).toBe(true);
		expect(report.recoveries).toHaveLength(1);
		expect(report.recoveries[0].actions[0]).toEqual({
			kind: "upgrade",
			package: "left-pad",
			to_version: "1.0.1",
		});
	});

	test("a not_affected advisory produces zero recoveries, not a vacuous one", () => {
		const components = [component("other-pkg", "2.0.0")];
		const advisories = [advisory({ id: "GHSA-15", package: "left-pad" })];
		const evidence: IncidentEvidence = { implicated_components: [], error_text: "" };
		const report = ingestAdvisories(advisories, components, FULL_EXPOSURE, evidence);
		expect(report.recoveries).toHaveLength(0);
	});
});

describe("renderAdvisoryIngestReport", () => {
	test("renders assessments, attribution, and proposed recovery actions", () => {
		const components = [component("left-pad", "1.0.0")];
		const advisories = [advisory({ id: "GHSA-16", package: "left-pad", patched_version: "1.0.1" })];
		const evidence: IncidentEvidence = { implicated_components: ["left-pad"], error_text: "" };
		const report = ingestAdvisories(advisories, components, FULL_EXPOSURE, evidence);
		const text = renderAdvisoryIngestReport(report);
		expect(text).toContain("GHSA-16");
		expect(text).toContain("exploitable");
		expect(text).toContain("upgrade left-pad to 1.0.1");
	});
});
