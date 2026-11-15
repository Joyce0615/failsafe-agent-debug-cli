/**
 * Diagnose nested agent-operation failures (item 42, item 108 in this
 * project's own module-header numbering convention — confirmed as the next
 * free number via `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t'
 * ' -k2 -n -u`, highest prior use was item 107 from item 41's
 * `diagnosis/evaluation-evidence.ts`).
 *
 * Item 57's `trace/genai-normalize.ts` already turns a batch of raw spans
 * into one `GenAiSpan` model and already reports a *structural* issue when a
 * child's kind sits under an unexpected parent kind, or when a declared
 * parent id is simply absent from the batch (`validateGenAiStructure`'s
 * "partial trace" problem). What it does not do — confirmed by grep for
 * `duplicate_recording|lost_parent|misattributed|authority_drift` across
 * `src` before this module, which matched nothing — is reconstruct the
 * actual nesting TREE and ask the four questions this item names: did the
 * same operation get recorded twice, did a span's true parent go missing
 * (as opposed to merely being under an unusual parent KIND), whose usage
 * does a span's cost actually belong to once the tree is built, and did a
 * nested agent silently assume authority its declared ancestor never gave
 * it.
 *
 * Two things this module reuses unmodified rather than re-deriving:
 *
 * - `GenAiSpan`, `normalizeGenAiSpan`, `GenAiKind` from
 *   `trace/genai-normalize.ts`. This module's input is already-normalized
 *   spans; it does no alias resolution of its own.
 * - `GenAiSpan.operation`, which `normalizeGenAiSpan` populates verbatim
 *   even when the operation is not in `OPERATION_TO_KIND` (the span's
 *   `kind` becomes `"unknown"` with a reason, but `operation` still carries
 *   the raw string). The current OpenTelemetry GenAI conventions publish
 *   `retrieval`, `invoke_workflow`, `invoke_runner`, and six `*_memory`/
 *   `*_memory_store` operation names that `OPERATION_TO_KIND` does not map
 *   (checked directly: `"retrieval" in OPERATION_TO_KIND` is `false`) — this
 *   item explicitly asks for retrieval and memory nesting, so
 *   `classifyNestedRole` recognizes those operations itself, reading the
 *   string `genai-normalize.ts` already preserved, rather than widening that
 *   module's own `GenAiKind` enum (which several other modules already
 *   depend on as an exhaustive `Record<GenAiKind, ...>`) for a need that is
 *   local to nesting reconstruction.
 *
 * Four findings, each a distinct question with a distinct answer:
 *
 * 1. **Lost parent.** `buildNestedTree` groups orphaned spans (a declared
 *    `parent_span_id` that is not present in this batch) BY the missing
 *    parent id, because an operator needs to know "this ONE parent never
 *    arrived and took N children down with it" rather than N unrelated
 *    "something is missing" facts. An orphan is still walked for cost
 *    rollup and duplicate detection — losing the parent link is not a
 *    reason to also lose the child's own evidence.
 *
 * 2. **Duplicate recording.** A direct parent/child pair in the SAME
 *    `service`, agreeing on every signature field both sides declare
 *    (operation, agent_name, tool_name, model, token counts), over the
 *    same time window, is almost certainly one real operation recorded
 *    twice by two instrumentation layers in the same process — NOT the
 *    conventions' legitimate client/internal agent-invocation pair, which
 *    by definition crosses a process boundary and therefore reports a
 *    DIFFERENT `service`. A pair with no `service` on either side is never
 *    flagged: silence on service is not evidence of being in the same one.
 *
 * 3. **Misattributed cost.** Once duplicates are excluded from the rollup
 *    (see below), two separate signals name a cost-attribution problem: a
 *    span that declares its OWN `agent_name` disagreeing with the nearest
 *    ancestor agent its position in the tree would attribute it to, and
 *    usage sitting in an orphaned (lost-parent) subtree with no ancestor
 *    agent at all. Both are reported with the exact token counts at stake,
 *    never folded into a single severity number.
 *
 * 4. **Authority drift.** A direct agent→agent edge where the child's
 *    `agent_name` differs from its parent's is flagged unconditionally.
 *    Nothing in `genai-normalize.ts` ingests the conventions'
 *    `gen_ai.transfer.mode`/`gen_ai.transfer.target.name` attributes (grep
 *    confirms they are not in `ATTRIBUTE_ALIASES`), so there is no declared
 *    authorization this module could check the edge against — reporting
 *    every such edge as drift, rather than guessing which ones were
 *    "probably fine", is the same "report, never guess" discipline
 *    `genai-normalize.ts` itself applies to unmapped operations.
 *
 * **Duplicate exclusion in the cost rollup is one-directional.** When a
 * pair is flagged, the INNER span's own usage is excluded from the rollup
 * sum (the outer span's usage is kept) — excluding both would silently
 * discard real evidence that work happened, and excluding neither would
 * double-count it; keeping exactly the outer side is an arbitrary but
 * documented and consistent tie-break, not a guess at which layer is "more
 * correct".
 *
 * Pure: takes an already-normalized `GenAiSpan[]`; no I/O.
 */
