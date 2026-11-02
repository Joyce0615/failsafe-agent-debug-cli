/**
 * Privacy-preserving incident sharing (item 28).
 *
 * `incident-graph.ts` (item 22) builds a cross-agent causal graph. `custody.ts`
 * (item 85) signs an evidence pipeline and lets a holder selectively disclose
 * stages. Neither anonymizes the graph itself before it travels, and nothing
 * accounts for a privacy budget when an evaluator wants AGGREGATE statistics
 * across many shared incidents rather than one. `grep -rn "k-anonymity\|
 * differential.privacy" src/ --include="*.ts"` before this module returned
 * nothing.
 *
 * Three pieces, each reusing an existing module unmodified:
 *
 * 1. **k-anonymity over the incident graph's quasi-identifying field**
 *    (`service`, the field that names which agent/service a node belongs
 *    to). `kAnonymizeNodes` buckets nodes by that field's value; a value held
 *    by fewer than `k` nodes is generalized to a single `"other"` bucket
 *    rather than a per-value bucket (so a lone outlier cannot be re-singled-
 *    out by elimination), and those nodes are marked `suppressed: true`. If
 *    the generalized bucket ITSELF still has fewer than `k` members, that is
 *    reported as a caveat rather than silently claimed as anonymous — a
 *    small corpus can make k-anonymity genuinely unachievable, and saying so
 *    is the honest answer, the same discipline `cohort-analysis.ts`'s
 *    `MIN_CELL_SIZE` and `redaction.ts`'s `UNDETECTABLE_PII` already use.
 * 2. **Selective disclosure over the anonymized graph**, composing
 *    `custody.ts` (item 85) unmodified: `buildIncidentEvidenceChain` builds a
 *    three-stage chain (raw evidence -> k-anonymized redaction -> export),
 *    and `shareIncidentEvidence` signs it and discloses only the export
 *    stage — the raw, pre-anonymization graph is hashed into the chain
 *    (proving it existed and was the genuine input) but never travels.
 * 3. **A differential-privacy epsilon budget for AGGREGATE evaluator
 *    statistics** across many shared incidents — a genuinely different
 *    question from (1)/(2), which protect ONE incident's own disclosure.
 *    `requestEpsilon`/`PrivacyBudget` track cumulative epsilon spend and
 *    refuse a request that would exceed the total, leaving the budget
 *    untouched on refusal (mirrors `experiments.ts`'s `budget_exhausted`
 *    stop condition, same shape, orthogonal currency).
 *    `releaseNoisyRootCauseCounts` adds Laplace noise (the standard
 *    differential-privacy mechanism for a bounded-sensitivity count query) to
 *    root-cause-kind counts aggregated across incidents, and — the whole
 *    point of a budget — refuses the release AND its caller never sees the
 *    true counts when the budget would be exceeded, rather than computing
 *    them first and deciding whether to show them.
 *
 * `laplaceNoise` takes an injected `rand: () => number` (the same seam
 * `random.ts`'s `mulberry32` fills in tests/benchmarks) so every noisy
 * release in this module is reproducible from a seed, not from
 * `Math.random()`.
 */
import type { CausalNode } from "../diagnosis/causal-graph.js";
import type { IncidentGraphResult } from "../diagnosis/incident-graph.js";
import {
	type CustodyInput,
	type SelectiveDisclosure,
	type SignedCustodyChain,
	buildCustodyChain,
	discloseStages,
	signCustodyChain,
} from "./custody.js";

/** Minimum group size a quasi-identifier value must hold to travel unredacted. */
export const DEFAULT_K = 3;

export type AnonymizedNode = CausalNode & { suppressed?: boolean };

export type KAnonymizationResult = {
	nodes: AnonymizedNode[];
	caveats: string[];
};

/**
 * Generalize a quasi-identifying field (e.g. `service`) on `nodes` so that
 * every surviving distinct value is held by at least `k` nodes.
 *
 * Nodes whose own value's group is below `k` are moved into ONE shared
 * `"other"` bucket (not dropped, and not each given their own
 * single-member group) — moving them individually would just rename the
 * re-identification problem.
 */
export function kAnonymizeNodes(
	nodes: CausalNode[],
	k: number,
	field: "service",
): KAnonymizationResult {
	const counts = new Map<string, number>();
	for (const n of nodes) {
		const value = n[field];
		if (value === undefined) continue;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}

	const caveats: string[] = [];
	let generalizedCount = 0;
	const result: AnonymizedNode[] = nodes.map((n) => {
		const value = n[field];
		if (value === undefined) return { ...n };
		const count = counts.get(value) ?? 0;
		if (count >= k) return { ...n };
		generalizedCount++;
		return { ...n, [field]: "other", suppressed: true };
	});

	if (generalizedCount > 0 && generalizedCount < k) {
		caveats.push(
			`k-anonymity (k=${k}) is not achievable for this corpus: ${generalizedCount} node(s) were generalized into a single 'other' bucket, which itself holds fewer than ${k} members`,
		);
	}

	return { nodes: result, caveats };
}

/**
 * Build the custody chain backing a shared incident: the raw graph as
 * `evidence`, the k-anonymized graph as `redaction`, and the SAME
 * k-anonymized graph (never the raw one) as `export`.
 */
