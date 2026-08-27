import { describe, expect, test } from "bun:test";
import {
	ATTRIBUTE_ALIASES,
	DEPRECATED_ALIASES,
	GENAI_KINDS,
	type GenAiSourceSpan,
	type GenAiSpan,
	OPERATION_TO_KIND,
	applyKindInference,
	inferKindFromName,
	normalizeGenAiSpan,
	normalizeGenAiTrace,
	resolveField,
	rollupUsage,
	validateGenAiStructure,
} from "../../src/trace/genai-normalize.js";

function source(overrides: Partial<GenAiSourceSpan> = {}): GenAiSourceSpan {
	return {
		span_id: "s1",
		name: "some span",
		start_ms: 1000,
		duration_ms: 50,
		attributes: {},
		...overrides,
	};
}

describe("kind is declared, never guessed", () => {
	test("a declared gen_ai operation maps to a canonical kind", () => {
		const { span } = normalizeGenAiSpan(
			source({ attributes: { "gen_ai.operation.name": "execute_tool" } }),
		);
		expect(span.kind).toBe("tool");
		expect(span.inferred_kind).toBe(false);
		expect(span.unknown_reason).toBeUndefined();
	});

	test("OpenInference span kinds map too, since both appear in one trace", () => {
		expect(
			normalizeGenAiSpan(source({ attributes: { "openinference.span.kind": "CHAIN" } })).span.kind,
		).toBe("workflow");
		expect(
			normalizeGenAiSpan(source({ attributes: { "openinference.span.kind": "RETRIEVER" } })).span
				.kind,
		).toBe("retrieval");
	});

	test("a span with no operation attribute is unknown, whatever it is called", () => {
		const { span } = normalizeGenAiSpan(source({ name: "call_search_tool" }));
		expect(span.kind).toBe("unknown");
		expect(span.unknown_reason).toContain("no operation attribute");
	});

	test("an unrecognized declared operation is a different kind of unknown", () => {
		const { span } = normalizeGenAiSpan(
			source({ attributes: { "gen_ai.operation.name": "summon_daemon" } }),
		);
		expect(span.kind).toBe("unknown");
		expect(span.unknown_reason).toContain("not in the known mapping");
		// The operation is still carried through so the gap is actionable.
		expect(span.operation).toBe("summon_daemon");
	});

	test("every mapped operation resolves to a declared kind", () => {
		for (const kind of Object.values(OPERATION_TO_KIND)) {
			expect(GENAI_KINDS).toContain(kind);
		}
	});
});

describe("the name heuristic is opt-in and always marked", () => {
	test("normalization never applies it", () => {
		const { span } = normalizeGenAiSpan(source({ name: "agent loop" }));
		expect(span.kind).toBe("unknown");
	});

	test("the heuristic recognizes the common shapes", () => {
		expect(inferKindFromName("planner.plan")).toBe("plan");
		expect(inferKindFromName("RunnableChain")).toBe("workflow");
		expect(inferKindFromName("ReAct agent")).toBe("agent");
		expect(inferKindFromName("tool: web_search")).toBe("tool");
		expect(inferKindFromName("embed documents")).toBe("embedding");
		expect(inferKindFromName("vector retrieval")).toBe("retrieval");
		expect(inferKindFromName("chat completion")).toBe("llm");
		expect(inferKindFromName("frobnicate")).toBe("unknown");
	});

	test("applying it marks every result it changes", () => {
		const spans: GenAiSpan[] = [
			{
				span_id: "a",
				name: "web_search tool",
				kind: "unknown",
				inferred_kind: false,
				start_ms: 0,
				duration_ms: 1,
			},
		];
		const inferred = applyKindInference(spans);
		expect(inferred[0].kind).toBe("tool");
		expect(inferred[0].inferred_kind).toBe(true);
	});

	test("it never overwrites a declared kind", () => {
		const spans: GenAiSpan[] = [
			{
				span_id: "a",
				// A declared LLM span whose name says "tool" stays an LLM span.
				name: "tool wrapper",
				kind: "llm",
				inferred_kind: false,
				start_ms: 0,
				duration_ms: 1,
			},
		];
		expect(applyKindInference(spans)[0].kind).toBe("llm");
		expect(applyKindInference(spans)[0].inferred_kind).toBe(false);
	});

	test("a name the heuristic cannot read stays unknown rather than defaulting", () => {
		const spans: GenAiSpan[] = [
			{ span_id: "a", name: "step 4", kind: "unknown", inferred_kind: false, start_ms: 0, duration_ms: 1 },
		];
		expect(applyKindInference(spans)[0].kind).toBe("unknown");
		expect(applyKindInference(spans)[0].inferred_kind).toBe(false);
	});
});

