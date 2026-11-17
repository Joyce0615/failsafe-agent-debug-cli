/**
 * Attribute programmatic tool-calling failures, and reduce a failing
 * programmatic-tool-calling run without letting the reduction expand which
 * capabilities the result exercises (item 43, module-header numbering:
 * item 109, confirmed next-free via `grep -rohE "item [0-9]+" src
 * --include="*.ts" | sort -t' ' -k2 -n -u`, highest prior being item 108
 * from item 42's `nested-agent-operations.ts`).
 *
 * "Programmatic tool calling" names the pattern where an agent writes or
 * generates CODE that calls one or more tools through a generated
 * proxy/SDK wrapper, instead of issuing one structured tool-call message a
 * host interprets directly (the one-hop shape `execute-tool.md`'s
 * `gen_ai.execute_tool` span and `telemetry/mcp-conventions.ts`'s
 * `tools/call` server span already describe). `grep -rln
 * "programmatic|proxy.*tool|generated.code|code.mode" src --include="*.ts"`
 * before this module matched only `security/sandbox.ts`'s and
 * `telemetry/otel.ts`'s unrelated uses of the word "proxy" (a
 * network-isolation mechanism, and a comment about the OTel API's own
 * global tracer proxy) — nothing in this codebase separates WHERE in that
 * extra layer a failure actually originated, and nothing reduces a failing
 * programmatic run while checking that the reduction did not accidentally
 * widen which tools/scopes the reduced candidate exercises.
 *
 * Seven named causes, exactly matching the item's own wording, laid out in
 * the pipeline order a programmatic tool call actually executes in (used
 * below to pick a single PRIMARY cause when more than one is present,
 * mirroring `capability-drift.ts`'s own "name the more direct explanation
 * first" discipline rather than inventing a severity score):
 *
 *   environment -> generated_code -> proxy -> schema -> sandbox -> tool
 *
 * - `environment`: the ambient runtime the generated code was meant to run
 *   in was wrong or incomplete (missing dependency, version skew) — nothing
 *   was blocked by policy, something needed was simply absent.
 * - `generated_code`: the agent's own generated code raised before issuing
 *   any tool call at all.
 * - `proxy`: the generated proxy/SDK wrapper function failed to translate
 *   the code's call into an actual tool invocation (argument marshalling,
 *   wrong wrapper generated against a stale contract) — the call never left
 *   the process.
 * - `schema`: the call (or its result) that DID leave the process violated
 *   the tool's own declared input/output schema — reusing
 *   `capability-drift.ts`'s `schema_hash` vocabulary for "the contract this
 *   call was shaped for is not the one now in force".
 * - `sandbox`: `security/sandbox.ts`'s own named enforcement (network
 *   denial, filesystem denial, or a resource-limit termination per its
 *   `describeEnforcement`/`terminationPlan`) stopped the attempt per a
 *   documented policy decision.
 * - `tool`: the downstream tool itself ran, past every earlier stage, and
 *   failed on its own.
 * - `cancellation`: an EXTERNAL cancel (operator/orchestrator/`AbortSignal`,
 *   the same best-effort hint `debug/dap-client.ts`'s own `cancel()`
 *   describes) interrupted the run before it reached a conclusive outcome.
 *   Deliberately NOT the same bucket as a sandbox resource-limit kill: a
 *   sandbox kill is this codebase's own named, documented policy decision
 *   (`sandbox`), while an external cancel is someone else's decision this
 *   module has no policy opinion about.
 *
 * `cancellation` is handled as the pipeline's exception rather than a slot
 * in it: when it is the ONLY evidence present, it IS the attributed cause
 * (the run never reached far enough for any other evidence to exist). When
 * ANY pipeline-stage evidence is ALSO present, that evidence is reported as
 * the primary cause instead and the cancellation is downgraded to a caveat
 * — a run that is conclusively known to have failed at `generated_code`
 * before being cancelled was never going to need the cancellation as an
 * explanation, and reporting both as co-equal causes would blend two facts
 * (why it failed, and that it was also stopped) the item's own wording asks
 * to keep separate.
 *
 * The reduction half reuses `repro/trace-reduction.ts`'s `reduceTrace`
 * (item 70) UNMODIFIED, via the exact wrapped-oracle pattern
 * `repro/authority-privacy-reduction.ts` (item 24) already established for
 * its own authority/privacy/causal-explanation gates — this module adds
 * exactly one more gate, capability expansion, rather than re-implementing
 * ddmin. The gate is NOT a dependency-closure check (removal alone cannot
 * invent a new tool call — `closeOverDependencies` only ever shrinks the
 * kept set): the real risk is that RE-EXECUTING a reduced candidate program
 * can follow a genuinely different code path than the original failing
 * run's recorded trace (e.g. removing a guard clause reveals an error-
 * handling branch that calls a more-privileged tool the original run never
 * touched), which is exactly `capability-drift.ts`'s own
 * `unexpectedly_expanded` finding, now applied to a REDUCTION's candidate
 * instead of a catalog poll. Because this can only be known by actually
 * observing what a candidate run did, `ProgramOracleResult` extends item
 * 70's own `OracleResult` with a `capabilities_used` field the caller's
 * harness must report; an oracle that cannot observe this for a given call
 * is treated as "absence of OBSERVATION", not "absence of expansion", and
 * that candidate is rejected rather than trusted.
 *
 * Pure: both halves take already-computed inputs or an injected oracle;
 * nothing here spawns a process, reads a file, or reads the network.
 */
