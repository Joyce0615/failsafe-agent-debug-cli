/**
 * Automated minimal reproducer extraction across events, artifacts,
 * configuration, and tool results (item 24).
 *
 * Item 70's `reduceTrace` (`trace-reduction.ts`) already does ddmin-style
 * delta debugging over a flat list of trace elements, closed over
 * dependencies, with cause-signature preservation and non-monotonicity
 * detection. That module's own scope statement is one command's trace: it
 * reduces a single `TraceElement[]` list and says nothing about which
 * CATEGORY an element belongs to, whether removing it is something a
 * downstream consumer of the result is even *allowed* to keep (authority),
 * whether what remains still carries data this tool's own privacy policy
 * would never let out (privacy), or whether the full-fidelity causal
 * explanation a diagnosis produced for the original trace still holds for
 * the reduced one (causal explanation).
 *
 * Confirmed by grep: nothing in `src/repro/`, `src/diagnosis/`, or
 * `src/security/` combines `reduceTrace`'s minimization with
 * `validateCommand`'s authority gate, `applyDataPolicy`'s privacy
 * classification, or `rankRootCauses`'s causal ranking. This module adds
 * that combination, delegating every individual check to its existing
 * owner rather than re-deriving any of the three:
 *
 * - **Authority.** `checkReducerAuthority` calls item 60's `validateCommand`
 *   on every candidate command a reduced bundle would need to re-run,
 *   exactly the check `verifyRepro` already performs on a repro candidate —
 *   a reduction is never allowed to accept a smaller bundle that requires
 *   a command the original run's own policy would have refused.
 *
 * - **Privacy.** `checkReducerPrivacy` calls item 62's `applyDataPolicy` on
 *   every string value an element still carries after reduction. A
 *   reduction step is free to DROP an element carrying a secret/PII/prompt
 *   value (that only shrinks the bundle), but is never free to KEEP one
 *   whose value the class policy would drop/hash/redact/truncate without
 *   first applying that exact policy — so the minimized reproducer is
 *   never a vector for exfiltrating more than the original capture policy
 *   already permitted.
 *
 * - **Causal explanation.** `checkCausalExplanationPreserved` reuses item
 *   38's `buildCausalGraph`/`rankRootCauses` unmodified: it reconstructs
 *   the causal ranking for both the original and the reduced bundle's
 *   nodes/edges and requires the SAME top root cause's `node_id` to survive
 *   — not merely that the reduction kept "a" failing element, but that it
 *   kept the one the causal ranking already identified as the explanation.
 *
 * `extractMultiKindRepro` composes all three as acceptance gates layered on
 * top of item 70's own `reduceTrace`, via a wrapped oracle: the oracle this
 * module hands to `reduceTrace` runs the caller-supplied base oracle FIRST
 * (so "does it still fail, and with the same cause_signature" is unchanged
 * from item 70's own contract) and only then runs the three additional
 * gates, rejecting the candidate (as a non-reproducing candidate, so item
 * 70's own retry/granularity logic handles it identically to any other
 * rejection) if any gate fails. No separate reduction search is
 * implemented — this is a gate stacked on the existing search, not a
 * second search.
 *
 * Pure: every check here takes already-computed inputs; nothing reads the
 * filesystem, spawns a process, or reads the network. The caller supplies
 * the base reproduction oracle, command policy, data-class policies, and
 * causal graph builders exactly as `trace-reduction.ts`/`verifier.ts`/
 * `data-classes.ts`/`causal-graph.ts` already require them to.
 */
import {
	type CausalEdge,
	type CausalNode,
	buildCausalGraph,
	rankRootCauses,
} from "../diagnosis/causal-graph.js";
import { type ApplyOptions, applyDataPolicy } from "../security/data-classes.js";
import { type CommandPolicy, validateCommand } from "../security/policy.js";
import {
	type OracleResult,
	type ReductionOptions,
	type ReductionOracle,
	type ReductionResult,
	type TraceElement,
	reduceTrace,
} from "./trace-reduction.js";

// ── Element kinds (the item's four named categories) ──

export type ReproElementKind = "event" | "artifact" | "config" | "tool_result";

/**
 * One piece of evidence the minimal reproducer might keep or drop. Extends
 * item 70's `TraceElement` (same `id`/`depends_on` dependency-closure
 * contract, reused by `closeOverDependencies` through `reduceTrace`) with a
 * `kind` tag and the data this item's authority/privacy/causal gates need.
 */
