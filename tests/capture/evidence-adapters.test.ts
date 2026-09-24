import { describe, expect, test } from "bun:test";
import {
	EVIDENCE_SOURCES,
	EXIT_CODE_MEANINGS,
	bundleEvidence,
	fromContainer,
	fromGpu,
	fromHardware,
	fromKernel,
	fromKubernetes,
	fromServerless,
} from "../../src/capture/evidence-adapters.js";

describe("exit codes establish less than runbooks assume", () => {
	test("137 is SIGKILL, which OOM is only one cause of", () => {
		expect(EXIT_CODE_MEANINGS[137].signal).toBe("SIGKILL");
		expect(EXIT_CODE_MEANINGS[137].ambiguity).toContain("cannot tell them apart");
	});

	test("every mapped code states both what it establishes and what it does not", () => {
		for (const meaning of Object.values(EXIT_CODE_MEANINGS)) {
			expect(meaning.establishes.length).toBeGreaterThan(10);
			expect(meaning.ambiguity.length).toBeGreaterThan(10);
		}
	});
});

describe("container evidence", () => {
	test("a bare 137 lists external termination alongside OOM", () => {
		const result = fromContainer({ exit_code: 137, log_tail: ["working..."] });
		expect(result.candidate_causes).toContain("memory_exhaustion");
		expect(result.candidate_causes).toContain("external_termination");
		expect(result.next_evidence.some((n) => n.includes("oom-kill"))).toBe(true);
	});

	test("an explicit OOM report removes the ambiguity from the candidates", () => {
		const result = fromContainer({ exit_code: 137, oom_killed: true, log_tail: [] });
		expect(result.candidate_causes).toEqual(["memory_exhaustion"]);
		expect(result.established.some((e) => e.includes("explicitly reported an OOM kill"))).toBe(true);
	});

	test("the log tail is marked as truncated at the kill, not at the failure", () => {
		const result = fromContainer({ exit_code: 137, log_tail: ["a", "b"] });
		expect(
			result.limitations.some((l) => l.includes("not where it failed")),
		).toBe(true);
	});

	test("peak memory well below the limit argues against OOM rather than for it", () => {
		const result = fromContainer({
			exit_code: 137,
			log_tail: [],
			memory_limit_bytes: 1000,
			memory_peak_bytes: 300,
		});
		expect(result.limitations.some((l) => l.includes("not* well supported"))).toBe(true);
	});

	test("peak memory at the limit is recorded as established", () => {
		const result = fromContainer({
			exit_code: 137,
			log_tail: [],
			memory_limit_bytes: 1000,
			memory_peak_bytes: 990,
		});
		expect(result.established.some((e) => e.includes("99% of the limit"))).toBe(true);
	});

	test("restarts warn that these logs may be from a healthier attempt", () => {
		const result = fromContainer({ exit_code: 1, log_tail: [], restart_count: 3 });
		expect(result.limitations.some((l) => l.includes("later, healthier attempt"))).toBe(true);
	});

	test("a plain nonzero exit is an application error with no signal ambiguity", () => {
		const result = fromContainer({ exit_code: 2, log_tail: [] });
		expect(result.candidate_causes).toEqual(["application_error"]);
		expect(result.established[0]).toContain("of its own accord");
	});
});

