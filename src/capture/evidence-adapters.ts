/**
 * Evidence adapters for container, Kubernetes, serverless, kernel, GPU, and
 * hardware environments (item 85).
 *
 * Each of these environments destroys evidence in a *characteristic* way, and
 * the characteristic way is the useful part. An agent handed a container's last
 * hundred log lines after an OOM kill will reason about them as though they
 * were the last hundred things that happened. They are not: the process was
 * SIGKILLed mid-write, so the tail is whatever had been flushed, and the
 * interesting lines are precisely the ones that were still in the buffer.
 *
 * So an adapter's job here is not mainly to parse. It is to attach the
 * limitation that comes with the source, automatically, so that reasoning
 * downstream is done against evidence whose shape is known:
 *
 * - **Container**: exit 137 is SIGKILL, which is an OOM kill *or* an external
 *   kill, and the exit code alone cannot tell them apart. The log tail is
 *   truncated at the kill, not at the failure.
 * - **Kubernetes**: a CrashLoopBackOff pod's useful logs belong to the
 *   *previous* container, are only reachable with `--previous`, and are gone
 *   after the next restart. The current container's logs describe a process
 *   that has not failed yet.
 * - **Serverless**: a timeout terminates the invocation with no stack. The last
 *   log line is the last thing *flushed*, not the last thing executed, and the
 *   gap between them is exactly where the hang is.
 * - **Kernel**: an oops can be truncated by the console ring buffer, and the
 *   part that is lost is the beginning — which is where the first fault is.
 * - **GPU**: an asynchronous error surfaces at the next synchronization point.
 *   The reported line is where the error was *noticed*, and the launch that
 *   caused it is somewhere earlier with no link.
 * - **Hardware**: an ECC or MCE event has no application context at all;
 *   correlating it to a workload is inference, never observation.
 *
 * Pure: normalizes already-collected evidence.
 */

