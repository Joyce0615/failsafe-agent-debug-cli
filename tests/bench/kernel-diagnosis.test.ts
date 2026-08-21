import { describe, expect, test } from "bun:test";
import {
	BASELINE_MARGIN,
	DEFAULT_KERNEL_BOUNDS,
	KERNEL_BENCH_VERSION,
	KERNEL_EVIDENCE_KINDS,
	type KernelCase,
	type KernelPrediction,
	KernelSuiteSchema,
	aggregateKernel,
	boundEvidence,
	fromKernelRows,
	parseFrame,
	propagationDistance,
	scoreKernelCase,
	scoreKernelSuite,
	validateKernelSuite,
} from "../../src/bench/kernel-diagnosis.js";

function kernelCase(overrides: Partial<KernelCase> = {}): KernelCase {
	return {
		case_id: "crash-1",
		available_evidence: ["crash_report", "syscall_trace"],
		report: {
			title: "KASAN: use-after-free Read in tcp_ack",
			crash_class: "use_after_free",
			frames: [
				{ file: "net/ipv4/tcp_input.c", method: "tcp_ack", line: 3612 },
				{ file: "net/ipv4/tcp_input.c", method: "tcp_rcv_established" },
				{ file: "net/ipv4/tcp_timer.c", method: "tcp_retransmit_timer" },
			],
			console_lines: ["BUG: KASAN", "Read of size 8"],
		},
		syscalls: ["socket(AF_INET, SOCK_STREAM, 0)", "connect(3, ...)"],
		config: ["CONFIG_KASAN=y"],
		candidate_files: ["net/ipv4/tcp_input.c", "net/ipv4/tcp_timer.c", "net/core/sock.c"],
		ground_truth: {
			file: "net/ipv4/tcp_timer.c",
			method: "tcp_retransmit_timer",
			crash_class: "use_after_free",
		},
		...overrides,
	};
}

function prediction(overrides: Partial<KernelPrediction> = {}): KernelPrediction {
	return {
		case_id: "crash-1",
		ranked_files: [],
		ranked_methods: [],
		cited_evidence: [],
		...overrides,
	};
}

describe("independent file and method ladders", () => {
	test("a correct file with the wrong method is not silently a total failure", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({
				ranked_files: ["net/ipv4/tcp_timer.c"],
				ranked_methods: ["tcp_ack"],
			}),
		);
		expect(score.file.top_k[1]).toBe(true);
		expect(score.method.top_k[1]).toBe(false);
		expect(score.joint_top1).toBe(false);
	});

	test("a correct method in the wrong file is likewise separable", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({
				ranked_files: ["net/core/sock.c"],
				ranked_methods: ["tcp_retransmit_timer"],
			}),
		);
		expect(score.file.top_k[1]).toBe(false);
		expect(score.method.top_k[1]).toBe(true);
	});

	test("top-k ladders are monotone and reciprocal rank matches position", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({
				ranked_files: ["net/core/sock.c", "net/ipv4/tcp_input.c", "net/ipv4/tcp_timer.c"],
			}),
		);
		expect(score.file.top_k[1]).toBe(false);
		expect(score.file.top_k[3]).toBe(true);
		expect(score.file.top_k[5]).toBe(true);
		expect(score.file.rank).toBe(2);
		expect(score.file.reciprocal_rank).toBeCloseTo(1 / 3, 10);
	});

	test("an unranked truth scores zero reciprocal rank and a null rank", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({ ranked_files: ["net/core/sock.c"] }),
		);
		expect(score.file.rank).toBeNull();
		expect(score.file.reciprocal_rank).toBe(0);
		expect(score.file.abstained).toBe(false);
	});

	test("an empty ranking is an abstention, not a wrong answer", () => {
		const score = scoreKernelCase(kernelCase(), prediction());
		expect(score.file.abstained).toBe(true);
		expect(score.method.abstained).toBe(true);
	});

	test("custom k values replace the defaults", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({ ranked_files: ["a", "b", "net/ipv4/tcp_timer.c"] }),
			{ k_values: [2, 4] },
		);
		expect(Object.keys(score.file.top_k).map(Number).sort((a, b) => a - b)).toEqual([2, 4]);
		expect(score.file.top_k[2]).toBe(false);
		expect(score.file.top_k[4]).toBe(true);
	});
});

