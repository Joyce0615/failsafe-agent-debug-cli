/**
 * Kernel-crash diagnosis with heterogeneous low-level evidence (item 51).
 *
 * Every benchmark adapter in this repo so far assumes a userspace program with
 * a stack trace that points more or less at the bug. Kernel crashes break that
 * assumption in a specific, measurable way: the faulting frame is where the
 * machine *noticed*, and the culprit is where the invariant was *broken*, and
 * the two are routinely in different subsystems. A use-after-free reported by
 * KASAN names the reader; the bug is in whoever freed. This is the "non-linear
 * propagation" that makes kernel triage its own problem.
 *
 * The adapter therefore:
 *
 * 1. Models the four low-level evidence surfaces separately
 *    (`crash_report | syscall_trace | console_log | kernel_config | source`),
 *    because a system that only reads the KASAN report is a different system
 *    from one that also reads the syscall reproducer, and the availability
 *    slices are what tell them apart.
 * 2. Scores **file** and **method** localization on independent ladders. A
 *    correct file with the wrong function is a real, common, partially useful
 *    answer, and collapsing it into one number destroys that information.
 * 3. Reports two trivial baselines — blame the faulting frame, blame the first
 *    application frame in the report — next to every accuracy. Kernel corpora
 *    contain plenty of crashes where the crash site *is* the culprit, so an
 *    accuracy that does not beat "blame the crash site" is measuring the
 *    corpus, not the system.
 * 4. Slices by propagation distance (frames between crash site and culprit), so
 *    the cases the baselines cannot get are visible on their own.
 *
 * Bounded by construction: `boundEvidence` caps frames, console lines, and
 * syscall count, and *says what it dropped*. A raw syzbot console log runs to
 * megabytes; silently feeding all of it to a model and then reporting an
 * accuracy would be measuring a context window.
 *
 * Pure: no network, no dataset download, no corpus in the repo. A user exports
 * rows however they obtain them and `fromKernelRows` normalizes them.
 */
import { z } from "zod";

/** Evidence surfaces available for a kernel crash. */
export const KERNEL_EVIDENCE_KINDS = [
	"crash_report",
	"syscall_trace",
	"console_log",
	"kernel_config",
	"source",
] as const;
export const KernelEvidenceKindSchema = z.enum(KERNEL_EVIDENCE_KINDS);
export type KernelEvidenceKind = z.infer<typeof KernelEvidenceKindSchema>;

export const KERNEL_BENCH_VERSION = "0.1";

/**
 * One frame of a kernel stack trace. `file` is repo-relative
 * (`net/ipv4/tcp_input.c`); `method` is the C function.
 */
export const KernelFrameSchema = z.object({
	file: z.string().min(1),
	method: z.string().min(1),
	line: z.number().int().positive().optional(),
});
export type KernelFrame = z.infer<typeof KernelFrameSchema>;

/**
 * The report as captured. `frames` is ordered innermost-first, matching how
 * the kernel prints a call trace, so `frames[0]` is the faulting frame.
 */
export const CrashReportSchema = z.object({
	/** e.g. `KASAN: use-after-free Read in tcp_ack`. */
	title: z.string().min(1),
	/** e.g. `use_after_free`, `null_deref`, `deadlock`, `warning`, `panic`. */
	crash_class: z.string().min(1),
	frames: z.array(KernelFrameSchema).default([]),
	console_lines: z.array(z.string()).default([]),
});
export type CrashReport = z.infer<typeof CrashReportSchema>;

export const KernelCaseSchema = z.object({
	case_id: z.string().min(1),
	/** Evidence surfaces actually supplied. */
	available_evidence: z.array(KernelEvidenceKindSchema).min(1),
	report: CrashReportSchema,
	/** Syscall reproducer program, one call per entry. Empty when none exists. */
	syscalls: z.array(z.string()).default([]),
	/** Config symbols that were enabled, e.g. `CONFIG_KASAN=y`. */
	config: z.array(z.string()).default([]),
	/** Every file a prediction may name. Must contain the culprit. */
	candidate_files: z.array(z.string().min(1)).min(1),
	ground_truth: z.object({
		/** The file the fixing patch touched. */
		file: z.string().min(1),
		/** The function the fixing patch touched. */
		method: z.string().min(1),
		crash_class: z.string().min(1),
	}),
});
export type KernelCase = z.infer<typeof KernelCaseSchema>;

