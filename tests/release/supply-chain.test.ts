import { describe, expect, test } from "bun:test";
import {
	type Artifact,
	type CompatibilityCell,
	type DependencyRecord,
	SBOM_FORMAT,
	SUPPORT_STATES,
	buildCompatibilityMatrix,
	buildSbom,
	compareBuilds,
	digestOf,
	signRelease,
	supplyChainReport,
	verifyRelease,
} from "../../src/release/supply-chain.js";

const NOW = 1_700_000_000_000;
const KEY = "release-signing-key";

const DEPS: DependencyRecord[] = [
	{ name: "commander", version: "13.0.0", direct: true, license: "MIT" },
	{ name: "zod", version: "3.24.0", direct: true, license: "MIT" },
	{ name: "left-pad", version: "1.3.0", direct: false },
];

function artifact(path: string, digest: string, size = 100): Artifact {
	return { path, digest, size_bytes: size };
}

describe("an SBOM from a manifest is not an SBOM", () => {
	test("a lockfile basis produces a complete document", () => {
		const sbom = buildSbom({ name: "failsafe", version: "0.1.0" }, DEPS, "lockfile", NOW);
		expect(sbom.complete).toBe(true);
		expect(sbom.bomFormat).toBe(SBOM_FORMAT);
		expect(sbom.components).toHaveLength(3);
	});

	test("a manifest basis is marked incomplete and says why", () => {
		const sbom = buildSbom(
			{ name: "failsafe", version: "0.1.0" },
			DEPS.filter((d) => d.direct),
			"manifest",
			NOW,
		);
		expect(sbom.complete).toBe(false);
		expect(sbom.caveats[0]).toContain("more often transitive than direct");
	});

	test("no dependency source at all proves nothing and says so", () => {
		const sbom = buildSbom({ name: "x", version: "1" }, [], "none", NOW);
		expect(sbom.complete).toBe(false);
		expect(sbom.caveats[0]).toContain("proves nothing");
	});

	test("a missing license means unknown, not permissive", () => {
		const sbom = buildSbom({ name: "x", version: "1" }, DEPS, "lockfile", NOW);
		expect(sbom.caveats.some((c) => c.includes("unknown, not permissive"))).toBe(true);
		expect(sbom.components.find((c) => c.name === "left-pad")?.licenses).toEqual([]);
	});

	test("direct and transitive dependencies are distinguishable in the document", () => {
		const sbom = buildSbom({ name: "x", version: "1" }, DEPS, "lockfile", NOW);
		expect(sbom.components.find((c) => c.name === "left-pad")?.scope).toBe("optional");
		expect(sbom.components.find((c) => c.name === "zod")?.scope).toBe("required");
	});

	test("components carry a purl, which is what vulnerability feeds key on", () => {
		const sbom = buildSbom({ name: "x", version: "1" }, DEPS, "lockfile", NOW);
		expect(sbom.components[0].purl).toContain("pkg:npm/");
	});

	test("components are sorted, so two SBOMs of the same input are comparable", () => {
		const forward = buildSbom({ name: "x", version: "1" }, DEPS, "lockfile", NOW);
		const reversed = buildSbom({ name: "x", version: "1" }, [...DEPS].reverse(), "lockfile", NOW);
		expect(JSON.stringify(forward.components)).toBe(JSON.stringify(reversed.components));
	});
});