import type { GenAiSpan } from "../trace/genai-normalize.js";

/** Roles this module recognizes, a superset of `GenAiKind` restricted to what nesting reconstruction needs. */
export const NESTED_ROLES = [
	"workflow",
	"agent",
	"plan",
	"tool",
	"llm",
	"retrieval",
	"embedding",
	"memory",
	"unknown",
] as const;
export type NestedRole = (typeof NESTED_ROLES)[number];

/**
 * Operations the current conventions publish that `genai-normalize.ts`'s
 * `OPERATION_TO_KIND` does not map, recognized here from the raw `operation`
 * string `normalizeGenAiSpan` already preserved on an otherwise-`unknown`
 * span.
 */
const UNMAPPED_OPERATION_ROLES: Partial<Record<string, NestedRole>> = {
	retrieval: "retrieval",
	invoke_workflow: "workflow",
	invoke_runner: "workflow",
	create_memory: "memory",
	create_memory_store: "memory",
	delete_memory: "memory",
	delete_memory_store: "memory",
	search_memory: "memory",
	update_memory: "memory",
	upsert_memory: "memory",
};

/**
 * Resolve the nesting role for one already-normalized span.
 *
 * A span whose `kind` is already known uses it directly (the role names are
 * identical to `GenAiKind`'s for every kind except the ones this module adds).
 * Only a `kind: "unknown"` span consults `operation` for one of the
 * conventions' currently-unmapped names; a span with neither a known kind
 * nor a recognized raw operation stays `"unknown"`.
 */
export function classifyNestedRole(span: GenAiSpan): NestedRole {
	if (span.kind !== "unknown") return span.kind;
	if (span.operation) {
		const role = UNMAPPED_OPERATION_ROLES[span.operation];
		if (role) return role;
	}
	return "unknown";
}

export type NestedNode = {
	span: GenAiSpan;
	role: NestedRole;
	children: NestedNode[];
};

export type LostParentGroup = {
	/** The parent id every span in `orphan_span_ids` declared but that is absent from this batch. */
	missing_parent_span_id: string;
	orphan_span_ids: string[];
};

export type NestedOperationTree = {
	/** True top-level spans (no `parent_span_id`) plus every orphan, each walked as its own root. */
	roots: NestedNode[];
	lost_parents: LostParentGroup[];
};

function spanOrder(a: GenAiSpan, b: GenAiSpan): number {
	return a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id);
}

/**
 * Reconstruct the nesting tree from a flat, already-normalized span batch.
 *
 * A span whose declared parent is missing from the batch is never dropped:
 * it is walked as its own root (so its cost and any duplicate-recording
 * pattern among its own descendants are still found) and is ALSO recorded in
 * `lost_parents`, grouped by the missing parent id, which is the evidence
 * this item's "lost parents" finding reports on.
 */
