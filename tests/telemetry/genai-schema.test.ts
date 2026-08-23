import { afterEach, describe, expect, test } from "bun:test";
import {
	applyCapturePolicy,
	classifyAttribute,
	resetCapturePolicy,
} from "../../src/telemetry/capture-policy.js";
import {
	AGENT_NAME,
	AGENT_VERSION,
	EXCEPTION_EVENT_NAME,
	GEN_AI_OPERATION_NAMES,
	GEN_AI_SCHEMA_URL,
	GEN_AI_SCHEMA_URL_ENV,
	GEN_AI_SCHEMA_VERSION,
	GEN_AI_SPAN_KINDS,
	exceptionEvent,
	genAiResourceAttributes,
	genAiSpanAttributes,
	genAiSpanName,
	resolveSchemaUrl,
	tracerOptions,
} from "../../src/telemetry/genai-schema.js";
import { recordExceptionEvent } from "../../src/telemetry/otel.js";

afterEach(() => {
	process.env[GEN_AI_SCHEMA_URL_ENV] = undefined;
	// biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined".
	delete process.env[GEN_AI_SCHEMA_URL_ENV];
	resetCapturePolicy();
});

describe("explicit schema URL", () => {
	test("the pinned URL is built from the pinned version", () => {
		expect(GEN_AI_SCHEMA_URL).toBe(`https://opentelemetry.io/schemas/${GEN_AI_SCHEMA_VERSION}`);
	});

	test("with no override the pinned URL is used", () => {
		expect(resolveSchemaUrl()).toBe(GEN_AI_SCHEMA_URL);
	});

	test("a valid HTTPS override is honoured", () => {
		expect(resolveSchemaUrl("https://mirror.example/schemas/1.40.0")).toBe(
			"https://mirror.example/schemas/1.40.0",
		);
	});

	test("a non-HTTPS override falls back rather than shipping a downgrade", () => {
		expect(resolveSchemaUrl("http://mirror.example/schemas/1.40.0")).toBe(GEN_AI_SCHEMA_URL);
	});

	test("a malformed override falls back rather than putting garbage on every span", () => {
		expect(resolveSchemaUrl("not a url")).toBe(GEN_AI_SCHEMA_URL);
		expect(resolveSchemaUrl("")).toBe(GEN_AI_SCHEMA_URL);
	});

	test("the tracer declares the schema URL at the API level", () => {
		expect(tracerOptions()).toEqual({ schemaUrl: GEN_AI_SCHEMA_URL });
		process.env[GEN_AI_SCHEMA_URL_ENV] = "https://mirror.example/x";
		expect(tracerOptions().schemaUrl).toBe("https://mirror.example/x");
	});

	test("the resource carries the schema URL and the agent version", () => {
		const resource = genAiResourceAttributes();
		expect(resource["gen_ai.schema_url"]).toBe(GEN_AI_SCHEMA_URL);
		expect(resource["service.name"]).toBe(AGENT_NAME);
		expect(resource["service.version"]).toBe(AGENT_VERSION);
	});
});