describe("non-linear propagation", () => {
	test("distance is the first frame naming the culprit file", () => {
		expect(propagationDistance(kernelCase().report, "net/ipv4/tcp_timer.c")).toBe(2);
		expect(propagationDistance(kernelCase().report, "net/ipv4/tcp_input.c")).toBe(0);
	});

	test("a culprit absent from the trace has no distance at all", () => {
		expect(propagationDistance(kernelCase().report, "net/core/sock.c")).toBeNull();
	});

	test("the crash site is flagged when it is also the culprit", () => {
		const easy = kernelCase({
			ground_truth: {
				file: "net/ipv4/tcp_input.c",
				method: "tcp_ack",
				crash_class: "use_after_free",
			},
		});
		const score = scoreKernelCase(easy, prediction());
		expect(score.crash_site_is_culprit).toBe(true);
		expect(score.crash_site_baseline_file).toBe(true);
		expect(score.crash_site_baseline_method).toBe(true);
		expect(score.propagation_distance).toBe(0);
	});

	test("the canonical hard case defeats the crash-site baseline", () => {
		const score = scoreKernelCase(kernelCase(), prediction());
		expect(score.crash_site_is_culprit).toBe(false);
		expect(score.crash_site_baseline_file).toBe(false);
	});

	test("a report with no frames has no crash site to blame", () => {
		const noFrames = kernelCase({
			available_evidence: ["syscall_trace"],
			report: { ...kernelCase().report, frames: [] },
		});
		const score = scoreKernelCase(noFrames, prediction());
		expect(score.crash_site_baseline_file).toBe(false);
		expect(score.propagation_distance).toBeNull();
	});
});

describe("crash class and evidence citations", () => {
	test("crash class is scored independently of localization", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({ ranked_files: ["net/core/sock.c"], crash_class: "use_after_free" }),
		);
		expect(score.file.top_k[1]).toBe(false);
		expect(score.crash_class.correct).toBe(true);
		expect(score.crash_class.abstained).toBe(false);
	});

	test("an omitted crash class is an abstention, not a wrong class", () => {
		const score = scoreKernelCase(kernelCase(), prediction());
		expect(score.crash_class.correct).toBe(false);
		expect(score.crash_class.abstained).toBe(true);
		expect(score.crash_class.predicted).toBeUndefined();
	});

	test("citing a surface the case never supplied is counted separately", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({ cited_evidence: ["crash_report", "kernel_config", "source"] }),
		);
		expect(score.unavailable_evidence_citations).toBe(2);
	});

	test("duplicate citations cannot inflate the fabrication count", () => {
		const score = scoreKernelCase(
			kernelCase(),
			prediction({ cited_evidence: ["source", "source", "source"] }),
		);
		expect(score.unavailable_evidence_citations).toBe(1);
	});
});

