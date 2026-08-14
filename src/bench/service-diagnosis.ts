/**
 * Multi-artifact service-diagnosis benchmark adapter (item 44).
 *
 * The existing matrix (item 39) scores one bit per instance: did the patch make
 * the tests pass. That is the wrong instrument for diagnosing a running service,
 * where the evidence is spread across logs, traces, metrics, configuration, and
 * source, and where "named the right service" and "named the right cause" and
 * "could show why" are three different capabilities that fail independently.
 *
 * This module scores five dimensions **separately** and deliberately never
 * combines them into a single number:
 *
 * 1. **Component localization** — top-1, top-k, and reciprocal rank over a
 *    ranked list of services.
 * 2. **Cause class** — did it name the right *kind* of fault, scored
 *    independently of whether it localized correctly (a correct cause on the
 *    wrong component is a real, distinguishable failure mode).
 * 3. **Explanation evidence** — precision/recall of the artifacts actually
 *    cited, broken down per artifact kind, plus a count of citations to
 *    evidence that does not exist.
 * 4. **Latency** — wall time against a per-case budget.
 * 5. **Cost** — tokens against a per-case budget.
 *
 * A weighted composite would let a system trade evidence quality for latency
 * and still look good; keeping the axes apart is what makes the report
 * diagnostic rather than promotional. `aggregate` therefore returns a report
 * with five independent sections and no overall score.
 *
 * Pure: no network, no dataset download. As with item 39, a user exports rows
 * however they obtain them and the adapter maps them into the canonical shape,
 * so benchmark payloads never enter the repo or a release tar.
 */
import { z } from "zod";

/** The evidence surfaces a service diagnosis can draw on. */
export const ARTIFACT_KINDS = ["logs", "traces", "metrics", "configuration", "source"] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const SERVICE_BENCH_VERSION = "0.1";