describe("kubernetes evidence", () => {
	test("crash-looping without previous logs says the current ones are the wrong process", () => {
		const result = fromKubernetes({
			pod_phase: "Running",
			waiting_reason: "CrashLoopBackOff",
			restart_count: 5,
			current_logs: ["starting up"],
		});
		expect(
			result.limitations.some((l) => l.includes("reasoning about the wrong process")),
		).toBe(true);
		expect(result.next_evidence[0]).toContain("--previous");
	});

	test("previous logs are used as the tail when present", () => {
		const result = fromKubernetes({
			pod_phase: "Running",
			waiting_reason: "CrashLoopBackOff",
			restart_count: 2,
			current_logs: ["starting up"],
			previous_logs: ["fatal: boom"],
		});
		expect(result.log_tail).toEqual(["fatal: boom"]);
	});

	test("the retention limit on previous logs is stated", () => {
		const result = fromKubernetes({
			pod_phase: "Running",
			waiting_reason: "CrashLoopBackOff",
			restart_count: 9,
			current_logs: [],
			previous_logs: ["x"],
		});
		expect(result.limitations.some((l) => l.includes("gone after the second restart"))).toBe(true);
	});

	test("an image pull failure establishes that no application evidence exists", () => {
		const result = fromKubernetes({
			pod_phase: "Pending",
			waiting_reason: "ImagePullBackOff",
			restart_count: 0,
			current_logs: [],
		});
		expect(result.candidate_causes).toContain("image_unavailable");
		expect(result.established.some((e) => e.includes("no application evidence exists at all"))).toBe(
			true,
		);
	});

	test("an OOMKilled reason inherits the 137 ambiguity", () => {
		const result = fromKubernetes({
			pod_phase: "Running",
			waiting_reason: "OOMKilled",
			restart_count: 1,
			current_logs: [],
		});
		expect(result.limitations.some((l) => l.includes("cannot tell them apart"))).toBe(true);
	});
});

describe("serverless evidence", () => {
	test("a timeout says the last line is the last flushed, not the last executed", () => {
		const result = fromServerless({
			outcome: "Timeout",
			duration_ms: 30_000,
			timeout_ms: 30_000,
			log_tail: ["fetching..."],
			has_stack: false,
		});
		expect(result.limitations.some((l) => l.includes("last line *flushed*"))).toBe(true);
		expect(result.limitations.some((l) => l.includes("no stack trace"))).toBe(true);
	});

	test("the advice targets the region with no evidence in it", () => {
		const result = fromServerless({
			outcome: "Timeout",
			duration_ms: 30_000,
			timeout_ms: 30_000,
			log_tail: [],
			has_stack: false,
		});
		expect(result.next_evidence[0]).toContain("the current instrumentation cannot see");
	});

	test("a duration at the limit counts as a timeout even without the outcome label", () => {
		const result = fromServerless({
			outcome: "Unhandled",
			duration_ms: 5000,
			timeout_ms: 5000,
			log_tail: [],
			has_stack: true,
		});
		expect(result.candidate_causes).toContain("hang");
	});

	test("memory near the limit adds exhaustion as a candidate", () => {
		const result = fromServerless({
			outcome: "OutOfMemory",
			duration_ms: 100,
			timeout_ms: 30_000,
			memory_used_mb: 512,
			memory_limit_mb: 512,
			log_tail: [],
			has_stack: false,
		});
		expect(result.candidate_causes).toContain("memory_exhaustion");
	});

	test("a cold start is flagged as possibly unreproducible when warm", () => {
		const result = fromServerless({
			outcome: "Timeout",
			duration_ms: 3000,
			timeout_ms: 3000,
			log_tail: [],
			has_stack: false,
			cold_start: true,
		});
		expect(result.limitations.some((l) => l.includes("warm invocation may not reproduce"))).toBe(
			true,
		);
	});

	test("a stackless non-timeout failure says the failing frame is unknown", () => {
		const result = fromServerless({
			outcome: "Unhandled",
			duration_ms: 10,
			timeout_ms: 30_000,
			log_tail: [],
			has_stack: false,
		});
		expect(result.limitations.some((l) => l.includes("failing frame is unknown"))).toBe(true);
	});
});

describe("kernel evidence", () => {
	test("a wrapped ring buffer warns that this oops may not be the first", () => {
		const result = fromKernel({
			title: "BUG: kernel NULL pointer dereference",
			console_lines: ["..."],
			ring_buffer_wrapped: true,
		});
		expect(result.limitations.some((l) => l.includes("this one would look primary"))).toBe(true);
		expect(result.next_evidence.some((n) => n.includes("serial console"))).toBe(true);
	});

	test("a tainted kernel warns that the stack may point entirely at in-tree code", () => {
		const result = fromKernel({
			title: "BUG",
			console_lines: [],
			tainted: ["P", "O"],
		});
		expect(result.limitations.some((l) => l.includes("out-of-tree module"))).toBe(true);
	});

	test("the no-application-context caveat is always present", () => {
		const result = fromKernel({ title: "BUG", console_lines: [] });
		expect(result.limitations.some((l) => l.includes("inference from timing"))).toBe(true);
	});
});

