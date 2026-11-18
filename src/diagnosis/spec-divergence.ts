/**
 * Diagnose generated-SDK and spec divergence (item 45, module-header
 * numbering: item 111, confirmed next-free via `grep -rohE "item [0-9]+"
 * src --include="*.ts" | sort -t' ' -k2 -n -u`, highest prior being item
 * 110 from item 44's `authorization-drift.ts`).
 *
 * `grep -rln "handwritten|generated.*client|spec.*divergence" src
 * --include="*.ts"` before this module matched nothing project-specific
 * (`cross-provider-replay.ts`, item 101, is the closest existing thing: it
 * already resolves provider identity and measures diagnosis DRIFT across
 * N runs of the SAME failure through different providers, but has no
 * notion of a "generated vs. handwritten" pairing, no notion of a
 * protocol SPEC each client is supposed to conform to, and nothing it
 * reports can be minimized the way `repro/trace-reduction.ts`'s (item 70)
 * `reduceTrace` minimizes a failing trace). Per the [MCP
 * roadmap](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/development/roadmap.mdx)'s
 * own stated direction toward generated SDKs, a generated client and a
 * handwritten reference client answering the SAME fixture can disagree
 * for reasons that are NOT all the generated client's fault — and
 * blending them into one "incompatible" bucket would misreport an
 * incomplete spec as a code defect, or a one-off transport hiccup as a
 * generator bug that will recur on every call.
 *
 * This module never replays anything itself — exactly `cross-provider-
 * replay.ts`'s own posture (that module never calls a provider; this one
 * never calls a client). A caller already ran BOTH clients against the
 * SAME fixture and supplies the two results as a `FixtureRun`; this
 * module's job is the comparison and the classification, pure functions
 * over already-computed inputs:
 *
 * 1. **Differential comparison.** `diffFixtureRun` compares a fixture's
 *    `generated` and `handwritten` `ClientOutcome`s. An outcome-TYPE
 *    mismatch (`ok` vs. `error`) or an ERROR-TYPE mismatch is reported as
 *    its own named kind rather than folded into a generic "responses
 *    differ", because neither can be partially explained by a field being
 *    spec-ambiguous — mirroring `trajectory-diff.ts`'s (item 69) own
 *    "outcome mismatch is not the same fact as a shape difference"
 *    discipline. A matched `ok`/`ok` pair is compared one level of
 *    response keys deep ("shape", `trajectory-diff.ts`'s own word for
 *    exactly this), naming every top-level key whose value differs rather
 *    than reporting "the responses are different" as one undifferentiated
 *    fact.
 *
 * 2. **Classification, pipeline-ordered, evidence-driven — never guessed.**
 *    `classifyDivergenceCause` picks exactly one of `transport_defect`,
 *    `spec_ambiguity`, `runtime_defect`, `generator_defect`, in that
 *    precedence:
 *    - `transport_defect` wins unconditionally over every other
 *      explanation, including a response_mismatch whose differing paths
 *      all happen to be declared spec-ambiguous — a corrupted wire payload
 *      can manufacture a value that LOOKS like it landed on an ambiguous
 *      field by coincidence, and a caller who has independent transport
 *      evidence has already ruled out both clients' own logic.
 *    - `spec_ambiguity` applies ONLY to a `response_mismatch` whose
 *      differing paths are ALL declared ambiguous on the fixture's own
 *      `spec_ambiguous_fields` (a property of the FIXTURE/spec, known
 *      ahead of time — not "evidence" supplied after the fact, because an
 *      ambiguity is a fact about the spec text, not about this run). A
 *      PARTIALLY-ambiguous mismatch (some differing paths declared
 *      ambiguous, some not) does NOT qualify: the unexplained remainder is
 *      exactly the genuine divergence this item asks to still classify,
 *      and reporting the whole thing as "just spec ambiguity" would hide
 *      it. `outcome_mismatch`/`error_type_mismatch` never qualify for
 *      `spec_ambiguity` either, regardless of what fields a fixture
 *      declares ambiguous: "the spec doesn't pin down this field's value"
 *      cannot explain "one client crashed and the other didn't".
 *    - `runtime_defect` and `generator_defect` are evidence-driven,
 *      exactly `programmatic-tool-failure.ts`'s (item 43) own pattern: a
 *      caller-supplied `DivergenceEvidence` field names the finding, never
 *      inferred from the diff shape alone.
 *    - With no evidence present and no full-ambiguity match, `cause` is
 *      `null` with a caveat explaining why — "I don't know" is a reportable
 *      outcome, never silently defaulted to `generator_defect` just because
 *      that is the most common real-world cause.
 *
 * 3. **Minimization reuses item 70's `reduceTrace` UNMODIFIED**, via the
 *    exact wrapped-oracle pattern `repro/authority-privacy-reduction.ts`
 *    (item 24) and `programmatic-tool-failure.ts` (item 43) already
 *    established: `reduceIncompatibilityWitnesses` treats each fixture id
 *    as a `TraceElement`, and the oracle it hands to `reduceTrace`
 *    re-runs `diagnoseSpecDivergence` against whichever fixture subset
 *    `reduceTrace` is currently testing, reporting `reproduces: true` iff
 *    ANY fixture in that subset still diverges, with `cause_signature`
 *    set to the dominant (pipeline-earliest) cause among the subset's
 *    classifications. This means item 70's own cause-drift detection does
 *    the exact right thing for free: a reduction candidate that happens
 *    to keep a DIFFERENT fixture's divergence (a different cause) than
 *    the one the caller started investigating is rejected as drift,
 *    exactly as a trace reduction that changes bugs is rejected.
 *
 * Pure: no client is invoked, no fixture is loaded from disk, and no
 * network call happens here — every `FixtureRun` is caller-supplied.
 */
