import type { CommandPolicy } from "../security/policy.js";
import { validateCommand } from "../security/policy.js";
/**
 * Failure-anchored structured recovery packets (item 100).
 *
 * `causal-graph.ts` (item 38) already ranks root causes earliest-first with
 * an evidence path; `ranking.ts` (item 60) already distinguishes a decisive
 * diagnosis from an indecisive one (minimum leader confidence + minimum
 * margin); `security/policy.ts` already enforces a fixed command allow-list.
 * None of the three are composed: nothing in this repo anchors a proposed
 * recovery to ONE specific, decisively-identified failure (as opposed to a
 * ranked list a caller must itself interpret), preserves that failure's
 * causal evidence unmutated alongside the proposal, bounds a recovery
 * action against the *existing* allow-list rather than quietly growing it,
 * or measures whether a rerun actually improved without that improvement
 * being an artifact of granting the agent new capability mid-investigation.
 *
 * Four pieces, each independently testable:
 *
 * 1. **Extract the first decisive failure.** `causal-graph.ts`'s
 *    `rankRootCauses` already sorts roots earliest-first (`score`), so
 *    "first" falls out of that ordering for free. "Decisive" does not:
 *    a root with no correlated causal edges at all (the ranking's own
 *    `uncertainty` already flags this) or a field of multiple INDEPENDENT
 *    failure chains (also already flagged) is not a sound anchor for a
 *    recovery proposal, even though `rankRootCauses` still returns a
 *    top-of-list candidate in both cases — a ranking with no confident
 *    leader is not the same thing as no ranking at all, and treating them
 *    the same would propose confident-sounding recovery for a diagnosis
 *    that was never confident. `extractFirstDecisiveFailure` reads exactly
 *    those two existing uncertainty signals rather than re-deriving a third
 *    decisiveness heuristic, and refuses when either fires.
 *
 * 2. **Preserve causal evidence.** `RootCause.evidence_path` is the exact
 *    node-id chain `causal-graph.ts` already computed from root to deepest
 *    failed symptom. `preserveCausalEvidence` takes an immutable snapshot
 *    (`Object.freeze` on a copy, never the original array) so a caller that
 *    later mutates its own working copy of the ranking cannot retroactively
 *    change what evidence a packet says it was built from — the packet's
 *    evidence is what it was built from, permanently.
 *
 * 3. **Propose bounded recovery.** A `RecoveryAction` is either a `command`
 *    (validated against the *current* `CommandPolicy` via `policy.ts`'s own
 *    `validateCommand` — not a new or widened allow-list check) or a
 *    `patch` (bounded by line count, since a patch has no allow-list to
 *    check against but is unbounded in a different dimension — an
 *    unreviewable, arbitrarily large diff is its own kind of unbounded
 *    authority). `proposeBoundedRecovery` refuses to propose ANYTHING when
 *    the failure was not decisive (step 1): a recovery action anchored to
 *    an ambiguous diagnosis is not "bounded", it is a guess with a policy
 *    check bolted on.
 *
 * 4. **Measure whether a rerun improved, without expanding tool authority.**
 *    `measureRerunImprovement` compares a policy snapshot and a set of rerun
 *    outcomes from before a recovery attempt against the same from after.
 *    If `policyAfter`'s allow-list is not a subset of `policyBefore`'s, the
 *    measurement is marked `tainted` regardless of how much the pass rate
 *    improved — an improvement purchased by granting the agent a new
 *    command mid-investigation is not evidence the proposed recovery
 *    itself worked, it is evidence the goalposts moved. This is the same
 *    discipline `durable-loop.ts`'s crash-recovery contract already applies
 *    to recovery EFFECTS (never guess, never silently reinterpret); here it
 *    is applied to the MEASUREMENT of whether recovery worked.
 *
 * Pure: no fs/network/process/clock. Rerun outcomes and policy snapshots are
 * supplied by the caller (typically the result of `operations.ts`'s
 * `verifyFailure`/`durable-loop.ts`'s rerun phase and `loadPolicy`).
 */
import type { CausalRanking, RootCause } from "./causal-graph.js";

// ── 1. Extract the first decisive failure ──

export type DecisiveFailureResult =
	| { decisive: true; failure: RootCause }
	| { decisive: false; reason: string; candidates: RootCause[] };

const NO_EDGES_MARKER = "has no correlated causal edges";
const INDEPENDENT_CHAINS_MARKER = "independent failure chains detected";

/**
 * The earliest root cause `causal-graph.ts`'s own ranking already orders
 * first — but only when that ranking's own uncertainty signals do not
 * already say the diagnosis is unsound. Refuses (does not guess) when:
 *   - there is no root cause at all;
 *   - the top-ranked root has no correlated causal evidence of its own
 *     (isolated, flagged by `rankRootCauses` itself); or
 *   - the ranking reports multiple independent failure chains, meaning the
 *     "first" root is not even the SOLE explanation on offer.
 */