export const EVIDENCE_SOURCES = [
	"container",
	"kubernetes",
	"serverless",
	"kernel",
	"gpu",
	"hardware",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export type NormalizedEvidence = {
	source: EvidenceSource;
	/** Short statement of what happened, as far as the evidence supports. */
	summary: string;
	/** Cause classes consistent with the evidence. More than one is normal. */
	candidate_causes: string[];
	/** Log lines, already known to be partial in the ways `limitations` states. */
	log_tail: string[];
	/** How the evidence is incomplete. Never empty. */
	limitations: string[];
	/** Facts the evidence establishes outright. */
	established: string[];
	/** What to collect next to narrow the candidates. */
	next_evidence: string[];
};

export type ContainerEvidence = {
	exit_code: number;
	/** Whether the runtime reported an OOM kill, when it reports one at all. */
	oom_killed?: boolean;
	memory_limit_bytes?: number;
	memory_peak_bytes?: number;
	log_tail: string[];
	restart_count?: number;
};

/**
 * Signal-derived exit codes, with what they do and do not establish.
 *
 * The entry that matters is 137: every "container OOM" runbook treats it as
 * conclusive and it is not. It means SIGKILL, which the kernel's OOM killer
 * sends and so does `docker kill`, a liveness probe failure, and a node
 * draining.
 */
export const EXIT_CODE_MEANINGS: Record<
	number,
	{ signal: string; establishes: string; ambiguity: string }
> = {
	134: {
		signal: "SIGABRT",
		establishes: "the process aborted itself",
		ambiguity:
			"an assertion, an uncaught C++ exception, and a deliberate abort() are indistinguishable here",
	},
	137: {
		signal: "SIGKILL",
		establishes: "the process was killed and could not clean up or flush",
		ambiguity:
			"SIGKILL is sent by the OOM killer, by `docker kill`, by a failed liveness probe, and by a draining node; the exit code alone cannot tell them apart",
	},
	139: {
		signal: "SIGSEGV",
		establishes: "the process attempted an invalid memory access",
		ambiguity:
			"a null dereference, a stack overflow, and a corrupted pointer look the same from outside",
	},
	143: {
		signal: "SIGTERM",
		establishes: "the process was asked to stop",
		ambiguity:
			"a graceful shutdown and a shutdown the process failed to complete in time both end here",
	},
};

/**
 * Normalize container evidence.
 *
 * The log tail is *always* marked as truncated at the kill rather than at the
 * failure when the process was signalled, because that is true and because the
 * lines an agent most wants are the ones that were in the buffer.
 */
export function fromContainer(evidence: ContainerEvidence): NormalizedEvidence {
	const meaning = EXIT_CODE_MEANINGS[evidence.exit_code];
	const limitations: string[] = [];
	const candidates: string[] = [];
	const established: string[] = [];
	const next: string[] = [];

	if (meaning) {
		established.push(`${meaning.signal}: ${meaning.establishes}`);
		limitations.push(meaning.ambiguity);
		limitations.push(
			"the log tail ends where the process was killed, not where it failed; anything still in the write buffer was lost",
		);
	}

	if (evidence.exit_code === 137) {
		if (evidence.oom_killed === true) {
			candidates.push("memory_exhaustion");
			established.push("the runtime explicitly reported an OOM kill");
		} else {
			candidates.push("memory_exhaustion", "external_termination", "liveness_probe_failure");
			next.push(
				"check the kernel log for an `oom-kill` entry naming this cgroup: the runtime's exit code cannot establish it",
			);
		}
		if (evidence.memory_peak_bytes !== undefined && evidence.memory_limit_bytes !== undefined) {
			const ratio = evidence.memory_peak_bytes / evidence.memory_limit_bytes;
			if (ratio >= 0.95) {
				established.push(
					`peak memory reached ${(ratio * 100).toFixed(0)}% of the limit before the kill`,
				);
			} else {
				limitations.push(
					`peak memory was only ${(ratio * 100).toFixed(0)}% of the limit, so memory exhaustion is *not* well supported; the sampling interval may simply have missed the spike`,
				);
			}
		} else {
			next.push(
				"collect the peak memory sample; without it an OOM diagnosis rests on the exit code alone",
			);
		}
	} else if (meaning) {
		candidates.push(meaning.signal.toLowerCase());
	} else {
		candidates.push("application_error");
		established.push(`the process exited with status ${evidence.exit_code} of its own accord`);
	}

	if ((evidence.restart_count ?? 0) > 0) {
		limitations.push(
			`the container has restarted ${evidence.restart_count} time(s); these logs may belong to a later, healthier attempt than the one that first failed`,
		);
	}

	return {
		source: "container",
		summary: meaning
			? `container terminated by ${meaning.signal} (exit ${evidence.exit_code})`
			: `container exited with status ${evidence.exit_code}`,
		candidate_causes: candidates,
		log_tail: evidence.log_tail,
		limitations,
		established,
		next_evidence: next,
	};
}

export type KubernetesEvidence = {
	pod_phase: string;
	/** e.g. `CrashLoopBackOff`, `OOMKilled`, `Error`. */
	waiting_reason?: string;
	restart_count: number;
	/** Logs from the *current* container. */
	current_logs: string[];
	/** Logs from the previous container, when `--previous` was used. */
	previous_logs?: string[];
	last_termination_exit_code?: number;
};

/**
 * Normalize Kubernetes evidence.
 *
 * The load-bearing rule: in CrashLoopBackOff the current container's logs are
 * about a process that has not failed yet, and reasoning from them is reasoning
 * about the wrong process. When `previous_logs` are absent the adapter says so
 * rather than handing over the current ones as if they were the same thing.
 */
export function fromKubernetes(evidence: KubernetesEvidence): NormalizedEvidence {
	const crashLooping = evidence.waiting_reason === "CrashLoopBackOff";
	const limitations: string[] = [];
	const established: string[] = [];
	const next: string[] = [];
	const candidates: string[] = [];

	if (crashLooping) {
		established.push(`the pod has restarted ${evidence.restart_count} time(s) and is backing off`);
		if (!evidence.previous_logs || evidence.previous_logs.length === 0) {
			limitations.push(
				"no previous-container logs are present; the current container's logs describe a process that has not failed yet, and reasoning from them is reasoning about the wrong process",
			);
			next.push("collect `kubectl logs --previous`, which is where the failing run's output lives");
		}
		limitations.push(
			"only the most recent previous container is retained; output from the first failure is gone after the second restart",
		);
	}

	if (evidence.waiting_reason === "OOMKilled" || evidence.last_termination_exit_code === 137) {
		candidates.push("memory_exhaustion", "external_termination");
		limitations.push(EXIT_CODE_MEANINGS[137].ambiguity);
	}
	if (
		evidence.waiting_reason === "ImagePullBackOff" ||
		evidence.waiting_reason === "ErrImagePull"
	) {
		candidates.push("image_unavailable", "registry_credentials");
		established.push("the container never started, so no application evidence exists at all");
	}
	if (candidates.length === 0) candidates.push("application_error");

	return {
		source: "kubernetes",
		summary: `pod in ${evidence.pod_phase}${evidence.waiting_reason ? ` (${evidence.waiting_reason})` : ""} after ${evidence.restart_count} restart(s)`,
		candidate_causes: candidates,
		log_tail: evidence.previous_logs ?? evidence.current_logs,
		limitations,
		established,
		next_evidence: next,
	};
}

export type ServerlessEvidence = {
	/** e.g. `Timeout`, `OutOfMemory`, `Unhandled`, `Success`. */
	outcome: string;
	duration_ms: number;
	timeout_ms: number;
	memory_used_mb?: number;
	memory_limit_mb?: number;
	log_tail: string[];
	/** Whether the runtime produced a stack trace. */
	has_stack: boolean;
	cold_start?: boolean;
};

/**
 * Normalize serverless evidence.
 *
 * The characteristic loss is the timeout: the invocation is terminated, no
 * stack is produced, and the last log line is the last thing *flushed*. The
 * hang is in the gap between that line and whatever came next, which is exactly
 * the region with no evidence in it.
 */
export function fromServerless(evidence: ServerlessEvidence): NormalizedEvidence {
	const limitations: string[] = [];
	const established: string[] = [];
	const next: string[] = [];
	const candidates: string[] = [];

	const timedOut = evidence.outcome === "Timeout" || evidence.duration_ms >= evidence.timeout_ms;

	if (timedOut) {
		candidates.push("hang", "slow_dependency", "insufficient_timeout");
		established.push(
			`the invocation ran for ${evidence.duration_ms}ms against a ${evidence.timeout_ms}ms limit and was terminated`,
		);
		limitations.push(
			"a timeout produces no stack trace: there is no record of where execution actually was",
		);
		limitations.push(
			"the last log line is the last line *flushed*, not the last executed; the hang is in the gap after it, which is the part with no evidence",
		);
		next.push(
			"add a periodic heartbeat log or a per-stage timer, since the failure region is precisely the one the current instrumentation cannot see",
		);
	}

	if (evidence.memory_used_mb !== undefined && evidence.memory_limit_mb !== undefined) {
		const ratio = evidence.memory_used_mb / evidence.memory_limit_mb;
		if (ratio >= 0.95) {
			candidates.push("memory_exhaustion");
			established.push(`memory reached ${(ratio * 100).toFixed(0)}% of the limit`);
		}
	}

	if (evidence.cold_start) {
		limitations.push(
			"this was a cold start; initialization time is included in the duration and a warm invocation may not reproduce the timing at all",
		);
	}
	if (!evidence.has_stack && !timedOut) {
		limitations.push("the runtime produced no stack trace, so the failing frame is unknown");
	}
	if (candidates.length === 0) candidates.push("application_error");

	return {
		source: "serverless",
		summary: `invocation ${evidence.outcome} after ${evidence.duration_ms}ms`,
		candidate_causes: candidates,
		log_tail: evidence.log_tail,
		limitations,
		established,
		next_evidence: next,
	};
}

export type KernelEvidence = {
	/** e.g. `BUG: kernel NULL pointer dereference`. */
	title: string;
	console_lines: string[];
	/** True when the ring buffer wrapped and the start of the report is gone. */
	ring_buffer_wrapped?: boolean;
	tainted?: string[];
};

/**
 * Normalize kernel evidence.
 *
 * A wrapped ring buffer loses the *beginning*, and the beginning is where the
 * first fault is. A second oops printed after a first will therefore look like
 * the primary failure, which is why the adapter says so rather than leaving it
 * to be noticed.
 */
export function fromKernel(evidence: KernelEvidence): NormalizedEvidence {
	const limitations: string[] = [];
	const established: string[] = [`the kernel reported: ${evidence.title}`];
	const next: string[] = [];

	if (evidence.ring_buffer_wrapped) {
		limitations.push(
			"the console ring buffer wrapped, so the start of the report is gone; a first oops that preceded this one would be invisible and this one would look primary",
		);
		next.push("increase the ring buffer or capture over a serial console, which does not wrap");
	}
	if (evidence.tainted && evidence.tainted.length > 0) {
		limitations.push(
			`the kernel is tainted (${evidence.tainted.join(", ")}); an out-of-tree module can produce a fault whose stack points entirely at in-tree code`,
		);
	}
	limitations.push(
		"a kernel fault has no application context: correlating it to a workload is inference from timing, not observation",
	);

	return {
		source: "kernel",
		summary: evidence.title,
		candidate_causes: ["kernel_fault", "driver_fault", "hardware_fault"],
		log_tail: evidence.console_lines,
		limitations,
		established,
		next_evidence: next,
	};
}

export type GpuEvidence = {
	/** e.g. `CUDA error: an illegal memory access was encountered`. */
	error: string;
	/** Where the error surfaced, which is a synchronization point. */
	reported_at?: string;
	/** Whether the runtime was in asynchronous mode when it happened. */
	asynchronous?: boolean;
	device_index?: number;
	/** ECC error counts, when the driver exposes them. */
	ecc_errors?: number;
};

/**
 * Normalize GPU evidence.
 *
 * The characteristic trap: an asynchronous error is reported at the next
 * synchronization point, so the line in the traceback is where the error was
 * *noticed* and the launch that caused it is somewhere earlier with no link.
 * Every "the bug is in this line" conclusion drawn from an async CUDA error is
 * drawn from the wrong line.
 */
export function fromGpu(evidence: GpuEvidence): NormalizedEvidence {
	const asynchronous = evidence.asynchronous !== false;
	const limitations: string[] = [];
	const established: string[] = [`the device reported: ${evidence.error}`];
	const next: string[] = [];
	const candidates = ["kernel_launch_fault", "memory_violation"];

	if (asynchronous) {
		limitations.push(
			`the error surfaced at a synchronization point${evidence.reported_at ? ` (${evidence.reported_at})` : ""}; that location is where it was noticed, not where it happened, and the offending launch is earlier with no link to it`,
		);
		next.push(
			"re-run with synchronous device execution so the error is raised at the launch that caused it",
		);
	}

	if ((evidence.ecc_errors ?? 0) > 0) {
		candidates.push("hardware_fault");
		established.push(`${evidence.ecc_errors} ECC error(s) on this device`);
		limitations.push(
			"ECC errors and a software memory violation produce similar symptoms; the counter establishes the hardware fault but not that it caused this failure",
		);
	}

	return {
		source: "gpu",
		summary: evidence.error,
		candidate_causes: candidates,
		log_tail: [],
		limitations,
		established,
		next_evidence: next,
	};
}

export type HardwareEvidence = {
	/** e.g. `MCE`, `ECC`, `thermal_throttle`, `disk_smart`. */
	event_type: string;
	component: string;
	count: number;
	at_ms: number;
	details?: string;
};

/**
 * Normalize hardware evidence.
 *
 * Always carries the correlation caveat, because hardware events have no
 * workload context whatsoever and every link to an application failure is an
 * inference from timing. That is sometimes a good inference and it is never an
 * observation.
 */
export function fromHardware(evidence: HardwareEvidence): NormalizedEvidence {
	return {
		source: "hardware",
		summary: `${evidence.count}× ${evidence.event_type} on ${evidence.component}`,
		candidate_causes: ["hardware_fault"],
		log_tail: evidence.details ? [evidence.details] : [],
		limitations: [
			"a hardware event carries no workload context; associating it with an application failure is inference from timing alone",
			"a single event may be corrected and harmless; only a rate establishes a failing component",
		],
		established: [
			`${evidence.count} ${evidence.event_type} event(s) on '${evidence.component}' at ${evidence.at_ms}`,
		],
		next_evidence: [
			"compare the event rate against this component's baseline; an absolute count says nothing on its own",
		],
	};
}

export type EvidenceBundle = {
	items: NormalizedEvidence[];
	/** Every limitation across the bundle, deduplicated. */
	all_limitations: string[];
	/** Union of candidate causes, since no source narrows on its own. */
	candidate_causes: string[];
	/** Sources present, and those absent. */
	present: EvidenceSource[];
	missing: EvidenceSource[];
	caveats: string[];
};

/**
 * Combine evidence from several sources.
 *
 * Deliberately unions the candidate causes rather than intersecting them.
 * Intersecting looks like triangulation and is wrong: these sources observe
 * different layers, and a cause absent from one is usually absent because that
 * layer cannot see it, not because it was ruled out.
 */
export function bundleEvidence(items: NormalizedEvidence[]): EvidenceBundle {
	const present = [...new Set(items.map((i) => i.source))].sort();
	const missing = EVIDENCE_SOURCES.filter((s) => !present.includes(s));

	const caveats: string[] = [];
	if (items.length > 1) {
		caveats.push(
			"candidate causes are unioned, not intersected: these sources observe different layers, and a cause absent from one is usually absent because that layer cannot see it rather than because it was ruled out",
		);
	}
	if (items.some((i) => i.next_evidence.length > 0)) {
		caveats.push(
			"at least one source names evidence that has not been collected; the current candidate set is wider than it needs to be",
		);
	}

	return {
		items,
		all_limitations: [...new Set(items.flatMap((i) => i.limitations))],
		candidate_causes: [...new Set(items.flatMap((i) => i.candidate_causes))].sort(),
		present,
		missing,
		caveats,
	};
}