describe("a signature is attribution, not assurance", () => {
	const artifacts = [artifact("dist/index.js", digestOf("a")), artifact("dist/server.js", digestOf("b"))];
	const sbomDigest = digestOf("sbom");

	function signed() {
		return signRelease(
			{
				project: "failsafe",
				version: "0.1.0",
				built_at_ms: NOW,
				artifacts,
				sbom_digest: sbomDigest,
			},
			KEY,
		);
	}

	test("a matching release verifies", () => {
		const result = verifyRelease(signed(), artifacts, sbomDigest, KEY);
		expect(result.valid).toBe(true);
		expect(result.problems).toEqual([]);
	});

	test("what a valid signature proves is stated on every result", () => {
		for (const key of [KEY, "wrong"]) {
			const result = verifyRelease(signed(), artifacts, sbomDigest, key);
			expect(result.what_this_proves).toContain("establishes nothing about whether they are");
		}
	});

	test("an altered artifact fails against its signed digest", () => {
		const altered = [artifact("dist/index.js", digestOf("tampered")), artifacts[1]];
		const result = verifyRelease(signed(), altered, sbomDigest, KEY);
		expect(result.problems.some((p) => p.includes("does not match its signed digest"))).toBe(true);
	});

	test("a missing artifact is reported", () => {
		const result = verifyRelease(signed(), [artifacts[0]], sbomDigest, KEY);
		expect(result.problems.some((p) => p.includes("is not present"))).toBe(true);
	});

	test("an extra artifact is reported as uncovered", () => {
		const result = verifyRelease(
			signed(),
			[...artifacts, artifact("dist/extra.js", digestOf("x"))],
			sbomDigest,
			KEY,
		);
		expect(result.problems.some((p) => p.includes("no guarantee at all"))).toBe(true);
	});

	test("a swapped SBOM breaks the matched pair", () => {
		const result = verifyRelease(signed(), artifacts, digestOf("other sbom"), KEY);
		expect(result.problems.some((p) => p.includes("no longer a matched pair"))).toBe(true);
	});

	test("a different key does not verify", () => {
		expect(verifyRelease(signed(), artifacts, sbomDigest, "other").valid).toBe(false);
	});
});

describe("reproducibility is verified, not asserted", () => {
	test("identical builds are reproducible", () => {
		const build = [artifact("a.js", digestOf("a")), artifact("b.js", digestOf("b"))];
		const result = compareBuilds(build, build);
		expect(result.reproducible).toBe(true);
		expect(result.detail).toContain("byte for byte");
	});

	test("a same-size difference is flagged as probably an embedded timestamp", () => {
		const first = [artifact("a.js", digestOf("build-1"), 500)];
		const second = [artifact("a.js", digestOf("build-2"), 500)];
		const result = compareBuilds(first, second);
		expect(result.reproducible).toBe(false);
		expect(result.differing[0].same_size).toBe(true);
		expect(result.detail).toContain("embedded timestamp, path, or build id");
	});

	test("a size difference is distinguished from a same-size one", () => {
		const result = compareBuilds(
			[artifact("a.js", digestOf("x"), 500)],
			[artifact("a.js", digestOf("y"), 900)],
		);
		expect(result.differing[0].same_size).toBe(false);
	});

	test("artifacts present in only one build are named per side", () => {
		const result = compareBuilds(
			[artifact("a.js", digestOf("a")), artifact("only-first.js", digestOf("f"))],
			[artifact("a.js", digestOf("a")), artifact("only-second.js", digestOf("s"))],
		);
		expect(result.only_in_first).toEqual(["only-first.js"]);
		expect(result.only_in_second).toEqual(["only-second.js"]);
		expect(result.reproducible).toBe(false);
	});

	test("differing artifacts are named and sorted, which is where the investigation starts", () => {
		const result = compareBuilds(
			[artifact("z.js", digestOf("1")), artifact("a.js", digestOf("1"))],
			[artifact("z.js", digestOf("2")), artifact("a.js", digestOf("2"))],
		);
		expect(result.differing.map((d) => d.path)).toEqual(["a.js", "z.js"]);
	});

	test("empty builds compare as trivially reproducible", () => {
		expect(compareBuilds([], []).reproducible).toBe(true);
	});
});