export function extractFirstDecisiveFailure(ranking: CausalRanking): DecisiveFailureResult {
	if (ranking.root_causes.length === 0) {
		return {
			decisive: false,
			reason: "no root cause was identified; there is nothing to anchor a recovery to",
			candidates: [],
		};
	}
	const top = ranking.root_causes[0];
	const topIsIsolated = ranking.uncertainty.some(
		(u) => u.includes(`'${top.node_id}'`) && u.includes(NO_EDGES_MARKER),
	);
	if (topIsIsolated) {
		return {
			decisive: false,
			reason: `top-ranked failure '${top.node_id}' has no correlated causal evidence; a recovery proposal would have nothing to preserve as evidence`,
			candidates: ranking.root_causes,
		};
	}
	const independentChains = ranking.uncertainty.some((u) => u.includes(INDEPENDENT_CHAINS_MARKER));
	if (independentChains) {
		return {
			decisive: false,
			reason:
				"multiple independent failure chains were detected; the top-ranked failure is not the sole explanation",
			candidates: ranking.root_causes,
		};
	}
	return { decisive: true, failure: top };
}

// ── 2. Preserve causal evidence ──

export type CausalEvidenceSnapshot = {
	root_node_id: string;
	/** Immutable copy of `RootCause.evidence_path` at the moment of capture. */
	evidence_path: readonly string[];
	downstream_failures: number;
};

/**
 * Take an immutable snapshot of a decisive failure's causal evidence. The
 * returned `evidence_path` is a frozen copy, never the original array, so a
 * caller mutating its own working copy of the ranking cannot retroactively
 * change what evidence a packet says it was built from.
 */
export function preserveCausalEvidence(failure: RootCause): CausalEvidenceSnapshot {
	return {
		root_node_id: failure.node_id,
		evidence_path: Object.freeze([...failure.evidence_path]),
		downstream_failures: failure.downstream_failures,
	};
}

// ── 3. Propose bounded recovery ──

export type RecoveryAction =
	| { kind: "command"; command: string; rationale: string }
	| { kind: "patch"; diff: string; rationale: string };

export type RejectedRecoveryAction = {
	action: RecoveryAction;
	reason: string;
};

export type BoundedRecoveryResult = {
	accepted: RecoveryAction[];
	rejected: RejectedRecoveryAction[];
};

/** Default ceiling on a proposed patch's line count (see module docstring §3). */
export const DEFAULT_MAX_PATCH_LINES = 200;

/**
 * Filter candidate recovery actions down to ones that are bounded by what
 * ALREADY exists, never by what this call grants:
 *   - `command` actions must already pass `policy.ts`'s own
 *     `validateCommand` against the supplied (unmodified) `CommandPolicy`.
 *     A command this policy does not already allow is rejected, never
 *     auto-added to the allow-list to make it pass.
 *   - `patch` actions must not exceed `maxPatchLines`, since a patch has no
 *     allow-list to check and is instead bounded by review-ability.
 *
 * Refuses to propose anything at all when `failure` was not decisive: a
 * recovery action anchored to an ambiguous diagnosis is a guess with a
 * policy check bolted on, not a bounded proposal.
 */
export function proposeBoundedRecovery(
	failure: DecisiveFailureResult,
	actions: RecoveryAction[],
	policy: CommandPolicy,
	opts: { maxPatchLines?: number } = {},
): BoundedRecoveryResult {
	if (!failure.decisive) {
		return {
			accepted: [],
			rejected: actions.map((action) => ({
				action,
				reason: `no decisive failure to anchor recovery to: ${failure.reason}`,
			})),
		};
	}
	const maxPatchLines = opts.maxPatchLines ?? DEFAULT_MAX_PATCH_LINES;
	const accepted: RecoveryAction[] = [];
	const rejected: RejectedRecoveryAction[] = [];
	for (const action of actions) {
		if (action.kind === "command") {
			const check = validateCommand(action.command, policy);
			if (check.allowed) {
				accepted.push(action);
			} else {
				rejected.push({
					action,
					reason: `not permitted by the existing command policy (would require expanding tool authority to run this): ${check.reason}`,
				});
			}
			continue;
		}
		const lineCount = action.diff.split("\n").length;
		if (lineCount <= maxPatchLines) {
			accepted.push(action);
		} else {
			rejected.push({
				action,
				reason: `patch has ${lineCount} lines, exceeding the ${maxPatchLines}-line bounded-recovery limit`,
			});
		}
	}
	return { accepted, rejected };
}

// ── 4. Measure rerun improvement without expanding tool authority ──

export type RerunOutcome = "passed" | "failed" | "timeout" | "error";

