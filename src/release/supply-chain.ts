/**
 * SBOMs, signed releases, reproducible packages, and compatibility matrices
 * (item 94).
 *
 * All four of these are things a project can claim without doing, and the
 * claims are hard to falsify from outside. This module's contribution is to
 * make each claim carry the evidence for itself, and to make the absence of
 * evidence visible rather than silent.
 *
 * - **An SBOM built from a manifest is not an SBOM.** It lists what was asked
 *   for, not what was installed, and the vulnerable package is almost always
 *   transitive. `buildSbom` records which source it had and marks the document
 *   incomplete when it only had direct dependencies.
 *
 * - **Reproducibility is verified, not asserted.** Building twice and comparing
 *   digests is the whole test. When they differ, "the build is not
 *   reproducible" is useless and "these three files differ, and here are their
 *   sizes" is actionable, so the differing artifacts are named.
 *
 * - **A signature proves who built an artifact, not that the artifact is
 *   safe.** Every verification result says so, because "signed release" is read
 *   by most people as a safety property and it is an attribution property.
 *
 * - **A compatibility matrix must distinguish tested-and-works from untested.**
 *   Most matrices render an untested combination as blank, which reads as
 *   supported; here `untested` is a first-class cell and the summary counts it.
 *
 * Pure: takes inputs, produces documents. Signing keys are arguments; nothing
 * here fetches, publishes, or executes a build.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type DependencyRecord = {
	name: string;
	version: string;
	/** Direct dependency of this project, or pulled in transitively. */
	direct: boolean;
	license?: string;
	/** Where the resolved version came from. */
	source?: string;
};

export const SBOM_FORMAT = "CycloneDX-1.5-subset";

export type SbomComponent = {
	type: "library";
	name: string;
	version: string;
	scope: "required" | "optional";
	licenses: string[];
	/** Package URL, the identifier vulnerability feeds actually key on. */
	purl: string;
};

export type Sbom = {
	bomFormat: typeof SBOM_FORMAT;
	specVersion: "1.5";
	serialNumber: string;
	metadata: {
		timestamp: string;
		component: { type: "application"; name: string; version: string };
		/** How the dependency list was obtained. */
		basis: "lockfile" | "manifest" | "none";
	};
	components: SbomComponent[];
	/**
	 * True only when every transitive dependency is present. A `false` here is
	 * the difference between a document and a compliance artifact.
	 */
	complete: boolean;
	caveats: string[];
};

/**
 * Build an SBOM.
 *
 * `basis` is the load-bearing field. A manifest-derived SBOM lists direct
 * dependencies and misses the transitive ones, which is where the vulnerable
 * package usually is — so it is marked incomplete and says why, rather than
 * being a shorter document that looks like the same thing.
 */
export function buildSbom(
	project: { name: string; version: string },
	dependencies: DependencyRecord[],
	basis: Sbom["metadata"]["basis"],
	nowMs: number,
): Sbom {
	const components: SbomComponent[] = [...dependencies]
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
		.map((dependency) => ({
			type: "library" as const,
			name: dependency.name,
			version: dependency.version,
			scope: dependency.direct ? ("required" as const) : ("optional" as const),
			licenses: dependency.license ? [dependency.license] : [],
			purl: `pkg:npm/${encodeURIComponent(dependency.name)}@${encodeURIComponent(dependency.version)}`,
		}));

	const caveats: string[] = [];
	const complete = basis === "lockfile";
	if (basis === "manifest") {
		caveats.push(
			"this SBOM was built from a manifest and lists direct dependencies only; the transitive graph is absent, and a vulnerable package is more often transitive than direct",
		);
	}
	if (basis === "none") {
		caveats.push(
			"no dependency source was supplied; this document lists nothing and proves nothing",
		);
	}
	const unlicensed = components.filter((c) => c.licenses.length === 0);
	if (unlicensed.length > 0) {
		caveats.push(
			`${unlicensed.length} component(s) have no license recorded; absence here means unknown, not permissive`,
		);
	}

	return {
		bomFormat: SBOM_FORMAT,
		specVersion: "1.5",
		serialNumber: `urn:uuid:${createHash("sha256").update(`${project.name}@${project.version}@${nowMs}`).digest("hex").slice(0, 32)}`,
		metadata: {
			timestamp: new Date(nowMs).toISOString(),
			component: { type: "application", name: project.name, version: project.version },
			basis,
		},
		components,
		complete,
		caveats,
	};
}

export type Artifact = {
	path: string;
	/** SHA-256 of the contents. */
	digest: string;
	size_bytes: number;
};