import {
	type OracleResult,
	type ReductionOptions,
	type ReductionOracle,
	type ReductionResult,
	type TraceElement,
	reduceTrace,
} from "../repro/trace-reduction.js";

export type ProtocolFixture = {
	fixture_id: string;
	/**
	 * Response-body top-level field names the spec itself does not pin down
	 * for this fixture — a property of the fixture/spec, declared ahead of
	 * time, never inferred from a diff after the fact.
	 */
	spec_ambiguous_fields?: string[];
};

export type ClientOutcome = {
	outcome: "ok" | "error";
	response?: unknown;
	error_type?: string;
};

export type FixtureRun = {
	fixture_id: string;
	generated: ClientOutcome;
	handwritten: ClientOutcome;
};

export const FIXTURE_DIVERGENCE_KINDS = [
	"outcome_mismatch",
	"error_type_mismatch",
	"response_mismatch",
] as const;
export type FixtureDivergenceKind = (typeof FIXTURE_DIVERGENCE_KINDS)[number];

export type FixtureDivergence = {
	fixture_id: string;
	kind: FixtureDivergenceKind;
	detail: string;
	/** Only populated for `response_mismatch`: the differing top-level response keys, sorted. */
	differing_paths?: string[];
};

/** Pipeline order used both for picking a single classification and for the reduction oracle's dominant-cause pick. */
export const DIVERGENCE_CAUSES = [
	"transport_defect",
	"spec_ambiguity",
	"runtime_defect",
	"generator_defect",
] as const;
export type DivergenceCause = (typeof DIVERGENCE_CAUSES)[number];

export type DivergenceEvidence = {
	transport_defect?: { detail: string };
	runtime_defect?: { detail: string };
	generator_defect?: { detail: string };
};

export type DivergenceClassification = {
	fixture_id: string;
	divergence: FixtureDivergence;
	cause: DivergenceCause | null;
	caveats: string[];
};

function topLevelKeys(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	return Object.keys(value as Record<string, unknown>);
}

/** One level of key-wise response diffing — "shape", not text, mirroring `trajectory-diff.ts`'s own discipline. `["$"]` names a scalar/array top level that differs as a whole. */
function diffResponseShape(a: unknown, b: unknown): string[] {
	if (JSON.stringify(a) === JSON.stringify(b)) return [];
	const aKeys = topLevelKeys(a);
	const bKeys = topLevelKeys(b);
	if (aKeys.length === 0 && bKeys.length === 0) return ["$"];
	const allKeys = new Set([...aKeys, ...bKeys]);
	const diffs: string[] = [];
	for (const key of allKeys) {
		const av = (a as Record<string, unknown> | undefined)?.[key];
		const bv = (b as Record<string, unknown> | undefined)?.[key];
		if (JSON.stringify(av) !== JSON.stringify(bv)) diffs.push(key);
	}
	return diffs.sort();
}

