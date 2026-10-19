/**
 * Reusable deterministic failure corpus + evaluator (item 98).
 *
 * Every existing detector in this repo — `chaos.ts`'s loud/silent verdicts
 * (item 88), `rules/flaky.ts`'s flaky classification (item 33),
 * `security/data-classes.ts`'s secret/PII classifier (item 62), and
 * `diagnosis/causal-graph.ts`'s root-cause ranking (item 38) — is tested
 * against its *own* bespoke fixtures, scattered across four test files with
 * no shared vocabulary. There is no single, labeled, provenance-tracked
 * corpus a *new* detector (or a regression check on an existing one) can run
 * against to get an apples-to-apples pass/fail report.
 *
 * This module is that corpus and that evaluator, and nothing else. It does
 * not re-implement loud/silent/flaky/security/privacy detection: every case
 * is built from already-existing primitives (`chaos.ts`'s `assessResilience`
 * for loud/silent, `rules/flaky.ts`'s `checkFlaky` for flaky,
 * `security/data-classes.ts`'s `classifyValue`/`findPii` for security/privacy)
 * so this module cannot silently define a second, divergent notion of what
 * "silent" or "flaky" means.
 *
 * Three things make the corpus trustworthy rather than decorative:
 *
 * 1. **Deterministic by construction.** Every case's fixture is a plain
 *    literal value (no `Date.now()`, no `Math.random()`, no filesystem read)
 *    so running the corpus twice produces byte-identical results — the same
 *    discipline `chaos.ts`'s own fixtures and `fuzz.ts`'s seeded generators
 *    already follow.
 *
 * 2. **An evidence graph per case, not just a verdict.** `caseEvidenceGraph`
 *    builds a tiny `CausalGraph` (item 38's own types, reused unmodified)
 *    recording what was injected, what was observed, and what the oracle
 *    concluded, as nodes and edges — so a case that fails the evaluator
 *    carries *why*, not just a boolean.
 *
 * 3. **Provenance that cannot be forged after the fact.** `signCorpus` chains
 *    every case through `exchange/custody.ts`'s existing hash-chain +
 *    HMAC-signature machinery (item 56's `buildCustodyChain`/
 *    `signCustodyChain`), reused rather than reimplemented, so a corpus
 *    distributed to a third party can be verified byte-for-byte against the
 *    chain that produced it instead of trusted on the publisher's word.
 */
import {
	type CausalEdge,
	type CausalGraph,
	type CausalNode,
	buildCausalGraph,
} from "../diagnosis/causal-graph.js";
import {
	type CustodyChain,
	type CustodyInput,
	type SignedCustodyChain,
	buildCustodyChain,
	signCustodyChain,
	verifyCustodyChain,
} from "../exchange/custody.js";
import { type FlakyStore, checkFlaky } from "../rules/flaky.js";
import { classifyValue, findPii } from "../security/data-classes.js";
import {
	type ChaosScenario,
	type ObservedBehaviour,
	type ResilienceReport,
	assessResilience,
	healthySink,
	injectChaos,
	observe,
} from "./chaos.js";

// ── Case taxonomy ──

export const CORPUS_CATEGORIES = ["loud", "silent", "flaky", "security", "privacy"] as const;
export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

/**
 * One deterministic fixture plus the oracle's expected verdict. `fixture` is
 * a discriminated union keyed by `category` so each category's fixture shape
 * only carries what its own underlying detector (chaos/flaky/data-classes)
 * actually needs — a loud/silent case needs a `ChaosScenario` + `SinkItem[]`,
 * a flaky case needs a `FlakyStore` snapshot, a security/privacy case needs a
 * `key`/`value` pair.
 */
export type CorpusCase =
	| {
			category: "loud" | "silent";
			id: string;
			label: string;
			scenario: ChaosScenario;
			items: { id: string; bytes: number; ts_ms: number }[];
			expectedVerdict: ResilienceReport["verdict"];
	  }
	| {
			category: "flaky";
			id: string;
			label: string;
			latestFix: { resolved_at: string } | null;
			unresolvedCount: number;
			threshold: number;
			expectedFlaky: boolean;
	  }
	| {
			category: "security" | "privacy";
			id: string;
			label: string;
			key: string;
			value: string;
			expectedClasses: ReturnType<typeof classifyValue>;
	  };

export interface CorpusMeta {
	id: string;
	category: CorpusCategory;
	label: string;
}

/** Lightweight projection used for id/category/label listings without re-deriving oracle verdicts. */
export function corpusMeta(corpusCase: CorpusCase): CorpusMeta {
	return { id: corpusCase.id, category: corpusCase.category, label: corpusCase.label };
}

// ── The corpus itself ──

function loudCase(): CorpusCase {
	return {
		category: "loud",
		id: "loud-exporter-outage",
		label: "exporter outage surfaces as an explicit error on every item",
		scenario: {
			kind: "exporter_outage",
			description: "collector unreachable",
			start_ms: 0,
			duration_ms: 10_000,
		},
		items: [
			{ id: "a", bytes: 10, ts_ms: 0 },
			{ id: "b", bytes: 10, ts_ms: 1 },
			{ id: "c", bytes: 10, ts_ms: 2 },
		],
		expectedVerdict: "degraded_loudly",
	};
}