export type ReleaseManifest = {
	project: string;
	version: string;
	built_at_ms: number;
	artifacts: Artifact[];
	/** SBOM digest, so the SBOM is covered by the release signature. */
	sbom_digest: string;
	signature: string;
};

function manifestPayload(manifest: Omit<ReleaseManifest, "signature">): string {
	return JSON.stringify({
		project: manifest.project,
		version: manifest.version,
		built_at_ms: manifest.built_at_ms,
		artifacts: [...manifest.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
		sbom_digest: manifest.sbom_digest,
	});
}

export function digestOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Sign a release manifest, covering the artifacts and the SBOM together. */
export function signRelease(
	manifest: Omit<ReleaseManifest, "signature">,
	signingKey: string,
): ReleaseManifest {
	return {
		...manifest,
		signature: createHmac("sha256", signingKey).update(manifestPayload(manifest)).digest("hex"),
	};
}

export type SignatureVerification = {
	valid: boolean;
	problems: string[];
	/** Repeated on every result, valid or not. */
	what_this_proves: string;
};

/**
 * Verify a release signature against the artifacts actually present.
 *
 * `what_this_proves` is on every result because "signed release" is read as a
 * safety property and is an attribution property: it establishes that whoever
 * holds the key produced these bytes, and nothing whatsoever about whether the
 * bytes are correct, safe, or built from the source they claim.
 */
export function verifyRelease(
	manifest: ReleaseManifest,
	present: Artifact[],
	sbomDigest: string,
	signingKey: string,
): SignatureVerification {
	const problems: string[] = [];

	const expected = Buffer.from(
		createHmac("sha256", signingKey).update(manifestPayload(manifest)).digest("hex"),
		"hex",
	);
	const actual = Buffer.from(manifest.signature, "hex");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		problems.push("the release signature does not verify");
	}

	if (manifest.sbom_digest !== sbomDigest) {
		problems.push(
			"the SBOM does not match the one that was signed; the dependency list and the artifacts are no longer a matched pair",
		);
	}

	const byPath = new Map(present.map((a) => [a.path, a]));
	for (const artifact of manifest.artifacts) {
		const found = byPath.get(artifact.path);
		if (!found) {
			problems.push(`'${artifact.path}' is in the signed manifest and is not present`);
			continue;
		}
		if (found.digest !== artifact.digest) {
			problems.push(`'${artifact.path}' does not match its signed digest`);
		}
	}
	const signed = new Set(manifest.artifacts.map((a) => a.path));
	for (const artifact of present) {
		if (!signed.has(artifact.path)) {
			problems.push(
				`'${artifact.path}' is present and not covered by the signature; it carries no guarantee at all`,
			);
		}
	}

	return {
		valid: problems.length === 0,
		problems,
		what_this_proves:
			"a valid signature establishes that the holder of the signing key produced these exact bytes; it establishes nothing about whether they are correct, safe, or built from the source they claim",
	};
}

export type ReproducibilityResult = {
	reproducible: boolean;
	artifacts_compared: number;
	/** Artifacts whose digests differ, with both sizes so the cause is diagnosable. */
	differing: Array<{ path: string; size_a: number; size_b: number; same_size: boolean }>;
	/** Present in one build and not the other. */
	only_in_first: string[];
	only_in_second: string[];
	detail: string;
};

/**
 * Compare two builds.
 *
 * Names the differing artifacts and reports whether they differ in *size* as
 * well as content: a same-size difference is almost always an embedded
 * timestamp, path, or build id, while a size difference usually means genuinely
 * different code. "The build is not reproducible" is useless; that distinction
 * is where the investigation starts.
 */
export function compareBuilds(first: Artifact[], second: Artifact[]): ReproducibilityResult {
	const a = new Map(first.map((x) => [x.path, x]));
	const b = new Map(second.map((x) => [x.path, x]));

	const differing: ReproducibilityResult["differing"] = [];
	for (const [path, left] of a) {
		const right = b.get(path);
		if (!right) continue;
		if (left.digest !== right.digest) {
			differing.push({
				path,
				size_a: left.size_bytes,
				size_b: right.size_bytes,
				same_size: left.size_bytes === right.size_bytes,
			});
		}
	}

	const onlyFirst = [...a.keys()].filter((p) => !b.has(p)).sort();
	const onlySecond = [...b.keys()].filter((p) => !a.has(p)).sort();
	const reproducible = differing.length === 0 && onlyFirst.length === 0 && onlySecond.length === 0;

	const sameSize = differing.filter((d) => d.same_size).length;
	return {
		reproducible,
		artifacts_compared: a.size,
		differing: differing.sort((x, y) => x.path.localeCompare(y.path)),
		only_in_first: onlyFirst,
		only_in_second: onlySecond,
		detail: reproducible
			? `${a.size} artifact(s) matched byte for byte across two builds`
			: `${differing.length} artifact(s) differ (${sameSize} at identical size, which usually means an embedded timestamp, path, or build id rather than different code) and ${onlyFirst.length + onlySecond.length} exist in only one build`,
	};
}