describe("agent, workflow, plan, and tool spans", () => {
	test("all four span kinds are modelled", () => {
		expect(GEN_AI_SPAN_KINDS).toEqual(["workflow", "agent", "plan", "tool"]);
	});

	test("only kinds with a published enum member carry gen_ai.operation.name", () => {
		expect(GEN_AI_OPERATION_NAMES.agent).toBe("invoke_agent");
		expect(GEN_AI_OPERATION_NAMES.tool).toBe("execute_tool");
		expect(GEN_AI_OPERATION_NAMES.workflow).toBeUndefined();
		expect(GEN_AI_OPERATION_NAMES.plan).toBeUndefined();
	});

	test("an unregistered kind is never smuggled into the enum attribute", () => {
		const attrs = genAiSpanAttributes({ kind: "workflow", target: "failsafe run" });
		expect(attrs["gen_ai.operation.name"]).toBeUndefined();
		expect(attrs.genai_span_kind).toBe("workflow");
		expect(attrs.genai_workflow_name).toBe("failsafe run");
	});

	test("a plan span is labelled by kind and carries its plan id", () => {
		const attrs = genAiSpanAttributes({ kind: "plan", target: "plan_42" });
		expect(attrs["gen_ai.operation.name"]).toBeUndefined();
		expect(attrs.genai_span_kind).toBe("plan");
		expect(attrs.genai_plan_id).toBe("plan_42");
	});

	test("a tool span carries the tool triple and no workflow/plan fields", () => {
		const attrs = genAiSpanAttributes({ kind: "tool", target: "failsafe_diagnose" });
		expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
		expect(attrs["gen_ai.tool.name"]).toBe("failsafe_diagnose");
		expect(attrs["gen_ai.tool.type"]).toBe("function");
		expect(attrs.genai_span_kind).toBeUndefined();
		expect(attrs.genai_workflow_name).toBeUndefined();
	});

	test("an agent span carries the operation name but no tool fields", () => {
		const attrs = genAiSpanAttributes({ kind: "agent", target: "failsafe" });
		expect(attrs["gen_ai.operation.name"]).toBe("invoke_agent");
		expect(attrs["gen_ai.tool.name"]).toBeUndefined();
		expect(attrs["gen_ai.tool.type"]).toBeUndefined();
	});

	test("every span kind carries the agent version", () => {
		for (const kind of GEN_AI_SPAN_KINDS) {
			const attrs = genAiSpanAttributes({ kind, target: "t" });
			expect(attrs["gen_ai.agent.name"]).toBe(AGENT_NAME);
			expect(attrs["gen_ai.agent.version"]).toBe(AGENT_VERSION);
			expect(attrs["gen_ai.schema_url"]).toBe(GEN_AI_SCHEMA_URL);
		}
	});

	test("optional correlation ids are omitted rather than invented", () => {
		const bare = genAiSpanAttributes({ kind: "tool", target: "t" });
		expect(bare["gen_ai.conversation.id"]).toBeUndefined();
		expect(bare["gen_ai.tool.call.id"]).toBeUndefined();

		const full = genAiSpanAttributes({
			kind: "tool",
			target: "t",
			conversation_id: "conv_1",
			tool_call_id: "call_1",
		});
		expect(full["gen_ai.conversation.id"]).toBe("conv_1");
		expect(full["gen_ai.tool.call.id"]).toBe("call_1");
	});

	test("usage is mapped only when supplied", () => {
		expect(
			genAiSpanAttributes({ kind: "tool", target: "t" })["gen_ai.usage.input_tokens"],
		).toBeUndefined();
		const attrs = genAiSpanAttributes({
			kind: "tool",
			target: "t",
			usage: { input_tokens: 10, output_tokens: 2 },
		});
		expect(attrs["gen_ai.usage.input_tokens"]).toBe(10);
		expect(attrs["gen_ai.usage.output_tokens"]).toBe(2);
	});

	test("span names follow {operation} {target}, falling back to {kind} {target}", () => {
		expect(genAiSpanName("tool", "failsafe_diagnose")).toBe("execute_tool failsafe_diagnose");
		expect(genAiSpanName("agent", "failsafe")).toBe("invoke_agent failsafe");
		expect(genAiSpanName("workflow", "failsafe run")).toBe("workflow failsafe run");
		expect(genAiSpanName("plan", "plan_42")).toBe("plan plan_42");
	});
});

describe("exception events", () => {
	test("an Error produces type, message, stacktrace, and escaped", () => {
		const err = new TypeError("boom");
		const event = exceptionEvent(err, { escaped: true });
		expect(event.name).toBe(EXCEPTION_EVENT_NAME);
		expect(event.attributes["exception.type"]).toBe("TypeError");
		expect(event.attributes["exception.message"]).toBe("boom");
		expect(typeof event.attributes["exception.stacktrace"]).toBe("string");
		expect(event.attributes["exception.escaped"]).toBe(true);
	});

	test("escaped defaults to false: handled and fatal are different facts", () => {
		expect(exceptionEvent(new Error("x")).attributes["exception.escaped"]).toBe(false);
	});

	test("a non-Error throw still yields a well-formed event", () => {
		const event = exceptionEvent("just a string");
		expect(event.attributes["exception.type"]).toBe("string");
		expect(event.attributes["exception.message"]).toBe("just a string");
		expect(event.attributes["exception.stacktrace"]).toBeUndefined();
	});
});