/**
 * Compare one fixture's generated-client and handwritten-client outcomes.
 * `null` means the two clients agreed; otherwise names exactly how they
 * disagreed.
 */
export function diffFixtureRun(run: FixtureRun): FixtureDivergence | null {
	const { fixture_id, generated, handwritten } = run;

	if (generated.outcome !== handwritten.outcome) {
		return {
			fixture_id,
			kind: "outcome_mismatch",
			detail: `generated client returned '${generated.outcome}' while the handwritten client returned '${handwritten.outcome}'`,
		};
	}

	if (generated.outcome === "error") {
		if (generated.error_type !== handwritten.error_type) {
			return {
				fixture_id,
				kind: "error_type_mismatch",
				detail: `generated client errored with '${generated.error_type ?? "unknown"}' while the handwritten client errored with '${handwritten.error_type ?? "unknown"}'`,
			};
		}
		return null;
	}

	const differingPaths = diffResponseShape(generated.response, handwritten.response);
	if (differingPaths.length === 0) return null;
	return {
		fixture_id,
		kind: "response_mismatch",
		detail: `generated and handwritten client responses differ at: ${differingPaths.join(", ")}`,
		differing_paths: differingPaths,
	};
}

/**
 * Attribute one fixture's divergence to exactly one cause, per this
 * module's documented pipeline precedence, or to `null` with a caveat when
 * no evidence supports any of the four.
 */
export function classifyDivergenceCause(
	fixture: ProtocolFixture,
	divergence: FixtureDivergence,
	evidence: DivergenceEvidence = {},
): DivergenceClassification {
	const base = { fixture_id: fixture.fixture_id, divergence };

	if (evidence.transport_defect) {
		return {
			...base,
			cause: "transport_defect",
			caveats: [],
		};
	}

	if (divergence.kind === "response_mismatch" && divergence.differing_paths) {
		const ambiguous = new Set(fixture.spec_ambiguous_fields ?? []);
		const ambiguousPaths = divergence.differing_paths.filter((p) => ambiguous.has(p));
		const allAmbiguous =
			divergence.differing_paths.length > 0 &&
			ambiguousPaths.length === divergence.differing_paths.length;
		if (allAmbiguous) {
			return { ...base, cause: "spec_ambiguity", caveats: [] };
		}
		if (ambiguousPaths.length > 0) {
			const caveats = [
				`fields ${ambiguousPaths.join(", ")} are declared spec-ambiguous, but ${divergence.differing_paths
					.filter((p) => !ambiguous.has(p))
					.join(
						", ",
					)} also differ and is NOT declared ambiguous; the divergence is not fully explained by spec ambiguity`,
			];
			if (evidence.runtime_defect) {
				return { ...base, cause: "runtime_defect", caveats };
			}
			if (evidence.generator_defect) {
				return { ...base, cause: "generator_defect", caveats };
			}
			caveats.push(
				"no transport/runtime/generator evidence was supplied for the remaining unexplained fields; the cause cannot be attributed",
			);
			return { ...base, cause: null, caveats };
		}
	}

	if (evidence.runtime_defect) {
		return { ...base, cause: "runtime_defect", caveats: [] };
	}

	if (evidence.generator_defect) {
		return { ...base, cause: "generator_defect", caveats: [] };
	}

	return {
		...base,
		cause: null,
		caveats: [
			"a divergence was detected but no transport/runtime/generator evidence was supplied, and the differing fields (if any) are not all declared spec-ambiguous; the cause cannot be attributed",
		],
	};
}

export type SpecDivergenceReport = {
	classifications: DivergenceClassification[];
	by_cause: Partial<Record<DivergenceCause, number>>;
	unattributed: number;
};

/**
 * Compose comparison and classification across every supplied run,
 * exactly as a caller (CLI/MCP) would.
 */