import {
	type OracleResult,
	type ReductionOptions,
	type ReductionOracle,
	type ReductionResult,
	type TraceElement,
	reduceTrace,
} from "../repro/trace-reduction.js";

// ── 1. Attribution ──

export const PROGRAMMATIC_FAILURE_CAUSES = [
	"environment",
	"generated_code",
	"proxy",
	"schema",
	"sandbox",
	"tool",
	"cancellation",
] as const;
export type ProgrammaticFailureCause = (typeof PROGRAMMATIC_FAILURE_CAUSES)[number];

export type ProgrammaticRunEvidence = {
	environment_mismatch?: { detail: string };
	code_exception?: { error_type: string; message: string };
	proxy_error?: { tool_name: string; message: string };
	schema_violation?: {
		tool_name: string;
		expected_schema_hash?: string;
		actual_schema_hash?: string;
		detail: string;
	};
	sandbox_denial?: {
		kind: "network" | "filesystem" | "resource_limit";
		detail: string;
	};
	tool_error?: { tool_name: string; error_type?: string; message: string };
	/**
	 * An EXTERNAL cancel only. A sandbox resource-limit kill is
	 * `sandbox_denial` with `kind: "resource_limit"` instead — see this
	 * module's own header for why the two are never the same bucket.
	 */
	cancelled?: { reason: string };
};

export type ProgrammaticFailureFinding = {
	cause: ProgrammaticFailureCause;
	detail: string;
};

export type ProgrammaticFailureAttribution = {
	/** Every cause with evidence present, in pipeline order. */
	findings: ProgrammaticFailureFinding[];
	/** The single earliest-pipeline-stage cause. `null` only when no evidence field was supplied at all. */
	primary_cause: ProgrammaticFailureCause | null;
	caveats: string[];
};

/** Earliest-stage evidence is the most informative root cause, mirroring `diagnosis/causal-graph.ts`'s own "earliest explanatory" ranking. `cancellation` is deliberately absent — see the module header. */
const PIPELINE_ORDER: readonly ProgrammaticFailureCause[] = [
	"environment",
	"generated_code",
	"proxy",
	"schema",
	"sandbox",
	"tool",
];

/**
 * Attribute a programmatic tool-calling failure to exactly one of the seven
 * named causes, from whichever evidence fields the caller supplies. Every
 * supplied field produces its own finding (nothing is ever silently
 * dropped); `primary_cause` picks the single earliest-pipeline-stage
 * finding per this module's documented precedence, and any evidence it did
 * not pick is named in a caveat rather than discarded.
 */
export function attributeProgrammaticFailure(
	evidence: ProgrammaticRunEvidence,
): ProgrammaticFailureAttribution {
	const findings: ProgrammaticFailureFinding[] = [];

	if (evidence.environment_mismatch) {
		findings.push({ cause: "environment", detail: evidence.environment_mismatch.detail });
	}
	if (evidence.code_exception) {
		findings.push({
			cause: "generated_code",
			detail: `the generated code raised ${evidence.code_exception.error_type}: ${evidence.code_exception.message}`,
		});
	}
	if (evidence.proxy_error) {
		findings.push({
			cause: "proxy",
			detail: `the generated proxy for tool '${evidence.proxy_error.tool_name}' failed to translate the call: ${evidence.proxy_error.message}`,
		});
	}
	if (evidence.schema_violation) {
		findings.push({
			cause: "schema",
			detail: `tool '${evidence.schema_violation.tool_name}' call violated its declared schema: ${evidence.schema_violation.detail}`,
		});
	}
	if (evidence.sandbox_denial) {
		findings.push({
			cause: "sandbox",
			detail: `sandbox ${evidence.sandbox_denial.kind} policy denied the attempt: ${evidence.sandbox_denial.detail}`,
		});
	}
	if (evidence.tool_error) {
		findings.push({
			cause: "tool",
			detail: `tool '${evidence.tool_error.tool_name}' itself failed${
				evidence.tool_error.error_type ? ` (${evidence.tool_error.error_type})` : ""
			}: ${evidence.tool_error.message}`,
		});
	}
	if (evidence.cancelled) {
		findings.push({
			cause: "cancellation",
			detail: `the run was cancelled: ${evidence.cancelled.reason}`,
		});
	}

	const pipelineFindings = findings.filter((f) => f.cause !== "cancellation");
	const cancellationFinding = findings.find((f) => f.cause === "cancellation");
	const caveats: string[] = [];

	let primary: ProgrammaticFailureCause | null = null;
	if (pipelineFindings.length > 0) {
		primary = PIPELINE_ORDER.find((c) => pipelineFindings.some((f) => f.cause === c)) ?? null;
		if (cancellationFinding) {
			caveats.push(
				`the run was also cancelled (${evidence.cancelled?.reason}), but earlier pipeline evidence already explains the failure and is reported as the primary cause instead`,
			);
		}
	} else if (cancellationFinding) {
		primary = "cancellation";
	}

	if (findings.length === 0) {
		caveats.push(
			"no evidence field was supplied; the failure cannot be attributed to any of the seven named causes",
		);
	} else if (pipelineFindings.length > 1 && primary !== null) {
		const superseded = pipelineFindings.filter((f) => f.cause !== primary).map((f) => f.cause);
		caveats.push(
			`evidence was also present for ${superseded.join(", ")}; only the earliest pipeline stage ('${primary}') is reported as the primary cause, per this module's documented pipeline-order precedence`,
		);
	}

	return { findings, primary_cause: primary, caveats };
}