export function buildIncidentEvidenceChain(
	chainId: string,
	createdAt: string,
	graph: IncidentGraphResult,
	k: number,
	field: "service",
): { chain: ReturnType<typeof buildCustodyChain>; anonymized: KAnonymizationResult } {
	const anonymized = kAnonymizeNodes(graph.nodes, k, field);
	const inputs: CustodyInput[] = [
		{ stage: "evidence", label: "raw-incident-graph", content: graph },
		{ stage: "redaction", label: "k-anonymize-nodes", content: anonymized },
		{
			stage: "export",
			label: "shared-incident-graph",
			content: { ...graph, nodes: anonymized.nodes },
		},
	];
	return { chain: buildCustodyChain(chainId, createdAt, inputs), anonymized };
}

/**
 * Sign the evidence chain and disclose only the `export` stage — the raw
 * graph and the intermediate redaction step are proven to exist (hashed into
 * the signed chain) but withheld, per `custody.ts`'s own selective
 * disclosure semantics.
 */
export function shareIncidentEvidence(
	chainId: string,
	createdAt: string,
	graph: IncidentGraphResult,
	key: string,
	keyId: string,
	k: number,
	field: "service",
): SelectiveDisclosure {
	const anonymized = kAnonymizeNodes(graph.nodes, k, field);
	const inputs: CustodyInput[] = [
		{ stage: "evidence", label: "raw-incident-graph", content: graph },
		{ stage: "redaction", label: "k-anonymize-nodes", content: anonymized },
		{
			stage: "export",
			label: "shared-incident-graph",
			content: { ...graph, nodes: anonymized.nodes },
		},
	];
	const chain = buildCustodyChain(chainId, createdAt, inputs);
	const signed: SignedCustodyChain = signCustodyChain(chain, key, keyId);
	return discloseStages(
		signed,
		inputs.map((i) => i.content),
		[2],
	);
}

// ── Differential-privacy budget for aggregate evaluator statistics ──

export type PrivacyBudget = {
	epsilon_total: number;
	epsilon_spent: number;
};

export type EpsilonRequestResult =
	| { ok: true; budget: PrivacyBudget }
	| { ok: false; budget: PrivacyBudget; message: string };

/**
 * Reserve `epsilon` from a budget. Refused, with the budget UNCHANGED, when
 * the remaining allowance is insufficient — the budget is the hard
 * constraint, not a number a caller can quietly overdraw.
 */
export function requestEpsilon(budget: PrivacyBudget, epsilon: number): EpsilonRequestResult {
	const remaining = budget.epsilon_total - budget.epsilon_spent;
	if (epsilon > remaining) {
		return {
			ok: false,
			budget,
			message: `requested epsilon ${epsilon} exceeds remaining privacy budget ${remaining} (total ${budget.epsilon_total}, already spent ${budget.epsilon_spent})`,
		};
	}
	return { ok: true, budget: { ...budget, epsilon_spent: budget.epsilon_spent + epsilon } };
}

/**
 * Laplace-distributed noise via inverse-CDF sampling from an injected
 * `rand() -> [0, 1)`, so every noisy release is reproducible from a seed.
 * `scale = sensitivity / epsilon` is the caller's responsibility; this
 * function only draws the noise.
 */
export function laplaceNoise(rand: () => number, scale: number): number {
	if (scale === 0) return 0;
	// u in (-0.5, 0.5), avoiding the exact 0 that would make log(0) = -Infinity.
	const u = rand() - 0.5;
	const sign = u < 0 ? -1 : 1;
	const magnitude = Math.abs(u);
	if (magnitude === 0) return 0;
	return -scale * sign * Math.log(1 - 2 * magnitude);
}

/** Aggregate true (unnoised) root-cause-kind counts across several incident graphs. */
export function aggregateRootCauseCounts(
	graphs: IncidentGraphResult[],
): Record<CausalNode["kind"], number> {
	const counts: Record<CausalNode["kind"], number> = { agent: 0, tool: 0, service: 0, retry: 0 };
	for (const graph of graphs) {
		for (const root of graph.root_causes) {
			counts[root.kind]++;
		}
	}
	return counts;
}

export type NoisyRootCauseCountsResult =
	| { ok: true; noisy_counts: Record<CausalNode["kind"], number>; budget: PrivacyBudget }
	| { ok: false; budget: PrivacyBudget; message: string };

/**
 * Release root-cause-kind counts aggregated across `graphs`, with Laplace
 * noise added at `scale = 1 / epsilon` (sensitivity 1: one incident's
 * root-cause kind changes a count by at most 1), gated by `budget`.
 *
 * On refusal, the TRUE counts are never computed into the returned value —
 * the caller gets a refusal message and the unchanged budget, nothing else.
 */
export function releaseNoisyRootCauseCounts(
	graphs: IncidentGraphResult[],
	epsilon: number,
	budget: PrivacyBudget,
	rand: () => number,
): NoisyRootCauseCountsResult {
	const spend = requestEpsilon(budget, epsilon);
	if (!spend.ok) {
		return { ok: false, budget: spend.budget, message: spend.message };
	}
	const trueCounts = aggregateRootCauseCounts(graphs);
	const scale = 1 / epsilon;
	const noisyCounts = Object.fromEntries(
		Object.entries(trueCounts).map(([kind, count]) => [kind, count + laplaceNoise(rand, scale)]),
	) as Record<CausalNode["kind"], number>;
	return { ok: true, noisy_counts: noisyCounts, budget: spend.budget };
}