export function buildNestedTree(spans: GenAiSpan[]): NestedOperationTree {
	const nodeById = new Map<string, NestedNode>();
	for (const span of spans) {
		nodeById.set(span.span_id, { span, role: classifyNestedRole(span), children: [] });
	}

	const roots: NestedNode[] = [];
	const lostGroups = new Map<string, string[]>();

	for (const span of spans) {
		const node = nodeById.get(span.span_id);
		if (!node) continue;
		if (!span.parent_span_id) {
			roots.push(node);
			continue;
		}
		const parentNode = nodeById.get(span.parent_span_id);
		if (!parentNode) {
			const list = lostGroups.get(span.parent_span_id) ?? [];
			list.push(span.span_id);
			lostGroups.set(span.parent_span_id, list);
			roots.push(node);
			continue;
		}
		parentNode.children.push(node);
	}

	for (const node of nodeById.values()) {
		node.children.sort((a, b) => spanOrder(a.span, b.span));
	}
	roots.sort((a, b) => spanOrder(a.span, b.span));

	const lost_parents = [...lostGroups.entries()]
		.map(([missing_parent_span_id, orphan_span_ids]) => ({
			missing_parent_span_id,
			orphan_span_ids: [...orphan_span_ids].sort(),
		}))
		.sort((a, b) => a.missing_parent_span_id.localeCompare(b.missing_parent_span_id));

	return { roots, lost_parents };
}

export type DuplicateRecordingFinding = {
	outer_span_id: string;
	inner_span_id: string;
	/** Signature fields both spans declared and agreed on. */
	matched_fields: string[];
	detail: string;
};

const SIGNATURE_FIELDS = [
	"operation",
	"agent_name",
	"tool_name",
	"model",
	"input_tokens",
	"output_tokens",
] as const;

/** Same start and same duration within 1ms — exact OTel timestamps rarely need more slack than clock resolution. */
function sameWindow(a: GenAiSpan, b: GenAiSpan): boolean {
	return Math.abs(a.start_ms - b.start_ms) <= 1 && Math.abs(a.duration_ms - b.duration_ms) <= 1;
}

/**
 * Detect same-process double-recording of one logical operation.
 *
 * Only a direct parent/child pair is compared (a duplicate is, by
 * construction, the SAME call seen twice at adjacent layers of
 * instrumentation — never two calls several hops apart). A pair is flagged
 * only when: both declare a `service` and it is the SAME one (a genuine
 * client/internal remote pair crosses services and is never flagged); every
 * signature field BOTH sides declare agrees (a field only one side declares
 * is not a disagreement — that is exactly how double-instrumentation splits
 * facts across layers); at least one signature field is shared (two spans
 * declaring nothing in common share no identity to duplicate); and their
 * windows coincide.
 */
export function detectDuplicateRecording(tree: NestedOperationTree): DuplicateRecordingFinding[] {
	const findings: DuplicateRecordingFinding[] = [];

	function walk(node: NestedNode): void {
		for (const child of node.children) {
			const outer = node.span;
			const inner = child.span;
			if (outer.service !== undefined && outer.service === inner.service) {
				let sharedIdentity = false;
				let agreesEverywhere = true;
				const matched: string[] = [];
				for (const field of SIGNATURE_FIELDS) {
					const a = outer[field];
					const b = inner[field];
					if (a === undefined || b === undefined) continue;
					if (a === b) {
						matched.push(field);
						sharedIdentity = true;
					} else {
						agreesEverywhere = false;
					}
				}
				if (sharedIdentity && agreesEverywhere && sameWindow(outer, inner)) {
					findings.push({
						outer_span_id: outer.span_id,
						inner_span_id: inner.span_id,
						matched_fields: matched,
						detail: `span '${inner.span_id}' re-records the same operation as its parent '${outer.span_id}' (same service '${outer.service}', agreeing on ${matched.join(", ")}, overlapping window): likely double-instrumentation, not a genuine remote client/internal hop`,
					});
				}
			}
			walk(child);
		}
	}
	for (const root of tree.roots) walk(root);
	return findings;
}