describe("untested is not supported", () => {
	const runtimes = ["bun-1.0", "bun-1.3"];
	const platforms = ["linux-x64", "darwin-arm64"];

	test("every combination gets a cell, including undeclared ones", () => {
		const matrix = buildCompatibilityMatrix("0.1.0", runtimes, platforms, []);
		expect(matrix.cells).toHaveLength(4);
		expect(matrix.summary.untested).toBe(4);
		expect(matrix.summary.unenumerated).toBe(4);
	});

	test("an undeclared cell says untested is not the same as supported", () => {
		const matrix = buildCompatibilityMatrix("0.1.0", runtimes, platforms, []);
		expect(matrix.cells[0].note).toContain("not the same as supported");
	});

	test("declared cells are used as given", () => {
		const declared: CompatibilityCell[] = [
			{
				runtime: "bun-1.3",
				platform: "linux-x64",
				state: "supported",
				evidence: "CI run 4821",
			},
			{ runtime: "bun-1.0", platform: "darwin-arm64", state: "unsupported", evidence: "issue #12" },
		];
		const matrix = buildCompatibilityMatrix("0.1.0", runtimes, platforms, declared);
		expect(matrix.summary.supported).toBe(1);
		expect(matrix.summary.unsupported).toBe(1);
		expect(matrix.summary.untested).toBe(2);
	});

	test("a claim with no evidence is called an assertion", () => {
		const matrix = buildCompatibilityMatrix("0.1.0", ["a"], ["b"], [
			{ runtime: "a", platform: "b", state: "supported" },
		]);
		expect(matrix.caveats.some((c) => c.includes("an assertion, not a test result"))).toBe(true);
	});

	test("a fully declared matrix raises no untested caveat", () => {
		const declared: CompatibilityCell[] = runtimes.flatMap((runtime) =>
			platforms.map((platform) => ({
				runtime,
				platform,
				state: "supported" as const,
				evidence: "CI",
			})),
		);
		const matrix = buildCompatibilityMatrix("0.1.0", runtimes, platforms, declared);
		expect(matrix.summary.untested).toBe(0);
		expect(matrix.caveats).toEqual([]);
	});

	test("the support states are the declared vocabulary", () => {
		expect(SUPPORT_STATES).toEqual(["supported", "unsupported", "untested"]);
	});
});

describe("the report separates what is established from what is not", () => {
	function parts(overrides: Partial<Parameters<typeof supplyChainReport>[0]> = {}) {
		const artifacts = [artifact("a.js", digestOf("a"))];
		const sbomDigest = digestOf("sbom");
		return {
			sbom: buildSbom({ name: "x", version: "1" }, DEPS, "lockfile", NOW),
			signature: verifyRelease(
				signRelease(
					{ project: "x", version: "1", built_at_ms: NOW, artifacts, sbom_digest: sbomDigest },
					KEY,
				),
				artifacts,
				sbomDigest,
				KEY,
			),
			reproducibility: compareBuilds(artifacts, artifacts),
			compatibility: buildCompatibilityMatrix("1", ["a"], ["b"], [
				{ runtime: "a", platform: "b", state: "supported", evidence: "CI" },
			]),
			...overrides,
		};
	}

	test("a clean release establishes all four and still disclaims the signature", () => {
		const report = supplyChainReport(parts());
		expect(report.established).toHaveLength(4);
		expect(
			report.unestablished.some((u) => u.includes("attribution, not assurance")),
		).toBe(true);
	});

	test("an incomplete SBOM moves to the unestablished list", () => {
		const report = supplyChainReport(
			parts({ sbom: buildSbom({ name: "x", version: "1" }, DEPS, "manifest", NOW) }),
		);
		expect(report.unestablished.some((u) => u.includes("direct dependencies only"))).toBe(true);
	});

	test("a failed signature establishes no attribution at all", () => {
		const report = supplyChainReport(
			parts({
				signature: {
					valid: false,
					problems: ["bad"],
					what_this_proves: "x",
				},
			}),
		);
		expect(report.unestablished.some((u) => u.includes("any attribution at all"))).toBe(true);
		expect(report.established.some((e) => e.includes("exact bytes"))).toBe(false);
	});

	test("a non-reproducible build is named with its artifact count", () => {
		const report = supplyChainReport({
			...parts(),
			reproducibility: compareBuilds(
				[artifact("a.js", digestOf("1"))],
				[artifact("a.js", digestOf("2"))],
			),
		});
		expect(report.unestablished.some((u) => u.includes("1 artifact(s) differ"))).toBe(true);
	});

	test("untested combinations appear as unestablished support", () => {
		const report = supplyChainReport({
			...parts(),
			compatibility: buildCompatibilityMatrix("1", ["a", "b"], ["x"], []),
		});
		expect(
			report.unestablished.some((u) => u.includes("untested rather than working")),
		).toBe(true);
	});
});