describe("exception events pass through the capture gate", () => {
	function sink() {
		const events: Array<{ name: string; attributes: Record<string, unknown> }> = [];
		return {
			events,
			addEvent(name: string, attributes?: Record<string, string | number | boolean>) {
				events.push({ name, attributes: { ...(attributes ?? {}) } });
			},
		};
	}

	test("the exception class is metadata; its message and stack are not", () => {
		expect(classifyAttribute("exception.type", "TypeError")).toBe("metadata");
		expect(classifyAttribute("exception.message", "boom")).toBe("content");
		expect(classifyAttribute("exception.stacktrace", "at f()")).toBe("content");
	});

	test("in the default metadata mode no stack trace reaches the sink", () => {
		const s = sink();
		recordExceptionEvent(s, new Error("token=sk-abcdefghijklmnop"), { escaped: true });
		expect(s.events).toHaveLength(1);
		expect(s.events[0].name).toBe("exception");
		expect(s.events[0].attributes["exception.type"]).toBe("Error");
		expect(s.events[0].attributes["exception.stacktrace"]).toBeUndefined();
		expect(s.events[0].attributes["exception.message"]).toBeUndefined();
		expect(s.events[0].attributes["exception.escaped"]).toBe(true);
	});

	test("in none mode the event is emitted empty rather than skipped", () => {
		const s = sink();
		process.env.FAILSAFE_TELEMETRY_CAPTURE = "none";
		try {
			recordExceptionEvent(s, new Error("boom"));
		} finally {
			// biome-ignore lint/performance/noDelete: env vars must be removed.
			delete process.env.FAILSAFE_TELEMETRY_CAPTURE;
		}
		expect(s.events).toHaveLength(1);
		expect(s.events[0].attributes).toEqual({});
	});

	test("in redacted-content mode the message is emitted with secrets removed", () => {
		const s = sink();
		process.env.FAILSAFE_TELEMETRY_CAPTURE = "redacted-content";
		try {
			recordExceptionEvent(s, new Error("failed with token=sk-abcdefghijklmnopqrst"));
		} finally {
			// biome-ignore lint/performance/noDelete: env vars must be removed.
			delete process.env.FAILSAFE_TELEMETRY_CAPTURE;
		}
		const message = String(s.events[0].attributes["exception.message"]);
		expect(message).toContain("failed with");
		expect(message).not.toContain("sk-abcdefghijklmnopqrst");
	});

	test("event attribute keys are emitted verbatim, not namespaced under failsafe.*", () => {
		const s = sink();
		recordExceptionEvent(s, new Error("boom"));
		for (const key of Object.keys(s.events[0].attributes)) {
			expect(key.startsWith("failsafe.")).toBe(false);
		}
	});

	test("recordExceptionEvent returns the policy counters", () => {
		const counters = recordExceptionEvent(sink(), new Error("boom"));
		// message + stacktrace withheld by the default metadata mode.
		expect(counters.dropped_mode).toBe(2);
	});
});

describe("single-writer invariant for events", () => {
	test("addEvent is called from exactly one place in src/", async () => {
		const root = new URL("../../src/", import.meta.url).pathname;
		const files = new Bun.Glob("**/*.ts").scanSync(root);
		const callSites: string[] = [];
		for (const rel of files) {
			const text = await Bun.file(`${root}${rel}`).text();
			for (const [i, line] of text.split("\n").entries()) {
				if (/\.addEvent\(/.test(line)) callSites.push(`${rel}:${i + 1}`);
			}
		}
		expect(callSites).toHaveLength(1);
		expect(callSites[0]).toStartWith("telemetry/otel.ts:");
	});

	test("no module outside genai-schema.ts hard-codes a gen_ai attribute name", async () => {
		const root = new URL("../../src/", import.meta.url).pathname;
		const files = new Bun.Glob("**/*.ts").scanSync(root);
		const offenders: string[] = [];
		for (const rel of files) {
			if (rel === "telemetry/genai-schema.ts") continue;
			// The trace ingest keep-list reads *incoming* attributes from other
			// producers; it is not emitting under our schema.
			if (rel === "trace/normalize.ts") continue;
			const text = await Bun.file(`${root}${rel}`).text();
			for (const [i, line] of text.split("\n").entries()) {
				if (/"gen_ai\.[a-z_.]+":/.test(line)) offenders.push(`${rel}:${i + 1}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("capture policy classification of the new keys", () => {
	test("pinned constants and closed enums are metadata", () => {
		expect(classifyAttribute("gen_ai.schema_url", GEN_AI_SCHEMA_URL)).toBe("metadata");
		expect(classifyAttribute("gen_ai.agent.name", AGENT_NAME)).toBe("metadata");
		expect(classifyAttribute("gen_ai.agent.version", AGENT_VERSION)).toBe("metadata");
		expect(classifyAttribute("genai_span_kind", "workflow")).toBe("metadata");
	});

	test("caller-supplied identifiers and names must earn redacted-content", () => {
		expect(classifyAttribute("gen_ai.conversation.id", "conv_1")).toBe("content");
		expect(classifyAttribute("gen_ai.tool.call.id", "call_1")).toBe("content");
		expect(classifyAttribute("genai_workflow_name", "failsafe run ./secret.sh")).toBe("content");
		expect(classifyAttribute("genai_plan_id", "plan_1")).toBe("content");
	});

	test("a workflow span in metadata mode keeps the kind and drops the target", () => {
		const { attributes } = applyCapturePolicy(
			genAiSpanAttributes({ kind: "workflow", target: "failsafe run ./deploy.sh" }),
		);
		expect(attributes.genai_span_kind).toBe("workflow");
		expect(attributes.genai_workflow_name).toBeUndefined();
		expect(attributes["gen_ai.agent.version"]).toBe(AGENT_VERSION);
	});
});