export type MisattributedCostFinding =
	| {
			kind: "self_declared_mismatch";
			span_id: string;
			declared_agent: string;
			structural_agent: string;
			input_tokens: number;
			output_tokens: number;
			detail: string;
	  }
	| {
			kind: "orphaned_cost";
			missing_parent_span_id: string;
			span_ids: string[];
			input_tokens: number;
			output_tokens: number;
			detail: string;
	  };

export type AuthorityDriftFinding = {
	parent_span_id: string;
	parent_agent: string;
	child_span_id: string;
	child_agent: string;
	detail: string;
};

export type NestedOperationReport = {
	tree: NestedOperationTree;
	duplicate_recording: DuplicateRecordingFinding[];
	misattributed_cost: MisattributedCostFinding[];
	authority_drift: AuthorityDriftFinding[];
};

/** Span ids whose OWN usage must be excluded from the cost rollup (the inner half of a duplicate pair). */
function excludedSpanIds(duplicates: DuplicateRecordingFinding[]): Set<string> {
	return new Set(duplicates.map((d) => d.inner_span_id));
}

/**
 * Walk one subtree, finding every `self_declared_mismatch` and summing the
 * non-excluded token usage the subtree carries.
 *
 * `structuralAgent` is the nearest ANCESTOR agent's name seen so far on the
 * path from the subtree's root (not from this node itself, so a node that
 * IS an agent is compared against its OWN parent's agent, never against
 * itself).
 */
function walkForMismatchAndUsage(
	node: NestedNode,
	structuralAgent: string | undefined,
	excluded: Set<string>,
	findings: MisattributedCostFinding[],
): { input_tokens: number; output_tokens: number } {
	let inputTokens = 0;
	let outputTokens = 0;

	if (!excluded.has(node.span.span_id)) {
		inputTokens += node.span.input_tokens ?? 0;
		outputTokens += node.span.output_tokens ?? 0;
	}

	if (
		structuralAgent !== undefined &&
		node.span.agent_name !== undefined &&
		node.span.agent_name !== structuralAgent &&
		node.role !== "agent"
	) {
		findings.push({
			kind: "self_declared_mismatch",
			span_id: node.span.span_id,
			declared_agent: node.span.agent_name,
			structural_agent: structuralAgent,
			input_tokens: node.span.input_tokens ?? 0,
			output_tokens: node.span.output_tokens ?? 0,
			detail: `span '${node.span.span_id}' declares agent_name '${node.span.agent_name}' but is nested under agent '${structuralAgent}'; its ${node.span.input_tokens ?? 0} input / ${node.span.output_tokens ?? 0} output tokens are attributed to the structural ancestor by position while the span itself claims a different owner`,
		});
	}

	const nextStructuralAgent = node.role === "agent" ? node.span.agent_name : structuralAgent;
	for (const child of node.children) {
		const sub = walkForMismatchAndUsage(child, nextStructuralAgent, excluded, findings);
		inputTokens += sub.input_tokens;
		outputTokens += sub.output_tokens;
	}
	return { input_tokens: inputTokens, output_tokens: outputTokens };
}

/**
 * Find both misattributed-cost signals: self-declared ownership
 * disagreeing with tree position, and usage stranded under a lost parent.
 */