function silentCase(): CorpusCase {
	return {
		category: "silent",
		id: "silent-partial-telemetry",
		label: "a sampling misconfiguration drops items with no error at all",
		scenario: {
			kind: "partial_telemetry",
			description: "half of items vanish silently",
			start_ms: 0,
			duration_ms: 10_000,
			drop_fraction: 0.5,
		},
		items: Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}`, bytes: 10, ts_ms: i })),
		expectedVerdict: "degraded_silently",
	};
}

function flakyCase(): CorpusCase {
	return {
		category: "flaky",
		id: "flaky-recurs-after-fix",
		label: "a signature that recurs 3+ times after its own fix is flaky",
		latestFix: { resolved_at: "2026-01-01T00:00:00.000Z" },
		unresolvedCount: 3,
		threshold: 3,
		expectedFlaky: true,
	};
}

function securityCase(): CorpusCase {
	return {
		category: "security",
		id: "security-openai-key-in-log",
		label: "an OpenAI-style API key embedded in a log line is a secret",
		key: "stdout_tail",
		value: "connecting with key sk-abcdefghijklmnopqrstuvwxyz0123456789",
		expectedClasses: ["secret"],
	};
}

function privacyCase(): CorpusCase {
	return {
		category: "privacy",
		id: "privacy-email-in-value",
		label: "an email address embedded in a value is PII",
		key: "error_context",
		value: "failed to notify user@example.com about the outage",
		expectedClasses: ["pii"],
	};
}

/**
 * The canonical, versioned corpus. One case per category minimum (five
 * total) -- a caller may append more cases of the same shape via
 * `buildCorpus`, but this baseline is what `signCorpus`/`DEFAULT_CORPUS`
 * ship.
 */
export function defaultCorpus(): CorpusCase[] {
	return [loudCase(), silentCase(), flakyCase(), securityCase(), privacyCase()];
}

export const DEFAULT_CORPUS = defaultCorpus();

// ── Evaluator ──

export interface CaseEvalResult {
	id: string;
	category: CorpusCategory;
	passed: boolean;
	/** What the oracle expected, serialized for the report (shape varies by category). */
	expected: unknown;
	/** What was actually observed, serialized the same way. */
	actual: unknown;
	detail: string;
}

/** Run exactly one case against its own category's existing detector. Never re-implements the detector. */
export function evaluateCase(corpusCase: CorpusCase): CaseEvalResult {
	if (corpusCase.category === "loud" || corpusCase.category === "silent") {
		const handle = injectChaos(healthySink(), corpusCase.scenario);
		const observedBehaviour = observe(handle.sink, corpusCase.items);
		const report = assessResilience(corpusCase.scenario, observedBehaviour);
		return {
			id: corpusCase.id,
			category: corpusCase.category,
			passed: report.verdict === corpusCase.expectedVerdict,
			expected: corpusCase.expectedVerdict,
			actual: report.verdict,
			detail: report.detail,
		};
	}
	if (corpusCase.category === "flaky") {
		const store: FlakyStore = {
			getLatestSuccessfulFix: () => corpusCase.latestFix,
			countUnresolvedAfterDate: () => corpusCase.unresolvedCount,
			getFlakySignature: () => null,
			upsertFlakySignature: () => {},
			listFlakySignatures: () => [],
		};
		const actual = checkFlaky(store, corpusCase.id, corpusCase.threshold);
		return {
			id: corpusCase.id,
			category: corpusCase.category,
			passed: actual === corpusCase.expectedFlaky,
			expected: corpusCase.expectedFlaky,
			actual,
			detail: actual
				? "signature classified as flaky by the existing history heuristic"
				: "signature classified as not flaky by the existing history heuristic",
		};
	}
	// security | privacy
	if (corpusCase.category === "security" || corpusCase.category === "privacy") {
		const actual = classifyValue(corpusCase.key, corpusCase.value);
		const passed =
			actual.length === corpusCase.expectedClasses.length &&
			actual.every((c) => corpusCase.expectedClasses.includes(c));
		return {
			id: corpusCase.id,
			category: corpusCase.category,
			passed,
			expected: corpusCase.expectedClasses,
			actual,
			detail:
				corpusCase.category === "privacy" && findPii(corpusCase.value).length === 0
					? "no PII pattern matched; see classifyValue's own detectable-class limitations"
					: `classifyValue returned [${actual.join(", ")}]`,
		};
	}
	// Exhaustiveness: every CorpusCase member is one of the branches above.
	throw new Error("unreachable: unknown corpus case category");
}

export interface CorpusEvalReport {
	results: CaseEvalResult[];
	passedCount: number;
	failedCount: number;
	/** ids of failing cases, in corpus order. */
	failedIds: string[];
	byCategory: Record<CorpusCategory, { total: number; passed: number }>;
}

/** Run every case through the single-case evaluator and summarize. */
export function evaluateCorpus(cases: CorpusCase[] = DEFAULT_CORPUS): CorpusEvalReport {
	const results = cases.map(evaluateCase);
	const byCategory: Record<CorpusCategory, { total: number; passed: number }> = {
		loud: { total: 0, passed: 0 },
		silent: { total: 0, passed: 0 },
		flaky: { total: 0, passed: 0 },
		security: { total: 0, passed: 0 },
		privacy: { total: 0, passed: 0 },
	};
	for (const result of results) {
		byCategory[result.category].total++;
		if (result.passed) byCategory[result.category].passed++;
	}
	const failedIds = results.filter((r) => !r.passed).map((r) => r.id);
	return {
		results,
		passedCount: results.filter((r) => r.passed).length,
		failedCount: failedIds.length,
		failedIds,
		byCategory,
	};
}

// ── Evidence graphs (item 38's CausalGraph, reused unmodified) ──

/**
 * Build a tiny evidence graph for one case: an "injected" node (what the
 * fixture declares), an "observed" node (what the detector actually saw),
 * and an "oracle" node (pass/fail), wired `injected -> observed -> oracle`.
 * Reuses item 38's `CausalNode`/`CausalEdge`/`buildCausalGraph` verbatim --
 * `kind` is repurposed from "agent/tool/service/retry" to this module's own
 * three roles via the `message` field, since `CausalNode`'s `kind` union is
 * closed and this module does not touch it.
 */
export function caseEvidenceGraph(corpusCase: CorpusCase, result: CaseEvalResult): CausalGraph {
	const nodes: CausalNode[] = [
		{
			id: `${corpusCase.id}:injected`,
			kind: "agent",
			status: "ok",
			ts: 0,
			message: `injected fixture for ${corpusCase.category} case '${corpusCase.id}'`,
		},
		{
			id: `${corpusCase.id}:observed`,
			kind: "tool",
			status: "ok",
			ts: 1,
			message: `observed: ${JSON.stringify(result.actual)}`,
		},
		{
			id: `${corpusCase.id}:oracle`,
			kind: "service",
			status: result.passed ? "ok" : "failed",
			ts: 2,
			message: result.detail,
		},
	];
	const edges: CausalEdge[] = [
		{ from: `${corpusCase.id}:injected`, to: `${corpusCase.id}:observed`, type: "causes" },
		{ from: `${corpusCase.id}:observed`, to: `${corpusCase.id}:oracle`, type: "causes" },
	];
	return buildCausalGraph(nodes, edges);
}

// ── Provenance (item 56's custody chain, reused unmodified) ──

export interface CorpusProvenance {
	chain: SignedCustodyChain;
}

/**
 * Chain the corpus's cases (in order) through `exchange/custody.ts`'s
 * existing hash-chain + HMAC signature, one custody record per case, label
 * `"<category>:<id>"`. A corpus distributed with its provenance can be
 * re-verified with `verifyCorpusProvenance` against the *same* `key` the
 * publisher used -- a different key, or any edit to a case afterward,
 * invalidates the chain or the signature respectively.
 */
export function signCorpus(
	cases: CorpusCase[],
	chainId: string,
	createdAt: string,
	key: string,
): CorpusProvenance {
	const inputs: CustodyInput[] = cases.map((c) => ({
		stage: "evidence",
		label: `${c.category}:${c.id}`,
		content: c,
	}));
	const chain: CustodyChain = buildCustodyChain(chainId, createdAt, inputs);
	return { chain: signCustodyChain(chain, key, "failure-corpus") };
}

export interface CorpusProvenanceVerification {
	valid: boolean;
	problems: string[];
}

/** Verify a corpus's provenance chain + signature against the cases it claims to cover. */
export function verifyCorpusProvenance(
	provenance: CorpusProvenance,
	cases: CorpusCase[],
	key: string,
): CorpusProvenanceVerification {
	const verification = verifyCustodyChain(provenance.chain, key);
	const problems = [...verification.problems];
	if (provenance.chain.records.length !== cases.length) {
		problems.push(
			`chain has ${provenance.chain.records.length} record(s) but ${cases.length} case(s) were supplied`,
		);
	}
	return { valid: verification.ok && provenance.chain.records.length === cases.length, problems };
}

// ── Rendering ──

/** Human-readable summary, following the project's `render<Thing>(x): string[]` convention. */
export function renderCorpusReport(report: CorpusEvalReport): string[] {
	const lines: string[] = [
		`Failure corpus evaluation: ${report.passedCount}/${report.results.length} passed`,
	];
	for (const category of CORPUS_CATEGORIES) {
		const stats = report.byCategory[category];
		if (stats.total === 0) continue;
		lines.push(`  ${category}: ${stats.passed}/${stats.total}`);
	}
	for (const result of report.results) {
		const status = result.passed ? "PASS" : "FAIL";
		lines.push(`    [${status}] ${result.category}/${result.id}: ${result.detail}`);
	}
	if (report.failedIds.length > 0) {
		lines.push(`  Failed: ${report.failedIds.join(", ")}`);
	}
	return lines;
}