describe("aggregation, baselines, and slices", () => {
	const suite = KernelSuiteSchema.parse({
		schema_version: KERNEL_BENCH_VERSION,
		dataset_version: "test",
		created_at: "2026-08-21T00:00:00.000Z",
		cases: [
			kernelCase(),
			kernelCase({
				case_id: "crash-2",
				ground_truth: {
					file: "net/ipv4/tcp_input.c",
					method: "tcp_ack",
					crash_class: "use_after_free",
				},
			}),
		],
	});

	test("a system that only blames the crash site does not beat the baseline", () => {
		const scores = scoreKernelSuite(suite, [
			prediction({ case_id: "crash-1", ranked_files: ["net/ipv4/tcp_input.c"] }),
			prediction({ case_id: "crash-2", ranked_files: ["net/ipv4/tcp_input.c"] }),
		]);
		const report = aggregateKernel(scores);
		expect(report.file.top_k[1]).toBe(0.5);
		expect(report.baselines.crash_site_file).toBe(0.5);
		expect(report.baselines.file_lift_over_crash_site).toBe(0);
		expect(report.baselines.verdict).toBe("matches_crash_site");
	});

	test("solving the propagated case earns a positive verdict", () => {
		const scores = scoreKernelSuite(suite, [
			prediction({ case_id: "crash-1", ranked_files: ["net/ipv4/tcp_timer.c"] }),
			prediction({ case_id: "crash-2", ranked_files: ["net/ipv4/tcp_input.c"] }),
		]);
		const report = aggregateKernel(scores);
		expect(report.file.top_k[1]).toBe(1);
		expect(report.baselines.file_lift_over_crash_site).toBeGreaterThan(BASELINE_MARGIN);
		expect(report.baselines.verdict).toBe("beats_crash_site");
	});

	test("doing worse than the crash site is called out", () => {
		const scores = scoreKernelSuite(suite, [
			prediction({ case_id: "crash-1", ranked_files: ["net/core/sock.c"] }),
			prediction({ case_id: "crash-2", ranked_files: ["net/core/sock.c"] }),
		]);
		const report = aggregateKernel(scores);
		expect(report.baselines.file_lift_over_crash_site).toBeLessThan(-BASELINE_MARGIN);
		expect(report.baselines.verdict).toBe("below_crash_site");
	});

	test("propagation buckets separate the easy set from the hard one", () => {
		const scores = scoreKernelSuite(suite, [
			prediction({ case_id: "crash-1", ranked_files: ["net/ipv4/tcp_timer.c"] }),
			prediction({ case_id: "crash-2", ranked_files: ["net/core/sock.c"] }),
		]);
		const report = aggregateKernel(scores);
		const easy = report.propagation.find((p) => p.bucket === "distance_0");
		const hard = report.propagation.find((p) => p.bucket === "distance_1_3");
		expect(easy?.cases).toBe(1);
		expect(easy?.file_top1).toBe(0);
		expect(hard?.cases).toBe(1);
		expect(hard?.file_top1).toBe(1);
	});

	test("a culprit outside the trace lands in the unreported bucket", () => {
		const orphan = KernelSuiteSchema.parse({
			schema_version: KERNEL_BENCH_VERSION,
			dataset_version: "test",
			created_at: "2026-08-21T00:00:00.000Z",
			cases: [
				kernelCase({
					ground_truth: {
						file: "net/core/sock.c",
						method: "sock_put",
						crash_class: "use_after_free",
					},
				}),
			],
		});
		const report = aggregateKernel(scoreKernelSuite(orphan, []));
		expect(report.propagation).toHaveLength(1);
		expect(report.propagation[0].bucket).toBe("unreported");
	});

	test("evidence slices only list surfaces some case actually supplies", () => {
		const report = aggregateKernel(scoreKernelSuite(suite, []));
		const kinds = report.slices.map((s) => s.evidence);
		expect(kinds).toContain("crash_report");
		expect(kinds).toContain("syscall_trace");
		expect(kinds).not.toContain("source");
	});

	test("a missing prediction is scored as an abstention, not skipped", () => {
		const scores = scoreKernelSuite(suite, [
			prediction({ case_id: "crash-1", ranked_files: ["net/ipv4/tcp_timer.c"] }),
		]);
		expect(scores).toHaveLength(2);
		const report = aggregateKernel(scores);
		expect(report.file.abstention_rate).toBe(0.5);
		expect(report.file.top_k[1]).toBe(0.5);
	});

	test("an empty score set aggregates to zeros rather than NaN", () => {
		const report = aggregateKernel([]);
		expect(report.cases).toBe(0);
		expect(report.file.mean_reciprocal_rank).toBe(0);
		expect(report.joint_top1_accuracy).toBe(0);
		expect(report.propagation).toEqual([]);
		expect(report.slices).toEqual([]);
		expect(Number.isNaN(report.baselines.file_lift_over_crash_site)).toBe(false);
	});

	test("joint top-1 is reported next to, not instead of, each ladder", () => {
		const scores = scoreKernelSuite(suite, [
			prediction({
				case_id: "crash-1",
				ranked_files: ["net/ipv4/tcp_timer.c"],
				ranked_methods: ["tcp_ack"],
			}),
			prediction({
				case_id: "crash-2",
				ranked_files: ["net/ipv4/tcp_input.c"],
				ranked_methods: ["tcp_ack"],
			}),
		]);
		const report = aggregateKernel(scores);
		expect(report.file.top_k[1]).toBe(1);
		expect(report.method.top_k[1]).toBe(0.5);
		expect(report.joint_top1_accuracy).toBe(0.5);
	});
});