export function detectMisattributedCost(
	tree: NestedOperationTree,
	duplicates: DuplicateRecordingFinding[],
): MisattributedCostFinding[] {
	const excluded = excludedSpanIds(duplicates);
	const findings: MisattributedCostFinding[] = [];

	const orphanSpanIds = new Set(tree.lost_parents.flatMap((g) => g.orphan_span_ids));
	const rootsByOrphanOwner = new Map<string, NestedNode>();
	for (const root of tree.roots) {
		if (orphanSpanIds.has(root.span.span_id)) rootsByOrphanOwner.set(root.span.span_id, root);
	}

	// Every root — whether a true top-level span or an orphan whose parent
	// never arrived — has no ancestor agent of its own, so `structuralAgent`
	// starts `undefined` at every root alike.
	for (const root of tree.roots) {
		walkForMismatchAndUsage(root, undefined, excluded, findings);
	}

	for (const group of tree.lost_parents) {
		let inputTokens = 0;
		let outputTokens = 0;
		for (const spanId of group.orphan_span_ids) {
			const root = rootsByOrphanOwner.get(spanId);
			if (!root) continue;
			if (!excluded.has(root.span.span_id)) {
				inputTokens += root.span.input_tokens ?? 0;
				outputTokens += root.span.output_tokens ?? 0;
			}
			for (const child of root.children) {
				const sub = walkForMismatchAndUsage(child, undefined, excluded, []);
				inputTokens += sub.input_tokens;
				outputTokens += sub.output_tokens;
			}
		}
		if (inputTokens > 0 || outputTokens > 0) {
			findings.push({
				kind: "orphaned_cost",
				missing_parent_span_id: group.missing_parent_span_id,
				span_ids: group.orphan_span_ids,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				detail: `${inputTokens} input / ${outputTokens} output tokens sit under span(s) ${group.orphan_span_ids.join(", ")}, whose declared parent '${group.missing_parent_span_id}' was never captured in this batch — this usage cannot be attributed to any agent`,
			});
		}
	}

	return findings;
}

/**
 * Flag every direct agent→agent edge where the child declares a different
 * `agent_name` than its parent, unconditionally — this codebase does not yet
 * ingest the conventions' transfer-authorization attributes, so there is no
 * declared authorization to check the edge against instead.
 */
export function detectAuthorityDrift(tree: NestedOperationTree): AuthorityDriftFinding[] {
	const findings: AuthorityDriftFinding[] = [];

	function walk(node: NestedNode): void {
		for (const child of node.children) {
			if (
				node.role === "agent" &&
				child.role === "agent" &&
				node.span.agent_name !== undefined &&
				child.span.agent_name !== undefined &&
				node.span.agent_name !== child.span.agent_name
			) {
				findings.push({
					parent_span_id: node.span.span_id,
					parent_agent: node.span.agent_name,
					child_span_id: child.span.span_id,
					child_agent: child.span.agent_name,
					detail: `agent '${child.span.agent_name}' (span '${child.span.span_id}') is invoked directly under agent '${node.span.agent_name}' (span '${node.span.span_id}') with no recorded transfer or authorization attribute on this span: downstream tool/llm calls inherit unverified authority`,
				});
			}
			walk(child);
		}
	}
	for (const root of tree.roots) walk(root);
	return findings;
}

/** Reconstruct the nesting tree and run every finding kind in one pass. */
export function diagnoseNestedOperations(spans: GenAiSpan[]): NestedOperationReport {
	const tree = buildNestedTree(spans);
	const duplicate_recording = detectDuplicateRecording(tree);
	const misattributed_cost = detectMisattributedCost(tree, duplicate_recording);
	const authority_drift = detectAuthorityDrift(tree);
	return { tree, duplicate_recording, misattributed_cost, authority_drift };
}

/** Human-readable Markdown rendering, mirroring this project's other `render*Report` functions. */
export function renderNestedOperationReport(report: NestedOperationReport): string {
	const lines: string[] = ["# Nested agent-operation diagnosis", ""];

	lines.push(`## Lost parents (${report.tree.lost_parents.length})`);
	for (const g of report.tree.lost_parents) {
		lines.push(
			`- missing parent '${g.missing_parent_span_id}': ${g.orphan_span_ids.length} orphaned span(s) — ${g.orphan_span_ids.join(", ")}`,
		);
	}
	lines.push("");

	lines.push(`## Duplicate recording (${report.duplicate_recording.length})`);
	for (const d of report.duplicate_recording) {
		lines.push(`- ${d.detail}`);
	}
	lines.push("");

	lines.push(`## Misattributed cost (${report.misattributed_cost.length})`);
	for (const m of report.misattributed_cost) {
		lines.push(`- ${m.detail}`);
	}
	lines.push("");

	lines.push(`## Authority drift (${report.authority_drift.length})`);
	for (const a of report.authority_drift) {
		lines.push(`- ${a.detail}`);
	}
	lines.push("");

	return lines.join("\n");
}
