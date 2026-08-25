/**
 * Hardware / RTL cross-artifact debugging tasks (item 54).
 *
 * HWE-Bench-style hardware issues expose three gaps that software benchmarks do
 * not, and this adapter scores them separately because they fail independently:
 *
 * 1. **Localization** — which module, file, and line. Same shape as software,
 *    with one difference that matters: hardware localization is *hierarchical
 *    by instance path* (`tb.dut.alu.adder`), not by call stack, so a "close"
 *    answer is one that names an ancestor. `pathDistance` measures that instead
 *    of scoring an ancestor as a plain miss.
 *
 * 2. **Hardware semantics** — the bug class, from a closed vocabulary of things
 *    that only exist in hardware (clock-domain crossing, reset polarity, width
 *    truncation, blocking-vs-non-blocking assignment). Each class carries a
 *    `software_analogue` — the wrong answer a competent software reasoner
 *    reaches by pattern-matching the syntax. Accuracy is reported separately on
 *    the cases where that trap exists, because an aggregate that mixes them
 *    hides the entire phenomenon the axis exists to measure.
 *
 * 3. **Coordination** — hardware fixes routinely span artifacts: the RTL *and*
 *    the timing constraint, the parameter package *and* the testbench that
 *    hard-codes the old width. `scoreCoordination` reports whether every
 *    required artifact kind was touched, counts spurious edits separately, and
 *    the report slices single-artifact against multi-artifact cases — which is
 *    where a system that "works" on RTL-only fixes is revealed.
 *
 * Deliberately no composite score, consistent with items 44/48/50/51/53.
 *
 * Pure: no network, no dataset in the repo, no simulator invocation. A user
 * exports rows however they obtain them and `fromHardwareRows` normalizes them.
 */
import { z } from "zod";

export const HW_BENCH_VERSION = "0.1";

/** Artifact kinds a hardware fix can span. */
export const HW_ARTIFACTS = [
	"rtl",
	"testbench",
	"constraint",
	"config",
	"waveform",
	"spec",
] as const;
export const HwArtifactSchema = z.enum(HW_ARTIFACTS);
export type HwArtifact = z.infer<typeof HwArtifactSchema>;

/**
 * Hardware bug classes and the software misreading each one invites.
 *
 * The `software_analogue` field is the point of this table. A reasoner trained
 * on software sees `<=` and thinks comparison; sees two processes touching one
 * signal and thinks data race; sees a truncating assignment and thinks implicit
 * cast. Each of those is a specific, predictable, wrong answer, and a benchmark
 * that does not separate the trapped cases from the untrapped ones cannot tell
 * a system that understands hardware from one that got an easy split.
 */
export const HW_BUG_CLASSES = {
	clock_domain_crossing: "data_race",
	reset_polarity: "boolean_inversion",
	width_truncation: "implicit_cast",
	blocking_assignment: "statement_ordering",
	combinational_loop: "infinite_recursion",
	fsm_deadlock: "unreachable_state",
	timing_violation: "performance_regression",
	sign_extension: "integer_overflow",
	bit_order: "endianness",
	latch_inference: "uninitialized_variable",
} as const;

export type HwBugClass = keyof typeof HW_BUG_CLASSES;
export const HW_BUG_CLASS_NAMES = Object.keys(HW_BUG_CLASSES) as HwBugClass[];
export const HwBugClassSchema = z.enum(HW_BUG_CLASS_NAMES as [HwBugClass, ...HwBugClass[]]);

/** The software misreading a given hardware class invites. */
export function softwareAnalogue(bugClass: HwBugClass): string {
	return HW_BUG_CLASSES[bugClass];
}

export const HwCaseSchema = z.object({
	case_id: z.string().min(1),
	/** Artifact kinds supplied to the system for this case. */
	available_artifacts: z.array(HwArtifactSchema).min(1),
	/** Every instance path a prediction may name, e.g. `tb.dut.alu.adder`. */
	candidate_paths: z.array(z.string().min(1)).min(1),
	ground_truth: z.object({
		/** Hierarchical instance path of the faulty module. */
		instance_path: z.string().min(1),
		file: z.string().min(1),
		line: z.number().int().positive().optional(),
		bug_class: HwBugClassSchema,
		/**
		 * Whether this case's *syntax* actually invites the software misreading
		 * for its class. Not every CDC bug looks like a data race in the source;
		 * the ones that do are the hard set, and labelling them per-case (rather
		 * than assuming every case of a class is trapped) is what makes the
		 * trapped/untrapped accuracy split mean something.
		 */
		software_analogue_trap: z.boolean().default(false),
		/** Artifact kinds the fix must touch. Order is irrelevant. */
		required_artifacts: z.array(HwArtifactSchema).min(1),
	}),
});
export type HwCase = z.infer<typeof HwCaseSchema>;