/** Render a human-readable summary of an attribution. */
export function renderProgrammaticFailureAttribution(
	attribution: ProgrammaticFailureAttribution,
): string {
	const lines: string[] = ["# Programmatic Tool-Calling Failure Attribution", ""];
	lines.push(`Primary cause: ${attribution.primary_cause ?? "indeterminate"}`, "");
	lines.push("## Findings", "");
	if (attribution.findings.length === 0) {
		lines.push("No evidence supplied.");
	} else {
		for (const f of attribution.findings) {
			lines.push(`- [${f.cause}] ${f.detail}`);
		}
	}
	if (attribution.caveats.length > 0) {
		lines.push("", "## Caveats", "");
		for (const c of attribution.caveats) lines.push(`- ${c}`);
	}
	return lines.join("\n");
}

// ── 2. Capability-preserving reduction ──

export type ProgramCapability = { tool_name: string; policy_scope?: string[] };

function capabilityKey(cap: ProgramCapability): string {
	return `${cap.tool_name}::${[...(cap.policy_scope ?? [])].sort().join(",")}`;
}

/**
 * Item 70's `OracleResult` plus the capability set a candidate run ACTUALLY
 * exercised. `undefined` (not an empty array) means the harness could not
 * observe this for the call — absence of observation, never treated as
 * absence of expansion.
 */
export type ProgramOracleResult = OracleResult & {
	capabilities_used?: ProgramCapability[];
};

export type ProgramReductionOracle = (
	elementIds: string[],
) => Promise<ProgramOracleResult> | ProgramOracleResult;

export type CapabilityExpansionRejection =
	| { kind: "expanded"; removed: string[]; expanded_capabilities: string[] }
	| { kind: "unobserved"; removed: string[] };

export type ProgramReductionResult = ReductionResult & {
	/** Every candidate rejected for expanding (or failing to report) capabilities, in rejection order. */
	capability_expansion_rejections: CapabilityExpansionRejection[];
	/**
	 * The capability set established by the ORIGINAL (full, unablated) run.
	 * Empty when the full run reported no capabilities, or could not report
	 * any — conservative by construction, since nothing can be verified to
	 * have been used originally.
	 */
	baseline_capabilities: ProgramCapability[];
};

/**
 * Reduce a failing programmatic-tool-calling run while rejecting any
 * candidate whose RE-EXECUTION exercises a capability (tool name + policy
 * scope) the original full run did not. Delegates the entire ddmin search
 * to item 70's own `reduceTrace`, unmodified, via a wrapped oracle — the
 * same composition pattern item 24's `extractMultiKindRepro` already uses
 * for its own authority/privacy/causal-explanation gates.
 */
export async function reduceProgrammaticProgram(
	elements: TraceElement[],
	oracle: ProgramReductionOracle,
	options: ReductionOptions = {},
): Promise<ProgramReductionResult> {
	const rejections: CapabilityExpansionRejection[] = [];
	let baseline: Set<string> | null = null;
	let baselineCapabilities: ProgramCapability[] = [];

	const wrapped: ReductionOracle = async (elementIds) => {
		const result = await oracle(elementIds);
		if (!result.reproduces) return result;

		const isFullRun = elementIds.length >= elements.length;
		const removed = elements.filter((e) => !elementIds.includes(e.id)).map((e) => e.id);

		if (isFullRun) {
			baselineCapabilities = result.capabilities_used ?? [];
			baseline = new Set(baselineCapabilities.map(capabilityKey));
			return result;
		}

		if (result.capabilities_used === undefined) {
			rejections.push({ kind: "unobserved", removed });
			return { reproduces: false } satisfies OracleResult;
		}

		const expanded = [
			...new Set(
				result.capabilities_used.map(capabilityKey).filter((k) => !(baseline?.has(k) ?? false)),
			),
		];
		if (expanded.length > 0) {
			rejections.push({ kind: "expanded", removed, expanded_capabilities: expanded });
			return { reproduces: false } satisfies OracleResult;
		}

		return result;
	};

	const result = await reduceTrace(elements, wrapped, options);
	return {
		...result,
		capability_expansion_rejections: rejections,
		baseline_capabilities: baselineCapabilities,
	};
}