describe("alias resolution", () => {
	test("the first declared alias supplies the value", () => {
		const resolved = resolveField(
			{ "gen_ai.usage.input_tokens": 100, "llm.token_count.prompt": 100 },
			"input_tokens",
		);
		expect(resolved?.source_key).toBe("gen_ai.usage.input_tokens");
		expect(resolved?.value).toBe(100);
		expect(resolved?.conflicts).toEqual([]);
	});

	test("a lower-priority alias is used when the canonical key is absent", () => {
		const resolved = resolveField({ "ai.usage.promptTokens": 42 }, "input_tokens");
		expect(resolved?.source_key).toBe("ai.usage.promptTokens");
		expect(resolved?.value).toBe(42);
	});

	test("disagreeing aliases are recorded, not averaged", () => {
		const resolved = resolveField(
			{ "gen_ai.usage.input_tokens": 100, "llm.token_count.prompt": 120 },
			"input_tokens",
		);
		expect(resolved?.value).toBe(100);
		expect(resolved?.conflicts).toEqual([{ key: "llm.token_count.prompt", value: 120 }]);
	});

	test("the same value under two names is redundancy, not a conflict", () => {
		const resolved = resolveField(
			{ "gen_ai.agent.name": "planner", "agent.name": "planner" },
			"agent_name",
		);
		expect(resolved?.conflicts).toEqual([]);
	});

	test("a deprecated alias is flagged when it supplies the value", () => {
		const resolved = resolveField({ "gen_ai.usage.prompt_tokens": 7 }, "input_tokens");
		expect(resolved?.deprecated).toBe(true);
		expect(DEPRECATED_ALIASES.has("gen_ai.usage.prompt_tokens")).toBe(true);
	});

	test("a numeric field refuses a non-numeric value rather than coercing to NaN", () => {
		expect(resolveField({ "gen_ai.usage.input_tokens": "many" }, "input_tokens")).toBeUndefined();
		expect(resolveField({ "gen_ai.usage.input_tokens": -5 }, "input_tokens")).toBeUndefined();
	});

	test("a numeric string is accepted, since JSON attribute bags stringify", () => {
		expect(resolveField({ "gen_ai.usage.input_tokens": "128" }, "input_tokens")?.value).toBe(128);
	});

	test("an absent field resolves to undefined rather than a default", () => {
		expect(resolveField({}, "model")).toBeUndefined();
	});

	test("empty strings do not count as declared", () => {
		expect(resolveField({ "gen_ai.agent.name": "" }, "agent_name")).toBeUndefined();
	});

	test("every canonical field lists the current gen_ai key first", () => {
		for (const [field, keys] of Object.entries(ATTRIBUTE_ALIASES)) {
			if (field === "provider") continue; // gen_ai.provider.name supersedes gen_ai.system
			expect(keys[0].startsWith("gen_ai.")).toBe(true);
		}
	});
});

