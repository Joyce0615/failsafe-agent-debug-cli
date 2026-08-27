/**
 * Normalization of incoming OpenTelemetry GenAI workflow, plan, agent, and tool
 * spans (item 57).
 *
 * Item 52 settled how Failsafe *emits* under the dedicated GenAI schema. This
 * module is the other direction: taking a trace produced by somebody else and
 * turning it into one model. That is harder than it sounds, because the
 * ecosystem has at least four live spellings for the same fact — the current
 * `gen_ai.*` conventions, the pre-rename `prompt_tokens`/`completion_tokens`
 * form, OpenInference's `openinference.span.kind`, and the framework-specific
 * `llm.*` / `ai.*` bags — and a trace routinely contains more than one of them
 * because different libraries in the same process instrumented different hops.
 *
 * Three rules define what this module will and will not do:
 *
 * 1. **A span's kind comes from a declared attribute or it is `unknown`.**
 *    Guessing that a span called `search` is a tool span is the single fastest
 *    way to poison every downstream aggregate, because the guess is confident,
 *    invisible, and wrong maybe a fifth of the time. `inferKindFromName` exists
 *    for callers who want the heuristic, returns its result marked
 *    `inferred: true`, and is never applied automatically.
 *
 * 2. **Disagreeing aliases are recorded, not reconciled.** If a span carries
 *    both `gen_ai.usage.input_tokens: 100` and `llm.token_count.prompt: 120`,
 *    something upstream is double-instrumented and the *fact* of the conflict
 *    is more useful than either number. The canonical key wins for the value
 *    and the conflict is reported.
 *
 * 3. **Deprecated aliases are counted.** `prompt_tokens` still works, and a
 *    count of how often it was needed is what tells an operator whether their
 *    fleet has finished migrating. Silently accepting it forever means never
 *    finding out.
 *
 * Pure: takes already-fetched spans, performs no I/O.
 */

/** Canonical GenAI span kinds. */
export const GENAI_KINDS = [
	"workflow",
	"agent",
	"plan",
	"tool",
	"llm",
	"retrieval",
	"embedding",
	"unknown",
] as const;
export type GenAiKind = (typeof GENAI_KINDS)[number];

/**
 * Structural shape this module consumes.
 *
 * Deliberately minimal so an item-40 `NormalizedSpan` satisfies it without a
 * conversion step, while a raw backend payload can also be passed directly.
 */
export type GenAiSourceSpan = {
	span_id: string;
	parent_span_id?: string;
	name: string;
	start_ms: number;
	duration_ms: number;
	attributes: Record<string, unknown>;
	service?: string;
	status?: string;
};

/**
 * Canonical field → source keys, most authoritative first.
 *
 * Order is the whole specification: the first key present supplies the value,
 * and every later key that is also present and disagrees becomes a conflict.
 */
export const ATTRIBUTE_ALIASES = {
	operation: [
		"gen_ai.operation.name",
		"openinference.span.kind",
		"traceloop.span.kind",
		"llm.request.type",
	],
	agent_name: ["gen_ai.agent.name", "agent.name", "traceloop.entity.name"],
	agent_version: ["gen_ai.agent.version", "agent.version"],
	tool_name: ["gen_ai.tool.name", "tool.name", "llm.tool.name"],
	model: ["gen_ai.request.model", "gen_ai.response.model", "llm.model_name", "ai.model.id"],
	provider: ["gen_ai.provider.name", "gen_ai.system", "llm.system"],
	conversation_id: ["gen_ai.conversation.id", "session.id", "traceloop.association.session_id"],
	input_tokens: [
		"gen_ai.usage.input_tokens",
		"gen_ai.usage.prompt_tokens",
		"llm.token_count.prompt",
		"ai.usage.promptTokens",
	],
	output_tokens: [
		"gen_ai.usage.output_tokens",
		"gen_ai.usage.completion_tokens",
		"llm.token_count.completion",
		"ai.usage.completionTokens",
	],
} as const;

export type CanonicalField = keyof typeof ATTRIBUTE_ALIASES;

/**
 * Aliases that are superseded but still accepted.
 *
 * Counted rather than rejected: refusing them would drop real traces, and
 * accepting them without a count means never learning whether the fleet has
 * migrated.
 */
export const DEPRECATED_ALIASES = new Set([
	"gen_ai.usage.prompt_tokens",
	"gen_ai.usage.completion_tokens",
	"gen_ai.system",
]);