export const HwPredictionSchema = z.object({
	case_id: z.string().min(1),
	/** Instance paths ranked best-first. Empty is a valid abstention. */
	ranked_paths: z.array(z.string()).default([]),
	predicted_file: z.string().optional(),
	predicted_line: z.number().int().positive().optional(),
	bug_class: z.string().optional(),
	/** Artifact kinds the proposed fix actually edits. */
	edited_artifacts: z.array(HwArtifactSchema).default([]),
});
export type HwPrediction = z.infer<typeof HwPredictionSchema>;

export const HwSuiteSchema = z.object({
	schema_version: z.literal(HW_BENCH_VERSION),
	dataset_version: z.string().min(1),
	created_at: z.string(),
	cases: z.array(HwCaseSchema),
});
export type HwSuite = z.infer<typeof HwSuiteSchema>;

/**
 * Distance between two instance paths, in hierarchy levels.
 *
 * `0` is exact. A positive number means `predicted` is an ancestor of `truth`
 * (too coarse — named the subsystem, not the module). A negative number means
 * it is a descendant (too specific). `null` means the paths diverge, which is a
 * plain miss. Distinguishing "named the parent" from "named an unrelated
 * module" is the whole reason this is not a boolean.
 */
export function pathDistance(predicted: string, truth: string): number | null {
	if (predicted === truth) return 0;
	const p = predicted.split(".");
	const t = truth.split(".");
	const shorter = Math.min(p.length, t.length);
	for (let i = 0; i < shorter; i++) {
		if (p[i] !== t[i]) return null;
	}
	return t.length - p.length;
}

export type HwLocalizationScore = {
	exact: boolean;
	/** Correct at rank 1 after allowing ancestors within `ancestorTolerance`. */
	hierarchical: boolean;
	rank: number | null;
	reciprocal_rank: number;
	/** Distance of the top-ranked path from the truth, or `null` if divergent. */
	top_distance: number | null;
	file_correct: boolean;
	line_correct: boolean;
	abstained: boolean;
};

export type HwSemanticScore = {
	correct: boolean;
	predicted?: string;
	expected: HwBugClass;
	abstained: boolean;
	/**
	 * True when the prediction is exactly the software misreading this class
	 * invites. This is not merely "wrong" — it is the specific, diagnosable
	 * wrong answer, and counting it is how the hardware-semantic gap is
	 * measured rather than asserted.
	 */
	fell_for_software_analogue: boolean;
};

export type HwCoordinationScore = {
	required: HwArtifact[];
	edited: HwArtifact[];
	/** Every required artifact kind was touched. */
	complete: boolean;
	missing: HwArtifact[];
	/** Artifacts edited that the fix did not require. */
	spurious: HwArtifact[];
	/** Edits naming an artifact the case never supplied. */
	unavailable: HwArtifact[];
	/** True when the case needs more than one artifact kind changed. */
	multi_artifact: boolean;
};

export type HwScore = {
	case_id: string;
	available_artifacts: HwArtifact[];
	/** Copied from ground truth so the report can slice without the suite. */
	software_analogue_trap: boolean;
	localization: HwLocalizationScore;
	semantics: HwSemanticScore;
	coordination: HwCoordinationScore;
};

/** How many levels of over-generality still count as a hierarchical hit. */
export const DEFAULT_ANCESTOR_TOLERANCE = 1;