export const KernelPredictionSchema = z.object({
	case_id: z.string().min(1),
	/** Files ranked best-first. Empty is a valid abstention. */
	ranked_files: z.array(z.string()).default([]),
	/** Methods ranked best-first, scored independently of the file ladder. */
	ranked_methods: z.array(z.string()).default([]),
	crash_class: z.string().optional(),
	cited_evidence: z.array(KernelEvidenceKindSchema).default([]),
});
export type KernelPrediction = z.infer<typeof KernelPredictionSchema>;

export const KernelSuiteSchema = z.object({
	schema_version: z.literal(KERNEL_BENCH_VERSION),
	dataset_version: z.string().min(1),
	created_at: z.string(),
	cases: z.array(KernelCaseSchema),
});
export type KernelSuite = z.infer<typeof KernelSuiteSchema>;

/** Default k values for the two Top@k ladders. */
export const DEFAULT_K_VALUES = [1, 3, 5, 10] as const;

export type RankScore = {
	/** `top_k[k]` is true when the truth appears within the first k entries. */
	top_k: Record<number, boolean>;
	reciprocal_rank: number;
	/** 0-based position of the truth, or `null` when unranked. */
	rank: number | null;
	abstained: boolean;
};

function rankScore(ranked: string[], truth: string, ks: readonly number[]): RankScore {
	const idx = ranked.indexOf(truth);
	const top: Record<number, boolean> = {};
	for (const k of ks) top[k] = idx >= 0 && idx < k;
	return {
		top_k: top,
		reciprocal_rank: idx >= 0 ? 1 / (idx + 1) : 0,
		rank: idx >= 0 ? idx : null,
		abstained: ranked.length === 0,
	};
}

/**
 * How far the culprit sits from the crash site, measured in frames of the
 * reported call trace.
 *
 * `0` means the faulting frame is the culprit file. A positive number is the
 * index of the first frame naming the culprit file. `null` means the culprit
 * never appears in the trace at all — the hardest and most interesting class,
 * because no amount of reading the report will find it.
 */
export function propagationDistance(report: CrashReport, truthFile: string): number | null {
	const idx = report.frames.findIndex((f) => f.file === truthFile);
	return idx >= 0 ? idx : null;
}

export type KernelScore = {
	case_id: string;
	available_evidence: KernelEvidenceKind[];
	file: RankScore;
	method: RankScore;
	/** Both ladders correct at rank 1. Reported, never substituted for either. */
	joint_top1: boolean;
	crash_class: { correct: boolean; predicted?: string; expected: string; abstained: boolean };
	/** Citations naming a surface the case does not supply. */
	unavailable_evidence_citations: number;
	propagation_distance: number | null;
	/** True when the faulting frame's file is the culprit file. */
	crash_site_is_culprit: boolean;
	/** What "blame the faulting frame" would have scored on this case. */
	crash_site_baseline_file: boolean;
	crash_site_baseline_method: boolean;
};

/**
 * Score one case against one prediction.
 *
 * File and method are scored independently and *neither is conditioned on the
 * other*: a system that names the right file and the wrong function has done
 * something genuinely useful, and a system that names the right function in the
 * wrong file has almost certainly guessed.
 */