/**
 * Declared operation values → canonical kind.
 *
 * Includes both the `gen_ai.operation.name` enum and the uppercase
 * OpenInference span kinds, because in practice a single trace contains both.
 */
export const OPERATION_TO_KIND: Record<string, GenAiKind> = {
	// gen_ai.operation.name
	invoke_agent: "agent",
	create_agent: "agent",
	execute_tool: "tool",
	chat: "llm",
	text_completion: "llm",
	generate_content: "llm",
	embeddings: "embedding",
	// OpenInference span kinds
	AGENT: "agent",
	TOOL: "tool",
	LLM: "llm",
	CHAIN: "workflow",
	RETRIEVER: "retrieval",
	EMBEDDING: "embedding",
	// Framework spellings
	workflow: "workflow",
	chain: "workflow",
	agent: "agent",
	tool: "tool",
	llm: "llm",
	task: "workflow",
	retriever: "retrieval",
	plan: "plan",
	planning: "plan",
};

export type FieldResolution = {
	field: CanonicalField;
	/** The key that supplied the value. */
	source_key: string;
	value: string | number;
	deprecated: boolean;
	/** Keys that were also present with a different value. */
	conflicts: Array<{ key: string; value: string | number }>;
};

function readScalar(value: unknown): string | number | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "boolean") return String(value);
	return undefined;
}

/** Numeric fields must not silently accept a string that is not a number. */
const NUMERIC_FIELDS: ReadonlySet<CanonicalField> = new Set(["input_tokens", "output_tokens"]);