export function diagnoseSpecDivergence(
	fixtures: ProtocolFixture[],
	runs: FixtureRun[],
	evidenceByFixtureId: Record<string, DivergenceEvidence> = {},
): SpecDivergenceReport {
	const fixtureById = new Map(fixtures.map((f) => [f.fixture_id, f]));
	const classifications: DivergenceClassification[] = [];

	for (const run of runs) {
		const divergence = diffFixtureRun(run);
		if (!divergence) continue;

		const fixture = fixtureById.get(run.fixture_id);
		if (!fixture) {
			classifications.push({
				fixture_id: run.fixture_id,
				divergence,
				cause: null,
				caveats: [
					`fixture '${run.fixture_id}' was not found in the supplied fixture list; the divergence cannot be checked against any declared spec-ambiguous fields`,
				],
			});
			continue;
		}
		classifications.push(
			classifyDivergenceCause(fixture, divergence, evidenceByFixtureId[run.fixture_id]),
		);
	}

	const by_cause: Partial<Record<DivergenceCause, number>> = {};
	let unattributed = 0;
	for (const c of classifications) {
		if (c.cause) by_cause[c.cause] = (by_cause[c.cause] ?? 0) + 1;
		else unattributed++;
	}

	return { classifications, by_cause, unattributed };
}

/** Render a human-readable summary of a spec-divergence report. */
export function renderSpecDivergenceReport(report: SpecDivergenceReport): string {
	const lines: string[] = ["# Generated-SDK / Spec Divergence Report", ""];
	lines.push(`Divergent fixtures (${report.classifications.length})`);
	for (const c of report.classifications) {
		lines.push(
			`- ${c.fixture_id} [${c.divergence.kind}] cause=${c.cause ?? "unattributed"}: ${c.divergence.detail}`,
		);
		for (const caveat of c.caveats) lines.push(`  - caveat: ${caveat}`);
	}
	lines.push("", "By cause:");
	for (const cause of DIVERGENCE_CAUSES) {
		lines.push(`- ${cause}: ${report.by_cause[cause] ?? 0}`);
	}
	lines.push(`- unattributed: ${report.unattributed}`);
	return lines.join("\n");
}

/** The pipeline-earliest cause present among a report's classifications, `"unattributed"` when every classification has `cause: null`, `null` when there are no classifications at all. */
function dominantCause(report: SpecDivergenceReport): DivergenceCause | "unattributed" | null {
	if (report.classifications.length === 0) return null;
	for (const cause of DIVERGENCE_CAUSES) {
		if (report.classifications.some((c) => c.cause === cause)) return cause;
	}
	return "unattributed";
}

export type IncompatibilityWitnessReductionResult = ReductionResult & {
	/** The dominant cause found against the FULL fixture set, before reduction — what every candidate's `cause_signature` is compared against. */
	baseline_cause: DivergenceCause | "unattributed";
};

/**
 * Minimize the set of fixtures that still witnesses the SAME classified
 * incompatibility, reusing item 70's `reduceTrace` unmodified.
 */
export async function reduceIncompatibilityWitnesses(
	fixtures: ProtocolFixture[],
	runs: FixtureRun[],
	evidenceByFixtureId: Record<string, DivergenceEvidence> = {},
	options: ReductionOptions = {},
): Promise<IncompatibilityWitnessReductionResult> {
	const fixtureById = new Map(fixtures.map((f) => [f.fixture_id, f]));
	const runById = new Map(runs.map((r) => [r.fixture_id, r]));

	const oracle: ReductionOracle = (elementIds: string[]): OracleResult => {
		const subsetFixtures = elementIds
			.map((id) => fixtureById.get(id))
			.filter((f): f is ProtocolFixture => f !== undefined);
		const subsetRuns = elementIds
			.map((id) => runById.get(id))
			.filter((r): r is FixtureRun => r !== undefined);
		const report = diagnoseSpecDivergence(subsetFixtures, subsetRuns, evidenceByFixtureId);
		const cause = dominantCause(report);
		if (cause === null) return { reproduces: false };
		return { reproduces: true, cause_signature: cause };
	};

	const elements: TraceElement[] = fixtures.map((f) => ({ id: f.fixture_id }));
	const result = await reduceTrace(elements, oracle, options);
	const baselineReport = diagnoseSpecDivergence(fixtures, runs, evidenceByFixtureId);
	const baseline_cause = dominantCause(baselineReport) ?? "unattributed";

	return { ...result, baseline_cause };
}