export type ReproElement = TraceElement & {
	kind: ReproElementKind;
	/**
	 * A command this element requires to be re-runnable (e.g. a tool-result
	 * element whose replay needs its originating command). Absent for an
	 * element that carries no re-executable command of its own.
	 */
	required_command?: string;
	/** Key/value pairs this element carries, checked against the privacy policy. */
	fields?: Record<string, string>;
	/**
	 * Present only for `kind: "event"`: this element's identity in the causal
	 * graph, so causal-explanation preservation can be checked. An event
	 * absent from both `nodes` passed to `checkCausalExplanationPreserved`
	 * is not a causal-graph participant and is exempt from that gate.
	 */
	causal_node_id?: string;
};

// ── 1. Authority gate ──

export type AuthorityViolation = { element_id: string; command: string; reason?: string };

/**
 * Every `required_command` still present in `candidateIds` must pass the
 * SAME `validateCommand` policy item 60's `verifyRepro` already applies to
 * a repro candidate — reused verbatim, not re-implemented, so a reduction
 * can never grant itself authority the original capture never had.
 */
export function checkReducerAuthority(
	elements: ReproElement[],
	candidateIds: ReadonlySet<string>,
	policy: CommandPolicy,
): AuthorityViolation[] {
	const violations: AuthorityViolation[] = [];
	for (const el of elements) {
		if (!candidateIds.has(el.id)) continue;
		if (!el.required_command) continue;
		const result = validateCommand(el.required_command, policy);
		if (!result.allowed) {
			violations.push({
				element_id: el.id,
				command: el.required_command,
				reason: result.reason,
			});
		}
	}
	return violations;
}

// ── 2. Privacy gate ──

export type PrivacyViolation = {
	element_id: string;
	field: string;
	/** What item 62's class policy would have done to this value. */
	required_action: "drop" | "hash" | "redact" | "truncate";
	/** What the candidate bundle actually still carries. */
	kept_value: string;
};

/**
 * Every field still present in `candidateIds` is run through item 62's
 * `applyDataPolicy` (same class policies the capture pipeline itself
 * enforces). `ReproElement.fields` holds exactly the content that would be
 * kept if that element survives the reduction -- a static snapshot, not
 * something this gate itself transforms -- so a field whose policy action
 * is anything other than `allow` is reported as a violation outright: the
 * only way to pass this gate for a field with a non-`allow` action is for
 * whoever assembled `elements` to have already applied `applyDataPolicy`
 * themselves (e.g. storing the hashed/redacted/truncated value, or
 * omitting a dropped field's key entirely) before handing the bundle to
 * `extractMultiKindRepro`.
 */
export function checkReducerPrivacy(
	elements: ReproElement[],
	candidateIds: ReadonlySet<string>,
	opts: ApplyOptions = {},
): PrivacyViolation[] {
	const violations: PrivacyViolation[] = [];
	for (const el of elements) {
		if (!candidateIds.has(el.id)) continue;
		if (!el.fields) continue;
		for (const [field, value] of Object.entries(el.fields)) {
			const result = applyDataPolicy(field, value, opts);
			if (result.action === "allow") continue;
			violations.push({
				element_id: el.id,
				field,
				required_action: result.action as "drop" | "hash" | "redact" | "truncate",
				kept_value: value,
			});
		}
	}
	return violations;
}

// ── 3. Causal-explanation gate ──

export type CausalExplanationCheck = {
	preserved: boolean;
	original_root_cause?: string;
	candidate_root_cause?: string;
	reason: string;
};

/**
 * Rebuild item 38's causal ranking for the full node/edge set and for the
 * subset induced by `candidateIds`, and require the SAME top root cause
 * `node_id` in both. `rankRootCauses`/`buildCausalGraph` are reused
 * unmodified: this function only decides what counts as "the same
 * explanation", not how root causes are ranked.
 *
 * Nodes/edges whose node is not present in `candidateIds` are simply
 * excluded from the candidate graph (status/edges to an excluded node are
 * dropped), mirroring how a reduced trace naturally loses the nodes its
 * removed elements represented.
 */
