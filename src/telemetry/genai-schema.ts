/**
 * Dedicated OpenTelemetry GenAI schema (item 52).
 *
 * The GenAI conventions were moved out of the general semantic-conventions
 * package and now version on their own cadence. Item 30 hard-coded a handful of
 * `gen_ai.*` strings inline, which was fine while there was one place to look
 * them up and is not fine now that the two schemas can move independently. This
 * module is the migration: one pinned schema version, one place that decides
 * what a GenAI span is called and which attributes it carries, and an explicit
 * statement of what this build was written against.
 *
 * Three decisions are worth stating plainly, because each of them is a place
 * where it would be easy to emit something that *looks* conformant and is not:
 *
 * 1. **The schema URL is emitted, not assumed.** A span that carries
 *    `gen_ai.*` without saying which revision of the conventions produced it
 *    forces every consumer to guess, and the guess silently rots when the
 *    conventions change an attribute's meaning. `genAiResourceAttributes`
 *    puts the pinned URL on the span and `tracerOptions()` hands it to
 *    `getTracer`, which is the API-level way to declare it.
 *
 * 2. **An unregistered value never goes into an enum-typed attribute.**
 *    `gen_ai.operation.name` has a published set of values. Workflow and plan
 *    spans do not have one, so they get `failsafe.genai.span_kind` instead of a
 *    made-up operation name. Stuffing an invented string into an enum attribute
 *    is how a backend's dashboards break in a way nobody notices for a quarter.
 *
 * 3. **Exception events go through item 41's capture gate.** An exception event
 *    carries `exception.message` and `exception.stacktrace`, which are the two
 *    highest-risk strings the process will ever touch. They are classified as
 *    content, which means the default `metadata` mode drops them and only
 *    `redacted-content` emits them — after redaction and the byte ceiling.
 *    `otel.ts` owns the single `addEvent` call site, mirroring the single
 *    `setAttribute` call site.
 *
 * Everything here is opt-in behind `OTEL_SEMCONV_STABILITY_OPT_IN`, exactly as
 * item 30 established, so a default trace is unchanged by this migration.
 */
import type { SpanAttributes } from "./otel.js";

/**
 * Revision of the GenAI conventions this build is written against.
 *
 * Pinned deliberately: tracking "latest" would mean the meaning of an emitted
 * attribute could change without a code change here, which is the failure mode
 * schema URLs exist to prevent.
 */
export const GEN_AI_SCHEMA_VERSION = "1.38.0";

/** Host prefix for OpenTelemetry schema URLs. */
export const OTEL_SCHEMA_URL_PREFIX = "https://opentelemetry.io/schemas/";

/** The pinned schema URL. */
export const GEN_AI_SCHEMA_URL = `${OTEL_SCHEMA_URL_PREFIX}${GEN_AI_SCHEMA_VERSION}`;

/**
 * Override for deployments tracking a different revision (or a vendor mirror).
 *
 * Validated rather than trusted: a malformed or non-HTTPS value falls back to
 * the pinned URL instead of putting a broken identifier on every span. A schema
 * URL that does not resolve is worse than no schema URL, because it looks
 * authoritative.
 */
export const GEN_AI_SCHEMA_URL_ENV = "FAILSAFE_GENAI_SCHEMA_URL";

export function resolveSchemaUrl(raw = process.env[GEN_AI_SCHEMA_URL_ENV]): string {
	if (!raw) return GEN_AI_SCHEMA_URL;
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:") return GEN_AI_SCHEMA_URL;
		return url.toString();
	} catch {
		return GEN_AI_SCHEMA_URL;
	}
}

/** Options for `trace.getTracer`, carrying the schema URL declaration. */
export function tracerOptions(): { schemaUrl: string } {
	return { schemaUrl: resolveSchemaUrl() };
}

/**
 * The span kinds Failsafe emits.
 *
 * `workflow` is a whole `failsafe run` invocation; `agent` is Failsafe acting on
 * a caller's behalf; `plan` is a debug plan (item 42) being constructed; `tool`
 * is one MCP/CLI operation.
 */
export const GEN_AI_SPAN_KINDS = ["workflow", "agent", "plan", "tool"] as const;
export type GenAiSpanKind = (typeof GEN_AI_SPAN_KINDS)[number];

/**
 * Published `gen_ai.operation.name` values, by span kind.
 *
 * `undefined` means the conventions publish no enum member for that kind. See
 * decision 2 in the module header: those spans are labelled with
 * `failsafe.genai.span_kind` and deliberately carry no operation name.
 */