function coerce(field: CanonicalField, value: string | number): string | number | undefined {
	if (!NUMERIC_FIELDS.has(field)) return value;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Resolve one canonical field across its aliases. */
export function resolveField(
	attributes: Record<string, unknown>,
	field: CanonicalField,
): FieldResolution | undefined {
	const keys = ATTRIBUTE_ALIASES[field] as readonly string[];
	let chosen: { key: string; value: string | number } | undefined;
	const others: Array<{ key: string; value: string | number }> = [];

	for (const key of keys) {
		const raw = readScalar(attributes[key]);
		if (raw === undefined) continue;
		const value = coerce(field, raw);
		if (value === undefined) continue;
		if (!chosen) chosen = { key, value };
		else others.push({ key, value });
	}
	if (!chosen) return undefined;

	return {
		field,
		source_key: chosen.key,
		value: chosen.value,
		deprecated: DEPRECATED_ALIASES.has(chosen.key),
		// Only *disagreeing* extras are conflicts; the same number under two
		// names is redundancy, not a contradiction.
		conflicts: others.filter((o) => o.value !== chosen.value),
	};
}

export type GenAiSpan = {
	span_id: string;
	parent_span_id?: string;
	name: string;
	kind: GenAiKind;
	/** Why the kind is `unknown`, when it is. */
	unknown_reason?: string;
	/** True only when a caller explicitly applied the name heuristic. */
	inferred_kind: boolean;
	operation?: string;
	agent_name?: string;
	agent_version?: string;
	tool_name?: string;
	model?: string;
	provider?: string;
	conversation_id?: string;
	input_tokens?: number;
	output_tokens?: number;
	start_ms: number;
	duration_ms: number;
	service?: string;
	status?: string;
};

export type SpanNormalization = {
	span: GenAiSpan;
	/** Which alias supplied each field, so a value is always traceable. */
	provenance: FieldResolution[];
	deprecated_keys: string[];
	conflicts: Array<{ field: CanonicalField; chosen: string; ignored: string }>;
};

/**
 * Normalize one span.
 *
 * The kind is derived *only* from a declared operation attribute. A span with
 * none is `unknown` with a reason, and a span whose declared operation is not
 * in the mapping is also `unknown` — with a different reason, because "nobody
 * said" and "somebody said something we do not recognize" are different
 * problems and only the second one means the mapping needs extending.
 */
export function normalizeGenAiSpan(source: GenAiSourceSpan): SpanNormalization {
	const provenance: FieldResolution[] = [];
	const attrs = source.attributes;

	for (const field of Object.keys(ATTRIBUTE_ALIASES) as CanonicalField[]) {
		const resolved = resolveField(attrs, field);
		if (resolved) provenance.push(resolved);
	}
	const value = (field: CanonicalField) => provenance.find((p) => p.field === field)?.value;

	const operation = value("operation");
	let kind: GenAiKind = "unknown";
	let unknownReason: string | undefined;
	if (operation === undefined) {
		unknownReason = "no operation attribute declared on the span";
	} else {
		const mapped = OPERATION_TO_KIND[String(operation)];
		if (mapped) kind = mapped;
		else unknownReason = `declared operation '${operation}' is not in the known mapping`;
	}

	const inputTokens = value("input_tokens");
	const outputTokens = value("output_tokens");

	return {
		span: {
			span_id: source.span_id,
			...(source.parent_span_id ? { parent_span_id: source.parent_span_id } : {}),
			name: source.name,
			kind,
			...(unknownReason ? { unknown_reason: unknownReason } : {}),
			inferred_kind: false,
			...(operation !== undefined ? { operation: String(operation) } : {}),
			...strField(value("agent_name"), "agent_name"),
			...strField(value("agent_version"), "agent_version"),
			...strField(value("tool_name"), "tool_name"),
			...strField(value("model"), "model"),
			...strField(value("provider"), "provider"),
			...strField(value("conversation_id"), "conversation_id"),
			...(typeof inputTokens === "number" ? { input_tokens: inputTokens } : {}),
			...(typeof outputTokens === "number" ? { output_tokens: outputTokens } : {}),
			start_ms: source.start_ms,
			duration_ms: source.duration_ms,
			...(source.service ? { service: source.service } : {}),
			...(source.status ? { status: source.status } : {}),
		},
		provenance,
		deprecated_keys: provenance.filter((p) => p.deprecated).map((p) => p.source_key),
		conflicts: provenance.flatMap((p) =>
			p.conflicts.map((c) => ({ field: p.field, chosen: p.source_key, ignored: c.key })),
		),
	};
}

function strField(value: string | number | undefined, key: string): Record<string, string> {
	return value === undefined ? {} : { [key]: String(value) };
}

/**
 * Name-based kind heuristic — explicit, opt-in, and always marked.
 *
 * Offered because sometimes a name really is all there is, and a labelled guess
 * beats discarding the span. It is never called by `normalizeGenAiSpan`: the
 * whole value of the `unknown` kind is that it is honest, and a heuristic that
 * runs by default would erase it.
 */
export function inferKindFromName(name: string): GenAiKind {
	const lower = name.toLowerCase();
	if (/\bplan(ning)?\b/.test(lower)) return "plan";
	if (/\bworkflow|chain|pipeline\b/.test(lower)) return "workflow";
	if (/\bagent\b/.test(lower)) return "agent";
	if (/\btool|function[_ ]call\b/.test(lower)) return "tool";
	if (/\bembed/.test(lower)) return "embedding";
	if (/\bretriev|search|vector/.test(lower)) return "retrieval";
	if (/\bllm|chat|completion|generate\b/.test(lower)) return "llm";
	return "unknown";
}

/** Apply the heuristic to spans still `unknown`, marking every result. */
export function applyKindInference(spans: GenAiSpan[]): GenAiSpan[] {
	return spans.map((span) => {
		if (span.kind !== "unknown") return span;
		const guess = inferKindFromName(span.name);
		if (guess === "unknown") return span;
		return { ...span, kind: guess, inferred_kind: true };
	});
}

export type StructureIssue = { span_id: string; problem: string };

/**
 * Parent kinds each child kind is expected under.
 *
 * `undefined` means "anywhere". This is advisory: a violation is reported, not
 * corrected, because an unusual-but-real topology is more likely than a
 * normalizer that knows better than the system it is reading.
 */
const EXPECTED_PARENTS: Partial<Record<GenAiKind, GenAiKind[]>> = {
	plan: ["agent", "workflow"],
	tool: ["agent", "workflow", "plan", "tool"],
	llm: ["agent", "workflow", "plan", "llm"],
};

/**
 * Check the workflow → agent → plan → tool/llm shape.
 *
 * Reports rather than repairs. The two conditions worth flagging are a child
 * under a parent kind that should not contain it, and a parent id that is not
 * in the batch — the latter being how a partial trace announces itself.
 */
export function validateGenAiStructure(spans: GenAiSpan[]): StructureIssue[] {
	const byId = new Map(spans.map((s) => [s.span_id, s]));
	const issues: StructureIssue[] = [];

	for (const span of spans) {
		if (!span.parent_span_id) continue;
		const parent = byId.get(span.parent_span_id);
		if (!parent) {
			issues.push({
				span_id: span.span_id,
				problem: `parent '${span.parent_span_id}' is not present in this batch (partial trace)`,
			});
			continue;
		}
		const expected = EXPECTED_PARENTS[span.kind];
		if (expected && parent.kind !== "unknown" && !expected.includes(parent.kind)) {
			issues.push({
				span_id: span.span_id,
				problem: `${span.kind} span under a ${parent.kind} parent; expected one of ${expected.join("|")}`,
			});
		}
	}
	return issues;
}

export type UsageRollup = {
	spans: number;
	input_tokens: number;
	output_tokens: number;
	duration_ms: number;
	/** Spans in this group that reported no usage at all. */
	spans_without_usage: number;
};

function emptyRollup(): UsageRollup {
	return { spans: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0, spans_without_usage: 0 };
}

/**
 * Roll up usage by a chosen dimension.
 *
 * `spans_without_usage` is reported alongside the totals because a token sum is
 * meaningless without knowing how much of the group contributed to it — a
 * "0 tokens" agent that simply was not instrumented and one that genuinely did
 * no model work look identical otherwise.
 */
export function rollupUsage(
	spans: GenAiSpan[],
	by: "agent_name" | "tool_name" | "model" | "kind",
): Record<string, UsageRollup> {
	const out: Record<string, UsageRollup> = {};
	for (const span of spans) {
		const key = by === "kind" ? span.kind : span[by];
		if (key === undefined) continue;
		const totals = (out[key] ??= emptyRollup());
		totals.spans++;
		totals.input_tokens += span.input_tokens ?? 0;
		totals.output_tokens += span.output_tokens ?? 0;
		totals.duration_ms += span.duration_ms;
		if (span.input_tokens === undefined && span.output_tokens === undefined) {
			totals.spans_without_usage++;
		}
	}
	return out;
}

export type NormalizationReport = {
	spans: number;
	by_kind: Record<GenAiKind, number>;
	unknown_reasons: Array<{ reason: string; spans: number }>;
	/** Deprecated alias keys and how often each was needed. */
	deprecated_usage: Array<{ key: string; spans: number }>;
	/** Fields where two aliases disagreed on the same span. */
	conflicts: Array<{ field: CanonicalField; chosen: string; ignored: string; spans: number }>;
	structure_issues: StructureIssue[];
	inferred_kinds: number;
};

/** Normalize a whole trace and report what the normalization cost. */
export function normalizeGenAiTrace(
	sources: GenAiSourceSpan[],
	opts: { infer_kinds?: boolean } = {},
): { spans: GenAiSpan[]; report: NormalizationReport } {
	const normalized = sources.map(normalizeGenAiSpan);
	let spans = normalized.map((n) => n.span);
	if (opts.infer_kinds) spans = applyKindInference(spans);

	const byKind = Object.fromEntries(GENAI_KINDS.map((k) => [k, 0])) as Record<GenAiKind, number>;
	for (const span of spans) byKind[span.kind]++;

	const reasons = new Map<string, number>();
	for (const span of spans) {
		if (span.unknown_reason && span.kind === "unknown") {
			reasons.set(span.unknown_reason, (reasons.get(span.unknown_reason) ?? 0) + 1);
		}
	}

	const deprecated = new Map<string, number>();
	for (const n of normalized) {
		for (const key of new Set(n.deprecated_keys)) {
			deprecated.set(key, (deprecated.get(key) ?? 0) + 1);
		}
	}

	const conflicts = new Map<
		string,
		{ field: CanonicalField; chosen: string; ignored: string; spans: number }
	>();
	for (const n of normalized) {
		for (const c of n.conflicts) {
			const key = `${c.field}|${c.chosen}|${c.ignored}`;
			const entry = conflicts.get(key) ?? { ...c, spans: 0 };
			entry.spans++;
			conflicts.set(key, entry);
		}
	}

	return {
		spans,
		report: {
			spans: spans.length,
			by_kind: byKind,
			unknown_reasons: [...reasons.entries()]
				.map(([reason, count]) => ({ reason, spans: count }))
				.sort((a, b) => b.spans - a.spans || a.reason.localeCompare(b.reason)),
			deprecated_usage: [...deprecated.entries()]
				.map(([key, count]) => ({ key, spans: count }))
				.sort((a, b) => b.spans - a.spans || a.key.localeCompare(b.key)),
			conflicts: [...conflicts.values()].sort(
				(a, b) => b.spans - a.spans || a.field.localeCompare(b.field),
			),
			structure_issues: validateGenAiStructure(spans),
			inferred_kinds: spans.filter((s) => s.inferred_kind).length,
		},
	};
}