export function scoreHwCase(
	testCase: HwCase,
	prediction: HwPrediction,
	opts: { ancestor_tolerance?: number } = {},
): HwScore {
	const tolerance = opts.ancestor_tolerance ?? DEFAULT_ANCESTOR_TOLERANCE;
	const truth = testCase.ground_truth;

	const rank = prediction.ranked_paths.indexOf(truth.instance_path);
	const top = prediction.ranked_paths[0];
	const topDistance = top === undefined ? null : pathDistance(top, truth.instance_path);

	const localization: HwLocalizationScore = {
		exact: rank === 0,
		hierarchical: topDistance !== null && topDistance >= 0 && topDistance <= tolerance,
		rank: rank >= 0 ? rank : null,
		reciprocal_rank: rank >= 0 ? 1 / (rank + 1) : 0,
		top_distance: topDistance,
		file_correct: prediction.predicted_file === truth.file,
		line_correct:
			truth.line !== undefined &&
			prediction.predicted_line !== undefined &&
			prediction.predicted_line === truth.line,
		abstained: prediction.ranked_paths.length === 0,
	};

	const analogue = softwareAnalogue(truth.bug_class);
	const semantics: HwSemanticScore = {
		correct: prediction.bug_class === truth.bug_class,
		...(prediction.bug_class ? { predicted: prediction.bug_class } : {}),
		expected: truth.bug_class,
		abstained: prediction.bug_class === undefined,
		fell_for_software_analogue: prediction.bug_class === analogue,
	};

	const required = [...new Set(truth.required_artifacts)];
	const edited = [...new Set(prediction.edited_artifacts)];
	const available = new Set<string>(testCase.available_artifacts);
	const coordination: HwCoordinationScore = {
		required,
		edited,
		complete: required.every((a) => edited.includes(a)),
		missing: required.filter((a) => !edited.includes(a)),
		spurious: edited.filter((a) => !required.includes(a)),
		unavailable: edited.filter((a) => !available.has(a)),
		multi_artifact: required.length > 1,
	};

	return {
		case_id: testCase.case_id,
		available_artifacts: testCase.available_artifacts,
		software_analogue_trap: truth.software_analogue_trap,
		localization,
		semantics,
		coordination,
	};
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function rate(scores: HwScore[], pick: (s: HwScore) => boolean): number {
	return mean(scores.map((s) => (pick(s) ? 1 : 0)));
}

export type HwReport = {
	schema_version: typeof HW_BENCH_VERSION;
	cases: number;
	localization: {
		exact_accuracy: number;
		hierarchical_accuracy: number;
		mean_reciprocal_rank: number;
		file_accuracy: number;
		line_accuracy: number;
		abstention_rate: number;
		/** How often the top answer was an ancestor rather than a miss. */
		too_coarse_rate: number;
		too_specific_rate: number;
	};
	semantics: {
		accuracy: number;
		abstention_rate: number;
		software_analogue_rate: number;
		/** Accuracy split by whether the case's syntax invites the misreading. */
		by_trap: Array<{
			trapped: boolean;
			cases: number;
			accuracy: number;
			software_analogue_rate: number;
		}>;
	};
	coordination: {
		completion_rate: number;
		mean_missing: number;
		mean_spurious: number;
		unavailable_edits: number;
		/** The slice that matters: does completion collapse when >1 artifact is needed? */
		by_span: Array<{
			span: "single_artifact" | "multi_artifact";
			cases: number;
			completion_rate: number;
		}>;
	};
	/** Per-artifact-availability slices. */
	slices: Array<{ artifact: HwArtifact; cases: number; exact_accuracy: number }>;
};

export function aggregateHardware(scores: HwScore[]): HwReport {
	// The split that matters: on cases whose syntax invites the software
	// misreading, does accuracy collapse? An aggregate that mixes trapped and
	// untrapped cases hides the entire phenomenon this axis exists to measure.
	const trapSlices = [true, false]
		.map((trapped) => {
			const subset = scores.filter((s) => s.software_analogue_trap === trapped);
			return {
				trapped,
				cases: subset.length,
				accuracy: rate(subset, (s) => s.semantics.correct),
				software_analogue_rate: rate(subset, (s) => s.semantics.fell_for_software_analogue),
			};
		})
		.filter((s) => s.cases > 0);

	return {
		schema_version: HW_BENCH_VERSION,
		cases: scores.length,
		localization: {
			exact_accuracy: rate(scores, (s) => s.localization.exact),
			hierarchical_accuracy: rate(scores, (s) => s.localization.hierarchical),
			mean_reciprocal_rank: mean(scores.map((s) => s.localization.reciprocal_rank)),
			file_accuracy: rate(scores, (s) => s.localization.file_correct),
			line_accuracy: rate(scores, (s) => s.localization.line_correct),
			abstention_rate: rate(scores, (s) => s.localization.abstained),
			too_coarse_rate: rate(
				scores,
				(s) => s.localization.top_distance !== null && s.localization.top_distance > 0,
			),
			too_specific_rate: rate(
				scores,
				(s) => s.localization.top_distance !== null && s.localization.top_distance < 0,
			),
		},
		semantics: {
			accuracy: rate(scores, (s) => s.semantics.correct),
			abstention_rate: rate(scores, (s) => s.semantics.abstained),
			software_analogue_rate: rate(scores, (s) => s.semantics.fell_for_software_analogue),
			by_trap: trapSlices,
		},
		coordination: {
			completion_rate: rate(scores, (s) => s.coordination.complete),
			mean_missing: mean(scores.map((s) => s.coordination.missing.length)),
			mean_spurious: mean(scores.map((s) => s.coordination.spurious.length)),
			unavailable_edits: scores.reduce((a, s) => a + s.coordination.unavailable.length, 0),
			by_span: (["single_artifact", "multi_artifact"] as const)
				.map((span) => {
					const subset = scores.filter(
						(s) => s.coordination.multi_artifact === (span === "multi_artifact"),
					);
					return {
						span,
						cases: subset.length,
						completion_rate: rate(subset, (s) => s.coordination.complete),
					};
				})
				.filter((s) => s.cases > 0),
		},
		slices: HW_ARTIFACTS.map((artifact) => {
			const subset = scores.filter((s) => s.available_artifacts.includes(artifact));
			return {
				artifact,
				cases: subset.length,
				exact_accuracy: rate(subset, (s) => s.localization.exact),
			};
		}).filter((s) => s.cases > 0),
	};
}

export type HwSuiteIssue = { case_id: string; problem: string };

export function validateHwSuite(suite: HwSuite): HwSuiteIssue[] {
	const issues: HwSuiteIssue[] = [];
	const seen = new Set<string>();
	for (const c of suite.cases) {
		if (seen.has(c.case_id)) issues.push({ case_id: c.case_id, problem: "duplicate case_id" });
		seen.add(c.case_id);

		if (!c.candidate_paths.includes(c.ground_truth.instance_path)) {
			issues.push({
				case_id: c.case_id,
				problem: `ground-truth instance path '${c.ground_truth.instance_path}' is not among candidate_paths`,
			});
		}

		const available = new Set<string>(c.available_artifacts);
		for (const artifact of c.ground_truth.required_artifacts) {
			if (!available.has(artifact)) {
				issues.push({
					case_id: c.case_id,
					problem: `fix requires '${artifact}', which the case does not supply`,
				});
			}
		}

		if (!available.has("rtl")) {
			issues.push({
				case_id: c.case_id,
				problem: "no RTL supplied: hardware localization is unanswerable",
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
 * Normalize exported hardware-issue rows.
 *
 * A row whose bug class is not in the closed vocabulary is skipped rather than
 * mapped to a nearest neighbour: the whole value of the semantics axis is that
 * the classes mean something specific, and silently coercing an unknown label
 * into `width_truncation` would put noise into exactly the measurement the
 * module exists to make.
 */
export function fromHardwareRows(rows: Row[], datasetVersion: string): HwSuite {
	const cases: HwCase[] = [];
	for (const row of rows) {
		const bugClass = str(row, "bug_class", "defect_class", "category");
		if (!bugClass || !(HW_BUG_CLASS_NAMES as string[]).includes(bugClass)) continue;

		const instancePath = str(row, "instance_path", "hierarchy", "module_path");
		const file = str(row, "file", "rtl_file", "path");
		if (!instancePath || !file) continue;

		const required = strArray(row, "required_artifacts", "fix_artifacts").filter(
			(a): a is HwArtifact => (HW_ARTIFACTS as readonly string[]).includes(a),
		);
		const declared = strArray(row, "available_artifacts", "artifacts").filter(
			(a): a is HwArtifact => (HW_ARTIFACTS as readonly string[]).includes(a),
		);
		const available = [...new Set<HwArtifact>(["rtl", ...declared, ...required])];

		const candidates = strArray(row, "candidate_paths", "modules");
		const line = typeof row.line === "number" && row.line > 0 ? row.line : undefined;

		const parsed = HwCaseSchema.safeParse({
			case_id: str(row, "case_id", "issue_id", "id") ?? "",
			available_artifacts: available,
			candidate_paths: candidates.includes(instancePath)
				? candidates
				: [...candidates, instancePath],
			ground_truth: {
				instance_path: instancePath,
				file,
				...(line ? { line } : {}),
				bug_class: bugClass,
				// Absent means untrapped: claiming a case is hard without evidence
				// would inflate the trapped-slice denominator with easy cases.
				software_analogue_trap: row.software_analogue_trap === true,
				required_artifacts: required.length > 0 ? required : ["rtl"],
			},
		});
		if (parsed.success) cases.push(parsed.data);
	}

	return HwSuiteSchema.parse({
		schema_version: HW_BENCH_VERSION,
		dataset_version: datasetVersion,
		created_at: new Date().toISOString(),
		cases,
	});
}

/** Score a suite; a case with no prediction is a full abstention, not a skip. */
export function scoreHwSuite(
	suite: HwSuite,
	predictions: HwPrediction[],
	opts: { ancestor_tolerance?: number } = {},
): HwScore[] {
	const byId = new Map(predictions.map((p) => [p.case_id, p]));
	return suite.cases.map((c) =>
		scoreHwCase(c, byId.get(c.case_id) ?? HwPredictionSchema.parse({ case_id: c.case_id }), opts),
	);
}