export function checkCausalExplanationPreserved(
	nodes: CausalNode[],
	edges: CausalEdge[],
	candidateIds: ReadonlySet<string>,
): CausalExplanationCheck {
	const originalGraph = buildCausalGraph(nodes, edges);
	const originalRanking = rankRootCauses(originalGraph);
	const originalTop = originalRanking.root_causes[0]?.node_id;

	if (originalTop === undefined) {
		return {
			preserved: true,
			reason: "the original graph has no identifiable root cause to preserve",
		};
	}

	const candidateNodes = nodes.filter((n) => candidateIds.has(n.id));
	const candidateEdges = edges.filter((e) => candidateIds.has(e.from) && candidateIds.has(e.to));
	const candidateGraph = buildCausalGraph(candidateNodes, candidateEdges);
	const candidateRanking = rankRootCauses(candidateGraph);
	const candidateTop = candidateRanking.root_causes[0]?.node_id;

	if (candidateTop === originalTop) {
		return {
			preserved: true,
			original_root_cause: originalTop,
			candidate_root_cause: candidateTop,
			reason: "the candidate's top-ranked root cause matches the original",
		};
	}
	return {
		preserved: false,
		original_root_cause: originalTop,
		candidate_root_cause: candidateTop,
		reason:
			candidateTop === undefined
				? `the original root cause '${originalTop}' was removed and no root cause remains in the candidate`
				: `the original root cause '${originalTop}' was removed and the candidate's top root cause is now '${candidateTop}' -- a different explanation, not a smaller version of the same one`,
	};
}

// ── Composition: wrap the base oracle with all three gates ──

export type MultiKindReductionOptions = ReductionOptions & {
	command_policy: CommandPolicy;
	privacy_options?: ApplyOptions;
	/** Full node/edge set for causal-explanation preservation. Omit to skip that gate. */
	causal_nodes?: CausalNode[];
	causal_edges?: CausalEdge[];
};

export type GateRejection =
	| { gate: "authority"; violations: AuthorityViolation[] }
	| { gate: "privacy"; violations: PrivacyViolation[] }
	| { gate: "causal_explanation"; check: CausalExplanationCheck };

export type MultiKindReductionResult = ReductionResult & {
	/** Every candidate rejected by one of this item's three gates during the search, in rejection order. */
	gate_rejections: GateRejection[];
};

/**
 * Reduce a multi-kind (event/artifact/config/tool_result) failure bundle,
 * layering the authority/privacy/causal-explanation gates on top of item
 * 70's own `reduceTrace` search via a wrapped oracle. The base oracle's
 * `reproduces`/`cause_signature` contract is unchanged; a candidate that
 * would otherwise be accepted by the base oracle is instead rejected
 * (`reproduces: false`) if it fails any of the three gates, so item 70's
 * existing granularity/retry/non-monotonicity logic treats a gate failure
 * exactly like any other non-reproducing candidate — no second search.
 */
export async function extractMultiKindRepro(
	elements: ReproElement[],
	baseOracle: ReductionOracle,
	options: MultiKindReductionOptions,
): Promise<MultiKindReductionResult> {
	const gateRejections: GateRejection[] = [];

	const wrappedOracle: ReductionOracle = async (elementIds: string[]) => {
		const base = await baseOracle(elementIds);
		if (!base.reproduces) return base;

		// The baseline call (the full, untouched element set) establishes the
		// original failure and its cause_signature; it is the evidence being
		// investigated, not a reduction candidate, so the gates below -- which
		// exist to keep a *reduced* bundle honest -- never reject it. Only a
		// genuinely smaller candidate is gated.
		if (elementIds.length >= elements.length) return base;

		const candidateIds = new Set(elementIds);

		const authorityViolations = checkReducerAuthority(
			elements,
			candidateIds,
			options.command_policy,
		);
		if (authorityViolations.length > 0) {
			gateRejections.push({ gate: "authority", violations: authorityViolations });
			return { reproduces: false } satisfies OracleResult;
		}

		const privacyViolations = checkReducerPrivacy(elements, candidateIds, options.privacy_options);
		if (privacyViolations.length > 0) {
			gateRejections.push({ gate: "privacy", violations: privacyViolations });
			return { reproduces: false } satisfies OracleResult;
		}

		if (options.causal_nodes !== undefined) {
			const check = checkCausalExplanationPreserved(
				options.causal_nodes,
				options.causal_edges ?? [],
				candidateIds,
			);
			if (!check.preserved) {
				gateRejections.push({ gate: "causal_explanation", check });
				return { reproduces: false } satisfies OracleResult;
			}
		}

		return base;
	};

	const result = await reduceTrace(elements, wrappedOracle, options);
	return { ...result, gate_rejections: gateRejections };
}

/** Human-readable summary of why gated candidates were rejected, grouped by gate. */
export function renderGateRejections(rejections: GateRejection[]): string[] {
	return rejections.map((r) => {
		if (r.gate === "authority") {
			return `authority: ${r.violations
				.map((v) => `'${v.element_id}' requires '${v.command}' (${v.reason ?? "not permitted"})`)
				.join("; ")}`;
		}
		if (r.gate === "privacy") {
			return `privacy: ${r.violations
				.map((v) => `'${v.element_id}.${v.field}' must be ${v.required_action}ped, not kept raw`)
				.join("; ")}`;
		}
		return `causal_explanation: ${r.check.reason}`;
	});
}