export function scoreKernelCase(
	testCase: KernelCase,
	prediction: KernelPrediction,
	opts: { k_values?: readonly number[] } = {},
): KernelScore {
	const ks = opts.k_values ?? DEFAULT_K_VALUES;
	const truth = testCase.ground_truth;

	const file = rankScore(prediction.ranked_files, truth.file, ks);
	const method = rankScore(prediction.ranked_methods, truth.method, ks);

	const available = new Set<string>(testCase.available_evidence);
	const cited = new Set(prediction.cited_evidence);
	let unavailable = 0;
	for (const kind of cited) {
		if (!available.has(kind)) unavailable++;
	}

	const crashSite = testCase.report.frames[0];

	return {
		case_id: testCase.case_id,
		available_evidence: testCase.available_evidence,
		file,
		method,
		joint_top1: file.rank === 0 && method.rank === 0,
		crash_class: {
			correct: prediction.crash_class === truth.crash_class,
			...(prediction.crash_class ? { predicted: prediction.crash_class } : {}),
			expected: truth.crash_class,
			abstained: prediction.crash_class === undefined,
		},
		unavailable_evidence_citations: unavailable,
		propagation_distance: propagationDistance(testCase.report, truth.file),
		crash_site_is_culprit: crashSite?.file === truth.file,
		crash_site_baseline_file: crashSite?.file === truth.file,
		crash_site_baseline_method: crashSite?.method === truth.method,
	};
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function rate(scores: KernelScore[], pick: (s: KernelScore) => boolean): number {
	return mean(scores.map((s) => (pick(s) ? 1 : 0)));
}

export type KernelLadderReport = {
	top_k: Record<number, number>;
	mean_reciprocal_rank: number;
	abstention_rate: number;
};

export type KernelDiagnosisReport = {
	schema_version: typeof KERNEL_BENCH_VERSION;
	cases: number;
	file: KernelLadderReport;
	method: KernelLadderReport;
	joint_top1_accuracy: number;
	crash_class: { accuracy: number; abstention_rate: number };
	unavailable_evidence_citations: number;
	baselines: {
		crash_site_file: number;
		crash_site_method: number;
		/** file top-1 minus the crash-site file baseline; negative is damning. */
		file_lift_over_crash_site: number;
		verdict: "beats_crash_site" | "matches_crash_site" | "below_crash_site";
	};
	/**
	 * Slices by how far the culprit sits from the crash site. `distance_0` is
	 * the easy set the baseline also gets; `unreported` is the set no amount of
	 * reading the crash report can solve.
	 */
	propagation: Array<{
		bucket: "distance_0" | "distance_1_3" | "distance_4_plus" | "unreported";
		cases: number;
		file_top1: number;
		method_top1: number;
	}>;
	/** Per-evidence-surface availability slices. */
	slices: Array<{
		evidence: KernelEvidenceKind;
		cases: number;
		file_top1: number;
		method_top1: number;
	}>;
};

function propagationBucket(
	distance: number | null,
): KernelDiagnosisReport["propagation"][number]["bucket"] {
	if (distance === null) return "unreported";
	if (distance === 0) return "distance_0";
	if (distance <= 3) return "distance_1_3";
	return "distance_4_plus";
}

function ladder(scores: KernelScore[], pick: (s: KernelScore) => RankScore): KernelLadderReport {
	const ks = Object.keys(scores[0] ? pick(scores[0]).top_k : {}).map(Number);
	const topK: Record<number, number> = {};
	for (const k of ks) topK[k] = mean(scores.map((s) => (pick(s).top_k[k] ? 1 : 0)));
	return {
		top_k: topK,
		mean_reciprocal_rank: mean(scores.map((s) => pick(s).reciprocal_rank)),
		abstention_rate: rate(scores, (s) => pick(s).abstained),
	};
}

/** Margin below which a difference from the baseline is not worth claiming. */
export const BASELINE_MARGIN = 0.02;

export function aggregateKernel(scores: KernelScore[]): KernelDiagnosisReport {
	const fileTop1 = rate(scores, (s) => s.file.rank === 0);
	const crashSiteFile = rate(scores, (s) => s.crash_site_baseline_file);
	const lift = fileTop1 - crashSiteFile;

	const buckets: Array<KernelDiagnosisReport["propagation"][number]["bucket"]> = [
		"distance_0",
		"distance_1_3",
		"distance_4_plus",
		"unreported",
	];

	return {
		schema_version: KERNEL_BENCH_VERSION,
		cases: scores.length,
		file: ladder(scores, (s) => s.file),
		method: ladder(scores, (s) => s.method),
		joint_top1_accuracy: rate(scores, (s) => s.joint_top1),
		crash_class: {
			accuracy: rate(scores, (s) => s.crash_class.correct),
			abstention_rate: rate(scores, (s) => s.crash_class.abstained),
		},
		unavailable_evidence_citations: scores.reduce(
			(a, s) => a + s.unavailable_evidence_citations,
			0,
		),
		baselines: {
			crash_site_file: crashSiteFile,
			crash_site_method: rate(scores, (s) => s.crash_site_baseline_method),
			file_lift_over_crash_site: lift,
			verdict:
				lift > BASELINE_MARGIN
					? "beats_crash_site"
					: lift < -BASELINE_MARGIN
						? "below_crash_site"
						: "matches_crash_site",
		},
		propagation: buckets
			.map((bucket) => {
				const subset = scores.filter((s) => propagationBucket(s.propagation_distance) === bucket);
				return {
					bucket,
					cases: subset.length,
					file_top1: rate(subset, (s) => s.file.rank === 0),
					method_top1: rate(subset, (s) => s.method.rank === 0),
				};
			})
			.filter((b) => b.cases > 0),
		slices: KERNEL_EVIDENCE_KINDS.map((evidence) => {
			const subset = scores.filter((s) => s.available_evidence.includes(evidence));
			return {
				evidence,
				cases: subset.length,
				file_top1: rate(subset, (s) => s.file.rank === 0),
				method_top1: rate(subset, (s) => s.method.rank === 0),
			};
		}).filter((s) => s.cases > 0),
	};
}

export type KernelBounds = {
	max_frames: number;
	max_console_lines: number;
	max_syscalls: number;
	max_config_symbols: number;
};

export const DEFAULT_KERNEL_BOUNDS: KernelBounds = {
	max_frames: 32,
	max_console_lines: 200,
	max_syscalls: 64,
	max_config_symbols: 128,
};

export type BoundedCase = {
	case: KernelCase;
	dropped: { frames: number; console_lines: number; syscalls: number; config_symbols: number };
	truncated: boolean;
};

/**
 * Apply the evidence caps.
 *
 * Truncation always keeps the *innermost* frames and the *last* console lines:
 * the kernel prints the fatal report at the end of the log, and a leading
 * truncation would remove exactly the part that matters. What was dropped is
 * returned rather than logged, so a caller can put the numbers in its report
 * instead of pretending it read everything.
 */
export function boundEvidence(
	testCase: KernelCase,
	bounds: KernelBounds = DEFAULT_KERNEL_BOUNDS,
): BoundedCase {
	const frames = testCase.report.frames.slice(0, bounds.max_frames);
	const console = testCase.report.console_lines.slice(-bounds.max_console_lines);
	const syscalls = testCase.syscalls.slice(0, bounds.max_syscalls);
	const config = testCase.config.slice(0, bounds.max_config_symbols);

	const dropped = {
		frames: testCase.report.frames.length - frames.length,
		console_lines: testCase.report.console_lines.length - console.length,
		syscalls: testCase.syscalls.length - syscalls.length,
		config_symbols: testCase.config.length - config.length,
	};

	return {
		case: {
			...testCase,
			report: { ...testCase.report, frames, console_lines: console },
			syscalls,
			config,
		},
		dropped,
		truncated: Object.values(dropped).some((n) => n > 0),
	};
}

export type KernelSuiteIssue = { case_id: string; problem: string };

/**
 * Reject suites that cannot produce meaningful scores.
 *
 * The load-bearing check is the last one: a case whose culprit file is not
 * among the candidates is unanswerable, and a case that supplies no crash
 * report while requiring frame-level reasoning is measuring guesswork.
 */
export function validateKernelSuite(suite: KernelSuite): KernelSuiteIssue[] {
	const issues: KernelSuiteIssue[] = [];
	const seen = new Set<string>();
	for (const c of suite.cases) {
		if (seen.has(c.case_id)) issues.push({ case_id: c.case_id, problem: "duplicate case_id" });
		seen.add(c.case_id);

		if (!c.candidate_files.includes(c.ground_truth.file)) {
			issues.push({
				case_id: c.case_id,
				problem: `ground-truth file '${c.ground_truth.file}' is not among candidate_files`,
			});
		}

		if (!c.available_evidence.includes("crash_report") && c.report.frames.length > 0) {
			issues.push({
				case_id: c.case_id,
				problem: "carries crash frames but does not declare crash_report as available evidence",
			});
		}

		if (c.available_evidence.includes("syscall_trace") && c.syscalls.length === 0) {
			issues.push({
				case_id: c.case_id,
				problem: "declares syscall_trace as available but supplies no syscalls",
			});
		}

		if (c.report.frames.length === 0 && c.syscalls.length === 0) {
			issues.push({
				case_id: c.case_id,
				problem: "no frames and no syscalls: nothing to localize from",
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
 * Parse the frame forms kernel corpora actually ship: an object with
 * `file`/`func`, or the printed `func+0x1a/0x30 [file:line]` line.
 */
export function parseFrame(entry: unknown): KernelFrame | undefined {
	if (entry && typeof entry === "object") {
		const obj = entry as Row;
		const file = str(obj, "file", "path", "source");
		const method = str(obj, "method", "func", "function", "symbol");
		if (!file || !method) return undefined;
		const line = typeof obj.line === "number" ? obj.line : undefined;
		return { file, method, ...(line && line > 0 ? { line } : {}) };
	}
	if (typeof entry !== "string") return undefined;
	// `tcp_ack+0x1a/0x30 net/ipv4/tcp_input.c:3612`
	const match = entry.match(
		/^\s*([A-Za-z_][\w.]*)(?:\+0x[\da-f]+)?(?:\/0x[\da-f]+)?\s+([^\s:]+):(\d+)/,
	);
	if (match) {
		return { file: match[2], method: match[1], line: Number.parseInt(match[3], 10) };
	}
	// `net/ipv4/tcp_input.c:3612 tcp_ack`
	const alt = entry.match(/^\s*([^\s:]+\.[ch]):(\d+)\s+([A-Za-z_][\w.]*)/);
	if (alt) {
		return { file: alt[1], method: alt[3], line: Number.parseInt(alt[2], 10) };
	}
	return undefined;
}

/**
 * Normalize exported kernel-crash rows into a canonical suite.
 *
 * Rows missing a culprit file or method are skipped rather than defaulted to
 * the crash site — defaulting would manufacture exactly the cases the crash-site
 * baseline scores perfectly, which is the bias this module exists to detect.
 */
export function fromKernelRows(rows: Row[], datasetVersion: string): KernelSuite {
	const cases: KernelCase[] = [];
	for (const row of rows) {
		const file = str(row, "fix_file", "culprit_file", "file");
		const method = str(row, "fix_method", "culprit_method", "method", "func");
		if (!file || !method) continue;

		const frames = strArray(row, "frames", "call_trace")
			.map(parseFrame)
			.filter((f): f is KernelFrame => f !== undefined);
		const objectFrames = Array.isArray(row.frames)
			? row.frames
					.filter((f) => f && typeof f === "object")
					.map(parseFrame)
					.filter((f): f is KernelFrame => f !== undefined)
			: [];
		const allFrames = frames.length > 0 ? frames : objectFrames;

		const syscalls = strArray(row, "syscalls", "repro_syscalls", "program");
		const config = strArray(row, "config", "config_symbols");
		const candidates = strArray(row, "candidate_files", "files");
		const candidateFiles = candidates.includes(file) ? candidates : [...candidates, file];

		const declared = strArray(row, "available_evidence", "evidence").filter(
			(e): e is KernelEvidenceKind => (KERNEL_EVIDENCE_KINDS as readonly string[]).includes(e),
		);
		const inferred: KernelEvidenceKind[] = [];
		if (allFrames.length > 0) inferred.push("crash_report");
		if (syscalls.length > 0) inferred.push("syscall_trace");
		if (config.length > 0) inferred.push("kernel_config");
		const available = declared.length > 0 ? declared : inferred;
		if (available.length === 0) continue;

		const parsed = KernelCaseSchema.safeParse({
			case_id: str(row, "case_id", "crash_id", "id") ?? "",
			available_evidence: available,
			report: {
				title: str(row, "title", "crash_title") ?? "untitled crash",
				crash_class: str(row, "crash_class", "bug_type", "kind") ?? "unknown",
				frames: allFrames,
				console_lines: strArray(row, "console_lines", "log"),
			},
			syscalls,
			config,
			candidate_files: candidateFiles,
			ground_truth: {
				file,
				method,
				crash_class: str(row, "crash_class", "bug_type", "kind") ?? "unknown",
			},
		});
		if (parsed.success) cases.push(parsed.data);
	}

	return KernelSuiteSchema.parse({
		schema_version: KERNEL_BENCH_VERSION,
		dataset_version: datasetVersion,
		created_at: new Date().toISOString(),
		cases,
	});
}

/**
 * Score a whole suite. A case with no prediction is a full abstention rather
 * than a skip, so declining to answer cannot improve the aggregate.
 */
export function scoreKernelSuite(
	suite: KernelSuite,
	predictions: KernelPrediction[],
	opts: { k_values?: readonly number[] } = {},
): KernelScore[] {
	const byId = new Map(predictions.map((p) => [p.case_id, p]));
	return suite.cases.map((c) =>
		scoreKernelCase(
			c,
			byId.get(c.case_id) ?? KernelPredictionSchema.parse({ case_id: c.case_id }),
			opts,
		),
	);
}