export const EvidenceRefSchema = z.object({
	artifact: ArtifactKindSchema,
	/** Stable identifier within that artifact: log line id, span id, metric series, config key, `file:line`. */
	id: z.string().min(1),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ServiceCaseSchema = z.object({
	case_id: z.string().min(1),
	/** Every component the system under test contains, including healthy ones. */
	components: z.array(z.string().min(1)).min(1),
	/** Artifact kinds actually supplied for this case. */
	available_artifacts: z.array(ArtifactKindSchema).min(1),
	ground_truth: z.object({
		/** The component at fault. */
		component: z.string().min(1),
		/** The fault's class, e.g. `config_drift`, `resource_exhaustion`, `bad_deploy`. */
		cause_class: z.string().min(1),
		/**
		 * Evidence a correct explanation must cite. Sufficiency, not sufficiency
		 * plus flourish: extra citations cost precision, missing ones cost recall.
		 */
		required_evidence: z.array(EvidenceRefSchema).default([]),
	}),
	budget: z
		.object({
			max_latency_ms: z.number().positive().default(60_000),
			max_tokens: z.number().int().positive().default(20_000),
		})
		.default({}),
});
export type ServiceCase = z.infer<typeof ServiceCaseSchema>;

export const ServicePredictionSchema = z.object({
	case_id: z.string().min(1),
	/** Components ranked best-first. An empty list is a valid abstention. */
	ranked_components: z.array(z.string()).default([]),
	cause_class: z.string().optional(),
	cited_evidence: z.array(EvidenceRefSchema).default([]),
	latency_ms: z.number().nonnegative().default(0),
	tokens: z.number().int().nonnegative().default(0),
});
export type ServicePrediction = z.infer<typeof ServicePredictionSchema>;

export const ServiceSuiteSchema = z.object({
	schema_version: z.literal(SERVICE_BENCH_VERSION),
	dataset_version: z.string().min(1),
	created_at: z.string(),
	cases: z.array(ServiceCaseSchema),
});
export type ServiceSuite = z.infer<typeof ServiceSuiteSchema>;

/** Default k for top-k localization. */
export const DEFAULT_TOP_K = 3;

export type LocalizationScore = {
	top1: boolean;
	topk: boolean;
	k: number;
	/** 1/rank of the correct component, or 0 if unranked. */
	reciprocal_rank: number;
	/** True when the system declined to rank anything. */
	abstained: boolean;
};

export type CauseClassScore = {
	correct: boolean;
	predicted?: string;
	expected: string;
	abstained: boolean;
};

export type EvidenceScore = {
	precision: number;
	recall: number;
	f1: number;
	cited: number;
	required: number;
	matched: number;
	/**
	 * Citations naming an artifact kind this case does not supply. These are
	 * counted separately from ordinary precision loss because they are not a
	 * wrong answer — they are a fabricated one.
	 */
	unavailable_artifact_citations: number;
	by_artifact: Record<string, { required: number; matched: number; recall: number }>;
};

export type BudgetScore = {
	value: number;
	budget: number;
	within_budget: boolean;
	/** Fraction of the budget consumed; >1 means overrun. */
	utilization: number;
};

export type ServiceScore = {
	case_id: string;
	available_artifacts: ArtifactKind[];
	localization: LocalizationScore;
	cause_class: CauseClassScore;
	evidence: EvidenceScore;
	latency: BudgetScore;
	cost: BudgetScore;
};

function refKey(ref: EvidenceRef): string {
	return `${ref.artifact}::${ref.id}`;
}

function budgetScore(value: number, budget: number): BudgetScore {
	return {
		value,
		budget,
		within_budget: value <= budget,
		utilization: budget > 0 ? value / budget : Number.POSITIVE_INFINITY,
	};
}

/**
 * Score one case against one prediction.
 *
 * Every dimension is computed independently — in particular, cause class and
 * evidence are scored even when localization is wrong, because "found the right
 * cause on the wrong service" and "found the right service for the wrong
 * reason" are different problems and averaging them away hides both.
 */
export function scoreCase(
	testCase: ServiceCase,
	prediction: ServicePrediction,
	opts: { k?: number } = {},
): ServiceScore {
	const k = opts.k ?? DEFAULT_TOP_K;
	const truth = testCase.ground_truth;

	const rank = prediction.ranked_components.indexOf(truth.component);
	const localization: LocalizationScore = {
		top1: rank === 0,
		topk: rank >= 0 && rank < k,
		k,
		reciprocal_rank: rank >= 0 ? 1 / (rank + 1) : 0,
		abstained: prediction.ranked_components.length === 0,
	};

	const causeClass: CauseClassScore = {
		correct: prediction.cause_class === truth.cause_class,
		...(prediction.cause_class ? { predicted: prediction.cause_class } : {}),
		expected: truth.cause_class,
		abstained: prediction.cause_class === undefined,
	};

	const available = new Set<string>(testCase.available_artifacts);
	const required = new Map(truth.required_evidence.map((r) => [refKey(r), r]));
	// De-duplicate citations: repeating one piece of evidence is not extra
	// support, and letting it inflate precision would reward padding.
	const cited = new Map(prediction.cited_evidence.map((r) => [refKey(r), r]));

	let matched = 0;
	for (const key of cited.keys()) {
		if (required.has(key)) matched++;
	}
	let unavailable = 0;
	for (const ref of cited.values()) {
		if (!available.has(ref.artifact)) unavailable++;
	}

	const byArtifact: EvidenceScore["by_artifact"] = {};
	for (const kind of ARTIFACT_KINDS) {
		const req = [...required.values()].filter((r) => r.artifact === kind);
		if (req.length === 0) continue;
		const hit = req.filter((r) => cited.has(refKey(r))).length;
		byArtifact[kind] = { required: req.length, matched: hit, recall: hit / req.length };
	}

	const precision = cited.size > 0 ? matched / cited.size : 0;
	const recall = required.size > 0 ? matched / required.size : 1;
	const evidence: EvidenceScore = {
		precision,
		recall,
		f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
		cited: cited.size,
		required: required.size,
		matched,
		unavailable_artifact_citations: unavailable,
		by_artifact: byArtifact,
	};

	return {
		case_id: testCase.case_id,
		available_artifacts: testCase.available_artifacts,
		localization,
		cause_class: causeClass,
		evidence,
		latency: budgetScore(prediction.latency_ms, testCase.budget.max_latency_ms),
		cost: budgetScore(prediction.tokens, testCase.budget.max_tokens),
	};
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Median is reported alongside the mean because latency distributions are skewed. */
function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type ServiceDiagnosisReport = {
	schema_version: typeof SERVICE_BENCH_VERSION;
	cases: number;
	localization: {
		top1_accuracy: number;
		topk_accuracy: number;
		k: number;
		mean_reciprocal_rank: number;
		abstention_rate: number;
	};
	cause_class: { accuracy: number; abstention_rate: number };
	evidence: {
		mean_precision: number;
		mean_recall: number;
		mean_f1: number;
		/** Recall per artifact kind, over the cases that required that kind. */
		recall_by_artifact: Record<string, { cases: number; recall: number }>;
		/** Total citations naming an artifact the case never supplied. */
		unavailable_artifact_citations: number;
	};
	latency: { mean_ms: number; median_ms: number; within_budget_rate: number };
	cost: { mean_tokens: number; total_tokens: number; within_budget_rate: number };
	/**
	 * Per-artifact-availability slices: how the system does when a given
	 * evidence surface is present. This is where a system that only really
	 * reads logs becomes visible.
	 */
	slices: Array<{
		artifact: ArtifactKind;
		cases: number;
		top1_accuracy: number;
		cause_class_accuracy: number;
		mean_evidence_recall: number;
	}>;
};

/**
 * Aggregate per-case scores into a report.
 *
 * Returns five independent sections and no overall score, by design: see the
 * module header.
 */
export function aggregate(
	scores: ServiceScore[],
	opts: { k?: number } = {},
): ServiceDiagnosisReport {
	const k = opts.k ?? scores[0]?.localization.k ?? DEFAULT_TOP_K;
	const recallByArtifact: Record<string, { cases: number; recall: number }> = {};
	for (const kind of ARTIFACT_KINDS) {
		const relevant = scores.filter((s) => s.evidence.by_artifact[kind] !== undefined);
		if (relevant.length === 0) continue;
		recallByArtifact[kind] = {
			cases: relevant.length,
			recall: mean(relevant.map((s) => s.evidence.by_artifact[kind].recall)),
		};
	}

	const slices = ARTIFACT_KINDS.map((artifact) => {
		const subset = scores.filter((s) => s.available_artifacts.includes(artifact));
		return {
			artifact,
			cases: subset.length,
			top1_accuracy: mean(subset.map((s) => (s.localization.top1 ? 1 : 0))),
			cause_class_accuracy: mean(subset.map((s) => (s.cause_class.correct ? 1 : 0))),
			mean_evidence_recall: mean(subset.map((s) => s.evidence.recall)),
		};
	}).filter((s) => s.cases > 0);

	return {
		schema_version: SERVICE_BENCH_VERSION,
		cases: scores.length,
		localization: {
			top1_accuracy: mean(scores.map((s) => (s.localization.top1 ? 1 : 0))),
			topk_accuracy: mean(scores.map((s) => (s.localization.topk ? 1 : 0))),
			k,
			mean_reciprocal_rank: mean(scores.map((s) => s.localization.reciprocal_rank)),
			abstention_rate: mean(scores.map((s) => (s.localization.abstained ? 1 : 0))),
		},
		cause_class: {
			accuracy: mean(scores.map((s) => (s.cause_class.correct ? 1 : 0))),
			abstention_rate: mean(scores.map((s) => (s.cause_class.abstained ? 1 : 0))),
		},
		evidence: {
			mean_precision: mean(scores.map((s) => s.evidence.precision)),
			mean_recall: mean(scores.map((s) => s.evidence.recall)),
			mean_f1: mean(scores.map((s) => s.evidence.f1)),
			recall_by_artifact: recallByArtifact,
			unavailable_artifact_citations: scores.reduce(
				(a, s) => a + s.evidence.unavailable_artifact_citations,
				0,
			),
		},
		latency: {
			mean_ms: mean(scores.map((s) => s.latency.value)),
			median_ms: median(scores.map((s) => s.latency.value)),
			within_budget_rate: mean(scores.map((s) => (s.latency.within_budget ? 1 : 0))),
		},
		cost: {
			mean_tokens: mean(scores.map((s) => s.cost.value)),
			total_tokens: scores.reduce((a, s) => a + s.cost.value, 0),
			within_budget_rate: mean(scores.map((s) => (s.cost.within_budget ? 1 : 0))),
		},
		slices,
	};
}

export type SuiteIssue = { case_id: string; problem: string };

/**
 * Reject suites that cannot produce meaningful scores.
 *
 * The important check is the third: a case whose ground-truth evidence lives in
 * an artifact the case does not supply is unanswerable, and scoring against it
 * measures nothing but luck.
 */
export function validateSuite(suite: ServiceSuite): SuiteIssue[] {
	const issues: SuiteIssue[] = [];
	const seen = new Set<string>();
	for (const c of suite.cases) {
		if (seen.has(c.case_id)) {
			issues.push({ case_id: c.case_id, problem: "duplicate case_id" });
		}
		seen.add(c.case_id);

		if (!c.components.includes(c.ground_truth.component)) {
			issues.push({
				case_id: c.case_id,
				problem: `ground-truth component '${c.ground_truth.component}' is not among the case's components`,
			});
		}

		const available = new Set<string>(c.available_artifacts);
		for (const ref of c.ground_truth.required_evidence) {
			if (!available.has(ref.artifact)) {
				issues.push({
					case_id: c.case_id,
					problem: `required evidence cites '${ref.artifact}', which the case does not supply`,
				});
			}
		}

		if (c.ground_truth.required_evidence.length === 0) {
			issues.push({
				case_id: c.case_id,
				problem: "no required evidence: explanation quality cannot be scored",
			});
		}
	}
	return issues;
}

type Row = Record<string, unknown>;

function str(row: Row, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function strArray(row: Row, ...keys: string[]): string[] {
	for (const key of keys) {
		const value = row[key];
		if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	}
	return [];
}

/**
 * Normalize exported service-incident rows into a canonical suite.
 *
 * Accepts the shapes these corpora tend to use: a fault/root-cause service
 * field, a failure-type field, and evidence either as `{artifact, id}` objects
 * or as `"artifact:id"` strings. Rows that cannot be normalized are skipped
 * rather than guessed at — a fabricated case is worse than a smaller suite.
 */
export function fromServiceRows(rows: Row[], datasetVersion: string): ServiceSuite {
	const cases: ServiceCase[] = [];
	for (const row of rows) {
		const component = str(row, "root_cause_service", "faulty_component", "component");
		const causeClass = str(row, "cause_class", "failure_type", "anomaly_type");
		if (!component || !causeClass) continue;

		const components = strArray(row, "components", "services");
		const evidenceRaw = Array.isArray(row.required_evidence) ? row.required_evidence : [];
		const requiredEvidence: EvidenceRef[] = [];
		for (const entry of evidenceRaw) {
			if (typeof entry === "string") {
				const idx = entry.indexOf(":");
				if (idx <= 0) continue;
				const artifact = entry.slice(0, idx);
				if ((ARTIFACT_KINDS as readonly string[]).includes(artifact)) {
					requiredEvidence.push({ artifact: artifact as ArtifactKind, id: entry.slice(idx + 1) });
				}
			} else if (entry && typeof entry === "object") {
				const parsed = EvidenceRefSchema.safeParse(entry);
				if (parsed.success) requiredEvidence.push(parsed.data);
			}
		}

		const declared = strArray(row, "available_artifacts", "artifacts");
		const available = (
			declared.length > 0
				? declared.filter((a): a is ArtifactKind =>
						(ARTIFACT_KINDS as readonly string[]).includes(a),
					)
				: [...new Set(requiredEvidence.map((r) => r.artifact))]
		) as ArtifactKind[];
		if (available.length === 0) continue;

		const parsed = ServiceCaseSchema.safeParse({
			case_id: str(row, "case_id", "incident_id", "id") ?? "",
			components: components.includes(component) ? components : [...components, component],
			available_artifacts: available,
			ground_truth: {
				component,
				cause_class: causeClass,
				required_evidence: requiredEvidence,
			},
			...(row.budget ? { budget: row.budget } : {}),
		});
		if (parsed.success) cases.push(parsed.data);
	}

	return ServiceSuiteSchema.parse({
		schema_version: SERVICE_BENCH_VERSION,
		dataset_version: datasetVersion,
		created_at: new Date().toISOString(),
		cases,
	});
}

/**
 * Score a whole suite. Predictions are matched to cases by `case_id`; a case
 * with no prediction is scored as a full abstention rather than skipped, so a
 * system cannot improve its numbers by declining to answer.
 */
export function scoreSuite(
	suite: ServiceSuite,
	predictions: ServicePrediction[],
	opts: { k?: number } = {},
): ServiceScore[] {
	const byId = new Map(predictions.map((p) => [p.case_id, p]));
	return suite.cases.map((c) =>
		scoreCase(
			c,
			byId.get(c.case_id) ?? ServicePredictionSchema.parse({ case_id: c.case_id }),
			opts,
		),
	);
}