describe("bounded evidence", () => {
	test("frames truncate from the outside in, keeping the faulting frame", () => {
		const big = kernelCase({
			report: {
				...kernelCase().report,
				frames: Array.from({ length: 50 }, (_, i) => ({
					file: `f${i}.c`,
					method: `m${i}`,
				})),
			},
		});
		const bounded = boundEvidence(big, { ...DEFAULT_KERNEL_BOUNDS, max_frames: 4 });
		expect(bounded.case.report.frames).toHaveLength(4);
		expect(bounded.case.report.frames[0].method).toBe("m0");
		expect(bounded.dropped.frames).toBe(46);
		expect(bounded.truncated).toBe(true);
	});

	test("console lines truncate from the front, keeping the fatal tail", () => {
		const noisy = kernelCase({
			report: {
				...kernelCase().report,
				console_lines: ["boot", "noise", "more noise", "BUG: KASAN"],
			},
		});
		const bounded = boundEvidence(noisy, { ...DEFAULT_KERNEL_BOUNDS, max_console_lines: 2 });
		expect(bounded.case.report.console_lines).toEqual(["more noise", "BUG: KASAN"]);
		expect(bounded.dropped.console_lines).toBe(2);
	});

	test("a case inside every bound reports no truncation and no drops", () => {
		const bounded = boundEvidence(kernelCase());
		expect(bounded.truncated).toBe(false);
		expect(bounded.dropped).toEqual({
			frames: 0,
			console_lines: 0,
			syscalls: 0,
			config_symbols: 0,
		});
	});

	test("bounding does not mutate the input case", () => {
		const original = kernelCase();
		const frames = original.report.frames.length;
		boundEvidence(original, { ...DEFAULT_KERNEL_BOUNDS, max_frames: 1 });
		expect(original.report.frames).toHaveLength(frames);
	});

	test("syscalls and config symbols are capped too", () => {
		const bounded = boundEvidence(kernelCase(), {
			max_frames: 32,
			max_console_lines: 200,
			max_syscalls: 1,
			max_config_symbols: 0,
		});
		expect(bounded.case.syscalls).toHaveLength(1);
		expect(bounded.dropped.syscalls).toBe(1);
		expect(bounded.dropped.config_symbols).toBe(1);
	});
});

describe("suite validation", () => {
	function suiteOf(cases: KernelCase[]) {
		return KernelSuiteSchema.parse({
			schema_version: KERNEL_BENCH_VERSION,
			dataset_version: "test",
			created_at: "2026-08-21T00:00:00.000Z",
			cases,
		});
	}

	test("a well-formed suite has no issues", () => {
		expect(validateKernelSuite(suiteOf([kernelCase()]))).toEqual([]);
	});

	test("duplicate case ids are rejected", () => {
		const issues = validateKernelSuite(suiteOf([kernelCase(), kernelCase()]));
		expect(issues.some((i) => i.problem.includes("duplicate"))).toBe(true);
	});

	test("an unanswerable case whose culprit is not a candidate is rejected", () => {
		const issues = validateKernelSuite(
			suiteOf([kernelCase({ candidate_files: ["net/core/sock.c"] })]),
		);
		expect(issues.some((i) => i.problem.includes("not among candidate_files"))).toBe(true);
	});

	test("frames without a declared crash_report surface are rejected", () => {
		const issues = validateKernelSuite(
			suiteOf([kernelCase({ available_evidence: ["syscall_trace"] })]),
		);
		expect(issues.some((i) => i.problem.includes("does not declare crash_report"))).toBe(true);
	});

	test("declaring a syscall trace with no syscalls is rejected", () => {
		const issues = validateKernelSuite(suiteOf([kernelCase({ syscalls: [] })]));
		expect(issues.some((i) => i.problem.includes("supplies no syscalls"))).toBe(true);
	});

	test("a case with neither frames nor syscalls has nothing to localize from", () => {
		const issues = validateKernelSuite(
			suiteOf([
				kernelCase({
					available_evidence: ["kernel_config"],
					report: { ...kernelCase().report, frames: [] },
					syscalls: [],
				}),
			]),
		);
		expect(issues.some((i) => i.problem.includes("nothing to localize from"))).toBe(true);
	});
});