describe("GPU evidence", () => {
	test("an asynchronous error says the reported line is not the failing line", () => {
		const result = fromGpu({
			error: "CUDA error: an illegal memory access was encountered",
			reported_at: "torch/nn/functional.py:1234",
		});
		expect(result.limitations[0]).toContain("where it was noticed, not where it happened");
		expect(result.next_evidence[0]).toContain("synchronous device execution");
	});

	test("a synchronous error carries no such caveat", () => {
		const result = fromGpu({ error: "CUDA error: out of memory", asynchronous: false });
		expect(result.limitations.some((l) => l.includes("where it was noticed"))).toBe(false);
	});

	test("ECC counts establish a hardware fault without establishing causation", () => {
		const result = fromGpu({ error: "CUDA error", ecc_errors: 4 });
		expect(result.candidate_causes).toContain("hardware_fault");
		expect(result.limitations.some((l) => l.includes("not that it caused this failure"))).toBe(
			true,
		);
	});
});

describe("hardware evidence", () => {
	test("the correlation caveat is unconditional", () => {
		const result = fromHardware({
			event_type: "MCE",
			component: "cpu0",
			count: 1,
			at_ms: 1000,
		});
		expect(result.limitations[0]).toContain("inference from timing alone");
	});

	test("a single event is flagged as possibly corrected and harmless", () => {
		const result = fromHardware({ event_type: "ECC", component: "dimm3", count: 1, at_ms: 0 });
		expect(result.limitations.some((l) => l.includes("only a rate establishes"))).toBe(true);
		expect(result.next_evidence[0]).toContain("baseline");
	});
});

describe("every adapter states its limitations", () => {
	test("no normalized evidence has an empty limitations list", () => {
		const items = [
			fromContainer({ exit_code: 137, log_tail: [] }),
			fromKubernetes({ pod_phase: "Running", waiting_reason: "CrashLoopBackOff", restart_count: 1, current_logs: [] }),
			fromServerless({ outcome: "Timeout", duration_ms: 1, timeout_ms: 1, log_tail: [], has_stack: false }),
			fromKernel({ title: "BUG", console_lines: [] }),
			fromGpu({ error: "CUDA error" }),
			fromHardware({ event_type: "MCE", component: "cpu0", count: 1, at_ms: 0 }),
		];
		for (const item of items) expect(item.limitations.length).toBeGreaterThan(0);
	});
});

describe("bundling", () => {
	test("candidate causes are unioned, and the report says why", () => {
		const bundle = bundleEvidence([
			fromContainer({ exit_code: 137, log_tail: [] }),
			fromGpu({ error: "CUDA error", ecc_errors: 1 }),
		]);
		expect(bundle.candidate_causes).toContain("memory_exhaustion");
		expect(bundle.candidate_causes).toContain("hardware_fault");
		expect(bundle.caveats[0]).toContain("rather than because it was ruled out");
	});

	test("limitations are deduplicated across sources", () => {
		const bundle = bundleEvidence([
			fromHardware({ event_type: "MCE", component: "a", count: 1, at_ms: 0 }),
			fromHardware({ event_type: "MCE", component: "b", count: 1, at_ms: 0 }),
		]);
		expect(bundle.all_limitations).toHaveLength(2);
	});

	test("absent sources are named", () => {
		const bundle = bundleEvidence([fromKernel({ title: "BUG", console_lines: [] })]);
		expect(bundle.present).toEqual(["kernel"]);
		expect(bundle.missing).toContain("gpu");
		expect(bundle.missing.length).toBe(EVIDENCE_SOURCES.length - 1);
	});

	test("uncollected evidence widens the candidate set, and that is said", () => {
		const bundle = bundleEvidence([fromContainer({ exit_code: 137, log_tail: [] })]);
		expect(bundle.caveats.some((c) => c.includes("wider than it needs to be"))).toBe(true);
	});

	test("an empty bundle is well formed", () => {
		const bundle = bundleEvidence([]);
		expect(bundle.candidate_causes).toEqual([]);
		expect(bundle.missing).toEqual([...EVIDENCE_SOURCES]);
		expect(bundle.caveats).toEqual([]);
	});
});