export const SUPPORT_STATES = ["supported", "unsupported", "untested"] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];

export type CompatibilityCell = {
	runtime: string;
	platform: string;
	state: SupportState;
	/** Required for `supported` and `unsupported`; absent for `untested`. */
	evidence?: string;
	note?: string;
};

export type CompatibilityMatrix = {
	project_version: string;
	runtimes: string[];
	platforms: string[];
	cells: CompatibilityCell[];
	summary: {
		supported: number;
		unsupported: number;
		untested: number;
		/** Combinations no cell covers at all. */
		unenumerated: number;
	};
	caveats: string[];
};

/**
 * Build a compatibility matrix over the full cross-product.
 *
 * Every combination gets a cell. Most published matrices omit the ones nobody
 * tested, and an omitted cell reads as supported — so here the cross-product is
 * filled in and anything without a declaration becomes `untested` with that
 * word visible in the table.
 */
export function buildCompatibilityMatrix(
	projectVersion: string,
	runtimes: string[],
	platforms: string[],
	declared: CompatibilityCell[],
): CompatibilityMatrix {
	const byKey = new Map(declared.map((c) => [`${c.runtime}|${c.platform}`, c]));
	const cells: CompatibilityCell[] = [];
	let unenumerated = 0;

	for (const runtime of runtimes) {
		for (const platform of platforms) {
			const cell = byKey.get(`${runtime}|${platform}`);
			if (cell) {
				cells.push(cell);
			} else {
				unenumerated++;
				cells.push({
					runtime,
					platform,
					state: "untested",
					note: "no declaration for this combination; untested is not the same as supported",
				});
			}
		}
	}

	const summary = {
		supported: cells.filter((c) => c.state === "supported").length,
		unsupported: cells.filter((c) => c.state === "unsupported").length,
		untested: cells.filter((c) => c.state === "untested").length,
		unenumerated,
	};

	const caveats: string[] = [];
	if (summary.untested > 0) {
		caveats.push(
			`${summary.untested} of ${cells.length} combination(s) are untested; a matrix that renders these as blank is read as supported, which is why they are named here`,
		);
	}
	const unevidenced = cells.filter(
		(c) => c.state !== "untested" && (!c.evidence || c.evidence.length === 0),
	);
	if (unevidenced.length > 0) {
		caveats.push(
			`${unevidenced.length} cell(s) claim a state with no evidence recorded; an undocumented "supported" is an assertion, not a test result`,
		);
	}

	return { project_version: projectVersion, runtimes, platforms, cells, summary, caveats };
}

export type SupplyChainReport = {
	sbom: Sbom;
	signature: SignatureVerification;
	reproducibility: ReproducibilityResult;
	compatibility: CompatibilityMatrix;
	/** The claims this release can actually support. */
	established: string[];
	/** The claims it cannot. */
	unestablished: string[];
};

/**
 * Roll the four into one statement of what is and is not established.
 *
 * The `unestablished` list is the output that matters: it is what a release
 * announcement must not say, and having it computed rather than remembered is
 * the only way it stays accurate across releases.
 */
export function supplyChainReport(parts: {
	sbom: Sbom;
	signature: SignatureVerification;
	reproducibility: ReproducibilityResult;
	compatibility: CompatibilityMatrix;
}): SupplyChainReport {
	const established: string[] = [];
	const unestablished: string[] = [];

	if (parts.sbom.complete) established.push("the complete dependency graph is enumerated");
	else
		unestablished.push("a complete dependency inventory: the SBOM covers direct dependencies only");

	if (parts.signature.valid) {
		established.push("the artifacts are the exact bytes signed by the key holder");
		unestablished.push(
			"that the artifacts are safe or built from the claimed source: a signature is attribution, not assurance",
		);
	} else {
		unestablished.push("any attribution at all: the release signature does not verify");
	}

	if (parts.reproducibility.reproducible) {
		established.push("two independent builds produced byte-identical artifacts");
	} else {
		unestablished.push(
			`reproducibility: ${parts.reproducibility.differing.length} artifact(s) differ between builds`,
		);
	}

	if (parts.compatibility.summary.untested === 0) {
		established.push("every runtime/platform combination has a tested result");
	} else {
		unestablished.push(
			`support for ${parts.compatibility.summary.untested} runtime/platform combination(s), which are untested rather than working`,
		);
	}

	return { ...parts, established, unestablished };
}