describe("row normalization", () => {
	test("printed kernel frame lines are parsed into file and method", () => {
		expect(parseFrame("tcp_ack+0x1a/0x30 net/ipv4/tcp_input.c:3612")).toEqual({
			file: "net/ipv4/tcp_input.c",
			method: "tcp_ack",
			line: 3612,
		});
	});

	test("the file-first printed form is parsed too", () => {
		expect(parseFrame("net/ipv4/tcp_input.c:3612 tcp_ack")).toEqual({
			file: "net/ipv4/tcp_input.c",
			method: "tcp_ack",
			line: 3612,
		});
	});

	test("object frames are accepted under several key spellings", () => {
		expect(parseFrame({ path: "mm/slub.c", func: "kfree", line: 10 })).toEqual({
			file: "mm/slub.c",
			method: "kfree",
			line: 10,
		});
	});

	test("an unparseable frame yields undefined rather than a guess", () => {
		expect(parseFrame("<<<garbage>>>")).toBeUndefined();
		expect(parseFrame(42)).toBeUndefined();
		expect(parseFrame({ file: "mm/slub.c" })).toBeUndefined();
	});

	test("rows without a culprit are skipped, never defaulted to the crash site", () => {
		const suite = fromKernelRows(
			[
				{
					id: "a",
					frames: ["tcp_ack+0x1/0x2 net/ipv4/tcp_input.c:1"],
					crash_class: "use_after_free",
				},
				{
					id: "b",
					fix_file: "net/ipv4/tcp_timer.c",
					fix_method: "tcp_retransmit_timer",
					frames: ["tcp_ack+0x1/0x2 net/ipv4/tcp_input.c:1"],
					crash_class: "use_after_free",
				},
			],
			"v1",
		);
		expect(suite.cases).toHaveLength(1);
		expect(suite.cases[0].case_id).toBe("b");
	});

	test("the culprit file is added to the candidate list when missing", () => {
		const suite = fromKernelRows(
			[
				{
					id: "b",
					fix_file: "net/ipv4/tcp_timer.c",
					fix_method: "tcp_retransmit_timer",
					candidate_files: ["net/core/sock.c"],
					frames: ["tcp_ack+0x1/0x2 net/ipv4/tcp_input.c:1"],
				},
			],
			"v1",
		);
		expect(suite.cases[0].candidate_files).toContain("net/ipv4/tcp_timer.c");
		expect(validateKernelSuite(suite).some((i) => i.problem.includes("candidate_files"))).toBe(
			false,
		);
	});

	test("available evidence is inferred from what the row actually carries", () => {
		const suite = fromKernelRows(
			[
				{
					id: "b",
					fix_file: "mm/slub.c",
					fix_method: "kfree",
					syscalls: ["mmap(...)"],
					config: ["CONFIG_KASAN=y"],
				},
			],
			"v1",
		);
		expect(suite.cases[0].available_evidence.sort()).toEqual(["kernel_config", "syscall_trace"]);
	});

	test("a row with nothing to go on is skipped", () => {
		expect(fromKernelRows([{ fix_file: "a.c", fix_method: "f" }], "v1").cases).toHaveLength(0);
	});

	test("the evidence kind list is the single source of truth for the schema", () => {
		expect(KERNEL_EVIDENCE_KINDS).toEqual([
			"crash_report",
			"syscall_trace",
			"console_log",
			"kernel_config",
			"source",
		]);
	});
});