describe("full span normalization", () => {
	const span = source({
		span_id: "s1",
		name: "execute_tool search",
		attributes: {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "search_repo",
			"gen_ai.agent.name": "failsafe",
			"gen_ai.agent.version": "0.1.0",
			"gen_ai.request.model": "some-model",
			"gen_ai.system": "openai",
			"gen_ai.conversation.id": "conv-1",
			"gen_ai.usage.prompt_tokens": 90,
			"gen_ai.usage.output_tokens": 12,
		},
		service: "mcp",
		status: "ok",
	});

	test("all canonical fields are populated and provenance recorded", () => {
		const result = normalizeGenAiSpan(span);
		expect(result.span.tool_name).toBe("search_repo");
		expect(result.span.agent_version).toBe("0.1.0");
		expect(result.span.provider).toBe("openai");
		expect(result.span.input_tokens).toBe(90);
		expect(result.span.output_tokens).toBe(12);
		expect(result.provenance.map((p) => p.field)).toContain("tool_name");
	});

	test("deprecated keys are collected for the migration count", () => {
		const result = normalizeGenAiSpan(span);
		expect(result.deprecated_keys.sort()).toEqual([
			"gen_ai.system",
			"gen_ai.usage.prompt_tokens",
		]);
	});

	test("timing, service, and status pass through untouched", () => {
		const result = normalizeGenAiSpan(span);
		expect(result.span.start_ms).toBe(1000);
		expect(result.span.duration_ms).toBe(50);
		expect(result.span.service).toBe("mcp");
		expect(result.span.status).toBe("ok");
	});

	test("absent optional fields are omitted, not filled with empty strings", () => {
		const result = normalizeGenAiSpan(source());
		expect("tool_name" in result.span).toBe(false);
		expect("model" in result.span).toBe(false);
	});
});

describe("structure validation", () => {
	function span(id: string, kind: GenAiSpan["kind"], parent?: string): GenAiSpan {
		return {
			span_id: id,
			...(parent ? { parent_span_id: parent } : {}),
			name: id,
			kind,
			inferred_kind: false,
			start_ms: 0,
			duration_ms: 1,
		};
	}

	test("the canonical workflow → agent → plan → tool shape is clean", () => {
		const issues = validateGenAiStructure([
			span("w", "workflow"),
			span("a", "agent", "w"),
			span("p", "plan", "a"),
			span("t", "tool", "p"),
		]);
		expect(issues).toEqual([]);
	});

	test("a plan under a tool is flagged", () => {
		const issues = validateGenAiStructure([span("t", "tool"), span("p", "plan", "t")]);
		expect(issues).toHaveLength(1);
		expect(issues[0].problem).toContain("plan span under a tool parent");
	});

	test("a nested tool is legal, because tools do call tools", () => {
		expect(validateGenAiStructure([span("t1", "tool"), span("t2", "tool", "t1")])).toEqual([]);
	});

	test("a missing parent announces a partial trace rather than being dropped", () => {
		const issues = validateGenAiStructure([span("t", "tool", "ghost")]);
		expect(issues[0].problem).toContain("partial trace");
	});

	test("an unknown-kind parent is not second-guessed", () => {
		expect(validateGenAiStructure([span("u", "unknown"), span("p", "plan", "u")])).toEqual([]);
	});

	test("a root span has nothing to validate", () => {
		expect(validateGenAiStructure([span("w", "workflow")])).toEqual([]);
	});
});

describe("usage rollups", () => {
	const spans: GenAiSpan[] = [
		{
			span_id: "1",
			name: "a",
			kind: "llm",
			inferred_kind: false,
			agent_name: "planner",
			input_tokens: 100,
			output_tokens: 20,
			start_ms: 0,
			duration_ms: 10,
		},
		{
			span_id: "2",
			name: "b",
			kind: "llm",
			inferred_kind: false,
			agent_name: "planner",
			input_tokens: 50,
			output_tokens: 5,
			start_ms: 0,
			duration_ms: 20,
		},
		{
			span_id: "3",
			name: "c",
			kind: "tool",
			inferred_kind: false,
			agent_name: "executor",
			start_ms: 0,
			duration_ms: 30,
		},
	];

	test("totals accumulate per group", () => {
		const byAgent = rollupUsage(spans, "agent_name");
		expect(byAgent.planner).toEqual({
			spans: 2,
			input_tokens: 150,
			output_tokens: 25,
			duration_ms: 30,
			spans_without_usage: 0,
		});
	});

	test("uninstrumented spans are counted, so a zero total is interpretable", () => {
		expect(rollupUsage(spans, "agent_name").executor.spans_without_usage).toBe(1);
	});

	test("spans with no value for the dimension are excluded, not bucketed as undefined", () => {
		const byTool = rollupUsage(spans, "tool_name");
		expect(Object.keys(byTool)).toEqual([]);
	});

	test("rolling up by kind covers every span", () => {
		const byKind = rollupUsage(spans, "kind");
		expect(byKind.llm.spans).toBe(2);
		expect(byKind.tool.spans).toBe(1);
	});
});