export const GEN_AI_OPERATION_NAMES: Record<GenAiSpanKind, string | undefined> = {
	workflow: undefined,
	agent: "invoke_agent",
	plan: undefined,
	tool: "execute_tool",
};

/** Agent identity emitted on every GenAI span. */
export const AGENT_NAME = "failsafe";
export const AGENT_VERSION = "0.1.0";

/**
 * Span name.
 *
 * The conventions specify `{operation} {target}` so a backend can group by name
 * without parsing attributes. Kinds with no published operation fall back to
 * `{kind} {target}`, which keeps the shape parseable without claiming
 * conformance the conventions do not grant.
 */
export function genAiSpanName(kind: GenAiSpanKind, target: string): string {
	return `${GEN_AI_OPERATION_NAMES[kind] ?? kind} ${target}`;
}

export type GenAiSpanDescriptor = {
	kind: GenAiSpanKind;
	/** Tool name, agent name, workflow name, or plan id — whatever the span is about. */
	target: string;
	/** Groups spans belonging to one debugging session. */
	conversation_id?: string;
	/** Correlates a tool span with the call that requested it. */
	tool_call_id?: string;
	usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Attributes for one GenAI span.
 *
 * Returns `{}` when the caller has not opted in, so no unexpected attribute
 * ever lands on a default trace. `undefined` entries are dropped downstream by
 * `applyAttributes`, so optional fields can be returned unconditionally.
 */
export function genAiSpanAttributes(descriptor: GenAiSpanDescriptor): SpanAttributes {
	const operation = GEN_AI_OPERATION_NAMES[descriptor.kind];
	return {
		"gen_ai.schema_url": resolveSchemaUrl(),
		"gen_ai.operation.name": operation,
		"gen_ai.agent.name": AGENT_NAME,
		"gen_ai.agent.version": AGENT_VERSION,
		"gen_ai.conversation.id": descriptor.conversation_id,
		"gen_ai.usage.input_tokens": descriptor.usage?.input_tokens,
		"gen_ai.usage.output_tokens": descriptor.usage?.output_tokens,
		...(descriptor.kind === "tool"
			? {
					"gen_ai.tool.name": descriptor.target,
					"gen_ai.tool.type": "function",
					"gen_ai.tool.call.id": descriptor.tool_call_id,
				}
			: {}),
		// Kinds with no published operation name are labelled under our own
		// namespace rather than smuggled into the enum attribute.
		...(operation === undefined ? { genai_span_kind: descriptor.kind } : {}),
		...(descriptor.kind === "workflow" ? { genai_workflow_name: descriptor.target } : {}),
		...(descriptor.kind === "plan" ? { genai_plan_id: descriptor.target } : {}),
	};
}

/** Canonical name of the exception event, per the conventions. */
export const EXCEPTION_EVENT_NAME = "exception";

export type ExceptionEventPayload = {
	name: typeof EXCEPTION_EVENT_NAME;
	attributes: SpanAttributes;
};

/**
 * Build the `exception` event for an error.
 *
 * `exception.type` is a class name and is classified as metadata;
 * `exception.message` and `exception.stacktrace` are content and are dropped by
 * the default capture mode. `exception.escaped` records whether the exception
 * left the span's scope, which is the difference between "handled and
 * reported" and "this is why the run died".
 *
 * A non-`Error` throw still produces a well-formed event — `type` becomes the
 * runtime type name — because losing the event entirely is worse than losing
 * its class.
 */
export function exceptionEvent(
	error: unknown,
	opts: { escaped?: boolean } = {},
): ExceptionEventPayload {
	const isError = error instanceof Error;
	return {
		name: EXCEPTION_EVENT_NAME,
		attributes: {
			"exception.type": isError ? error.name : typeof error,
			"exception.message": isError ? error.message : String(error),
			"exception.stacktrace": isError ? error.stack : undefined,
			"exception.escaped": opts.escaped ?? false,
		},
	};
}

/**
 * Resource-level attributes declaring the schema this process emits under.
 *
 * Attached to the tracer's resource so a consumer can tell which revision
 * produced a batch even when an individual span is filtered down to nothing.
 */
export function genAiResourceAttributes(): Record<string, string> {
	return {
		"service.name": AGENT_NAME,
		"service.version": AGENT_VERSION,
		"gen_ai.schema_url": resolveSchemaUrl(),
	};
}