export type RerunImprovementReport = {
	before_pass_rate: number;
	after_pass_rate: number;
	improved: boolean;
	/**
	 * True iff `policyAfter`'s allow-list is not a subset of
	 * `policyBefore`'s — the agent was granted a new command between the two
	 * rerun batches.
	 */
	authority_expanded: boolean;
	/** The specific commands added, if any (empty when `authority_expanded` is false). */
	newly_allowed_commands: string[];
	/**
	 * True iff the measurement is trustworthy: not tainted by an authority
	 * expansion. An apparent improvement measured while `authority_expanded`
	 * is true is NOT evidence the proposed recovery worked.
	 */
	valid: boolean;
};

function passRate(outcomes: RerunOutcome[]): number {
	if (outcomes.length === 0) return 0;
	return outcomes.filter((o) => o === "passed").length / outcomes.length;
}

/**
 * Compare rerun outcomes before/after a recovery attempt, and the command
 * policy in force at each point. An apparent improvement is reported
 * (`improved`) independently of whether it is trustworthy (`valid`) — both
 * fields are always populated, because "it looks better, but we can't trust
 * why" is the fact a reader is most likely to need and the easiest to
 * collapse into a single misleading boolean.
 */
export function measureRerunImprovement(params: {
	policyBefore: CommandPolicy;
	policyAfter: CommandPolicy;
	rerunsBefore: RerunOutcome[];
	rerunsAfter: RerunOutcome[];
}): RerunImprovementReport {
	const beforeSet = new Set(params.policyBefore.allow_commands);
	const newlyAllowed = params.policyAfter.allow_commands.filter((c) => !beforeSet.has(c));
	const authorityExpanded = newlyAllowed.length > 0;

	const beforeRate = passRate(params.rerunsBefore);
	const afterRate = passRate(params.rerunsAfter);

	return {
		before_pass_rate: beforeRate,
		after_pass_rate: afterRate,
		improved: afterRate > beforeRate,
		authority_expanded: authorityExpanded,
		newly_allowed_commands: newlyAllowed,
		valid: !authorityExpanded,
	};
}

// ── Compose: the structured recovery packet ──

export type RecoveryPacket = {
	failure: DecisiveFailureResult;
	causal_evidence?: CausalEvidenceSnapshot;
	recovery: BoundedRecoveryResult;
	improvement?: RerunImprovementReport;
};

export type BuildRecoveryPacketOptions = {
	maxPatchLines?: number;
	improvement?: Parameters<typeof measureRerunImprovement>[0];
};

/**
 * Compose the full packet: extract the first decisive failure, preserve its
 * causal evidence, propose bounded recovery anchored to it, and (when a
 * before/after rerun comparison is supplied) measure whether the attempt
 * improved without expanding tool authority.
 */
export function buildRecoveryPacket(
	ranking: CausalRanking,
	actions: RecoveryAction[],
	policy: CommandPolicy,
	opts: BuildRecoveryPacketOptions = {},
): RecoveryPacket {
	const failure = extractFirstDecisiveFailure(ranking);
	const recovery = proposeBoundedRecovery(failure, actions, policy, {
		maxPatchLines: opts.maxPatchLines,
	});
	const packet: RecoveryPacket = {
		failure,
		recovery,
		...(failure.decisive ? { causal_evidence: preserveCausalEvidence(failure.failure) } : {}),
	};
	if (opts.improvement) {
		packet.improvement = measureRerunImprovement(opts.improvement);
	}
	return packet;
}

/** Render a packet for an agent/operator. Honest about indecision and taint. */
export function renderRecoveryPacket(packet: RecoveryPacket): string {
	const lines: string[] = [];
	if (packet.failure.decisive) {
		lines.push(
			`decisive failure: ${packet.failure.failure.node_id} — ${packet.failure.failure.message ?? ""}`.trim(),
		);
		if (packet.causal_evidence) {
			lines.push(`evidence path: ${packet.causal_evidence.evidence_path.join(" -> ")}`);
		}
	} else {
		lines.push(`NOT decisive: ${packet.failure.reason}`);
	}
	if (packet.recovery.accepted.length === 0) {
		lines.push("proposed recovery: none");
	} else {
		lines.push("proposed recovery (bounded):");
		for (const action of packet.recovery.accepted) {
			lines.push(
				action.kind === "command"
					? `  command: ${action.command} — ${action.rationale}`
					: `  patch (${action.diff.split("\n").length} lines) — ${action.rationale}`,
			);
		}
	}
	for (const r of packet.recovery.rejected) {
		lines.push(`  REJECTED: ${r.reason}`);
	}
	if (packet.improvement) {
		const imp = packet.improvement;
		lines.push(
			`rerun: ${imp.before_pass_rate} -> ${imp.after_pass_rate} (${imp.improved ? "improved" : "no improvement"})`,
		);
		lines.push(
			imp.valid
				? "measurement valid: tool authority was not expanded between reruns"
				: `measurement TAINTED: tool authority expanded (${imp.newly_allowed_commands.join(", ")}); improvement is not trustworthy`,
		);
	}
	return lines.join("\n");
}