describe("whole-trace normalization report", () => {
	const sources: GenAiSourceSpan[] = [
		source({
			span_id: "w",
			name: "chain",
			attributes: { "openinference.span.kind": "CHAIN" },
		}),
		source({
			span_id: "a",
			parent_span_id: "w",
			name: "agent",
			attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "planner" },
		}),
		source({
			span_id: "l",
			parent_span_id: "a",
			name: "chat",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.usage.prompt_tokens": 100,
				"llm.token_count.prompt": 130,
				"gen_ai.usage.output_tokens": 20,
			},
		}),
		source({ span_id: "x", parent_span_id: "a", name: "mystery step" }),
	];

	test("kinds are counted and unknowns explained", () => {
		const { report } = normalizeGenAiTrace(sources);
		expect(report.spans).toBe(4);
		expect(report.by_kind.workflow).toBe(1);
		expect(report.by_kind.agent).toBe(1);
		expect(report.by_kind.llm).toBe(1);
		expect(report.by_kind.unknown).toBe(1);
		expect(report.unknown_reasons[0].reason).toContain("no operation attribute");
		expect(report.unknown_reasons[0].spans).toBe(1);
	});

	test("deprecated alias usage is counted so migration is measurable", () => {
		const { report } = normalizeGenAiTrace(sources);
		expect(report.deprecated_usage).toEqual([{ key: "gen_ai.usage.prompt_tokens", spans: 1 }]);
	});

	test("double instrumentation shows up as a conflict, not a silent choice", () => {
		const { report } = normalizeGenAiTrace(sources);
		expect(report.conflicts).toEqual([
			{
				field: "input_tokens",
				chosen: "gen_ai.usage.prompt_tokens",
				ignored: "llm.token_count.prompt",
				spans: 1,
			},
		]);
	});

	test("inference is off by default and counted when enabled", () => {
		expect(normalizeGenAiTrace(sources).report.inferred_kinds).toBe(0);
		const inferred = normalizeGenAiTrace(
			[...sources, source({ span_id: "t", parent_span_id: "a", name: "web_search tool" })],
			{ infer_kinds: true },
		);
		expect(inferred.report.inferred_kinds).toBe(1);
		expect(inferred.report.by_kind.tool).toBe(1);
	});

	test("structure issues are part of the report, not a separate call", () => {
		const { report } = normalizeGenAiTrace(sources);
		expect(report.structure_issues).toEqual([]);
	});

	test("an empty trace reports zeros rather than throwing", () => {
		const { spans, report } = normalizeGenAiTrace([]);
		expect(spans).toEqual([]);
		expect(report.spans).toBe(0);
		expect(report.by_kind.unknown).toBe(0);
		expect(report.unknown_reasons).toEqual([]);
	});

	test("a normalized span from item 40's shape needs no conversion", () => {
		// A `NormalizedSpan` has string-valued attributes; it must flow straight in.
		const fromBackend = {
			span_id: "n1",
			trace_id: "t",
			name: "execute_tool x",
			service: "svc",
			start_ms: 5,
			duration_ms: 6,
			status: "error",
			attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "x" },
			messages: [] as string[],
		};
		const { span } = normalizeGenAiSpan(fromBackend);
		expect(span.kind).toBe("tool");
		expect(span.tool_name).toBe("x");
		expect(span.status).toBe("error");
	});
});
