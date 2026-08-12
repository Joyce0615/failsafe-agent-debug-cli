/**
 * Telemetry content-capture policy (item 41).
 *
 * Every attribute that reaches a span passes through this module *before*
 * `span.setAttribute` is called, which means before the `BatchSpanProcessor`
 * buffers anything and long before an exporter sees it. There is deliberately
 * no second path into the span: `applyAttributes` in `otel.ts` is the only
 * writer and it always calls `applyCapturePolicy` first.
 *
 * The policy has three parts:
 *
 * 1. **Mode** — `none | metadata | redacted-content`. Deny-by-default: a string
 *    value is treated as raw *content* unless its key is on the canonical
 *    metadata allowlist, so a new attribute added anywhere in the codebase is
 *    withheld until it is explicitly classified.
 * 2. **Ceilings** — a per-value byte ceiling, a per-span attribute-count
 *    ceiling, and a process-wide per-key cardinality ceiling. These bound both
 *    the payload an exporter buffers and the label explosion a backend has to
 *    index.
 * 3. **Counters** — everything withheld, truncated, redacted, or collapsed is
 *    counted, so a dropped field is observable as a number even when its value
 *    is not. Counters are readable via `capturePolicyStats()`.
 */
import { redactSecrets } from "../security/redaction.js";
import type { FailsafeConfig } from "../types/config.js";
import type { SpanAttributes } from "./otel.js";

/**
 * How much of a value Failsafe is permitted to put on a span.
 *
 * - `none`: no attributes at all. Spans still carry name, timing, and status,
 *   which is enough for latency work with zero payload risk.
 * - `metadata`: only allowlisted low-cardinality metadata (counts, enums,
 *   confidences, schema version). This is the default.
 * - `redacted-content`: metadata plus content-bearing values, each run through
 *   the secret redactor and the byte ceiling first.
 */
export type CaptureMode = "none" | "metadata" | "redacted-content";

export const CAPTURE_MODES: readonly CaptureMode[] = [
	"none",
	"metadata",
	"redacted-content",
] as const;

/** Environment override, checked at call time so tests can flip it. */
export const CAPTURE_MODE_ENV = "FAILSAFE_TELEMETRY_CAPTURE";

export type CapturePolicy = {
	mode: CaptureMode;
	/** Byte ceiling for any single attribute value (UTF-8 bytes). */
	max_value_bytes: number;
	/** Ceiling on attributes accepted per `setAttributes` batch. */
	max_attributes: number;
	/** Distinct values tolerated per attribute key, process-wide. */
	max_value_cardinality: number;
};

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
	mode: "metadata",
	max_value_bytes: 512,
	max_attributes: 64,
	max_value_cardinality: 64,
};

/** Marker substituted for a value collapsed by the cardinality ceiling. */
export const HIGH_CARDINALITY_PLACEHOLDER = "[HIGH_CARDINALITY]";
/** Suffix appended to a value shortened by the byte ceiling. */
export const TRUNCATION_SUFFIX = "…[TRUNCATED]";

/**
 * Canonical metadata keys.
 *
 * These are the string-valued attributes the span builders in `attributes.ts`
 * emit that are known to be enums, identifiers, or schema constants — never
 * user output, source text, file content, or error messages. Numeric and
 * boolean values are metadata by construction and are not listed here.
 */
const METADATA_STRING_KEYS: readonly string[] = [
	"schema_version",
	"status",
	"failure_type",
	"severity",
	"category",
	"kind",
	"rule_source",
	"rule_id",
	"enforcement",
	"parser_matched",
	"capture_mode",
	"gen_ai.operation.name",
	"gen_ai.tool.name",
	"gen_ai.tool.type",
];

const METADATA_KEY_SET = new Set(METADATA_STRING_KEYS);

export type AttributeClass = "metadata" | "content";

/**
 * Classify one attribute.
 *
 * Numbers and booleans cannot carry raw content, so they are always metadata.
 * Strings are content unless explicitly allowlisted — the deny-by-default half
 * of this policy.
 */
export function classifyAttribute(key: string, value: string | number | boolean): AttributeClass {
	if (typeof value !== "string") return "metadata";
	return METADATA_KEY_SET.has(key) ? "metadata" : "content";
}

export type CaptureCounters = {
	/** Withheld because the mode forbids that attribute class. */
	dropped_mode: number;
	/** Withheld because the per-batch attribute ceiling was reached. */
	dropped_limit: number;
	/** Shortened by the byte ceiling. */
	truncated: number;
	/** Had at least one secret pattern removed. */
	redacted: number;
	/** Collapsed by the per-key cardinality ceiling. */
	high_cardinality: number;
};

function emptyCounters(): CaptureCounters {
	return { dropped_mode: 0, dropped_limit: 0, truncated: 0, redacted: 0, high_cardinality: 0 };
}

const cumulative: CaptureCounters = emptyCounters();
const cardinality = new Map<string, Set<string>>();

let activePolicy: CapturePolicy | null = null;

function parseMode(raw: string | undefined): CaptureMode | null {
	if (!raw) return null;
	const normalized = raw.trim().toLowerCase();
	return (CAPTURE_MODES as readonly string[]).includes(normalized)
		? (normalized as CaptureMode)
		: null;
}

/**
 * Build a policy from config, then let the environment override the mode.
 *
 * Environment wins so an operator can clamp capture down (or, deliberately, up)
 * on a single run without editing a checked-in config file. An unrecognized
 * value is ignored rather than failing the run — telemetry must never be able
 * to break the command being debugged.
 */
export function resolveCapturePolicy(config?: FailsafeConfig): CapturePolicy {
	const t = config?.telemetry;
	const base: CapturePolicy = t
		? {
				mode: t.capture_mode,
				max_value_bytes: t.max_attribute_bytes,
				max_attributes: t.max_attributes_per_span,
				max_value_cardinality: t.max_attribute_cardinality,
			}
		: { ...DEFAULT_CAPTURE_POLICY };
	const envMode = parseMode(process.env[CAPTURE_MODE_ENV]);
	if (envMode) base.mode = envMode;
	return base;
}

/**
 * Install the policy derived from a loaded config. Called from `loadConfig()`
 * so every CLI command and MCP tool call shares one gate.
 */
export function configureTelemetryCapture(config: FailsafeConfig): CapturePolicy {
	activePolicy = resolveCapturePolicy(config);
	return activePolicy;
}

/** The policy in force. Falls back to defaults + environment when unconfigured. */
export function getCapturePolicy(): CapturePolicy {
	return activePolicy ?? resolveCapturePolicy();
}

/** Cumulative counters since process start (or the last reset). */
export function capturePolicyStats(): CaptureCounters {
	return { ...cumulative };
}

/** Clear the installed policy, cardinality registry, and counters (tests). */
export function resetCapturePolicy(): void {
	activePolicy = null;
	cardinality.clear();
	for (const key of Object.keys(cumulative) as (keyof CaptureCounters)[]) {
		cumulative[key] = 0;
	}
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Truncate on a UTF-8 byte boundary so a multi-byte char is never split. */
function truncateToBytes(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const budget = Math.max(0, maxBytes - byteLength(TRUNCATION_SUFFIX));
	const buf = Buffer.from(value, "utf8").subarray(0, budget);
	// `toString` on a partial buffer yields U+FFFD for a split char; drop it.
	return `${buf.toString("utf8").replace(/\uFFFD+$/, "")}${TRUNCATION_SUFFIX}`;
}

function checkCardinality(key: string, value: string, ceiling: number): boolean {
	let seen = cardinality.get(key);
	if (!seen) {
		seen = new Set<string>();
		cardinality.set(key, seen);
	}
	if (seen.has(value)) return true;
	if (seen.size >= ceiling) return false;
	seen.add(value);
	return true;
}

export type CaptureResult = {
	/** Attributes cleared for the span. */
	attributes: SpanAttributes;
	/** What this batch withheld or altered. */
	counters: CaptureCounters;
};

/**
 * Evaluate the capture policy over one batch of attributes.
 *
 * Pure with respect to its inputs apart from the process-wide cardinality
 * registry and cumulative counters. `undefined` values are dropped silently —
 * they are how the span builders express "field not applicable" and were never
 * going to be exported.
 */
export function applyCapturePolicy(
	attrs: SpanAttributes,
	policy: CapturePolicy = getCapturePolicy(),
): CaptureResult {
	const counters = emptyCounters();
	const attributes: SpanAttributes = {};

	if (policy.mode === "none") {
		for (const value of Object.values(attrs)) {
			if (value !== undefined) counters.dropped_mode++;
		}
		accumulate(counters);
		return { attributes, counters };
	}

	let accepted = 0;
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined) continue;

		const cls = classifyAttribute(key, value);
		if (cls === "content" && policy.mode !== "redacted-content") {
			counters.dropped_mode++;
			continue;
		}

		if (accepted >= policy.max_attributes) {
			counters.dropped_limit++;
			continue;
		}

		if (typeof value !== "string") {
			attributes[key] = value;
			accepted++;
			continue;
		}

		let out = value;
		if (cls === "content") {
			const { redacted, matched } = redactSecrets(out);
			if (matched.length > 0) counters.redacted++;
			out = redacted;
		}
		if (byteLength(out) > policy.max_value_bytes) {
			out = truncateToBytes(out, policy.max_value_bytes);
			counters.truncated++;
		}
		if (!checkCardinality(key, out, policy.max_value_cardinality)) {
			out = HIGH_CARDINALITY_PLACEHOLDER;
			counters.high_cardinality++;
		}

		attributes[key] = out;
		accepted++;
	}

	accumulate(counters);
	return { attributes, counters };
}

function accumulate(counters: CaptureCounters): void {
	cumulative.dropped_mode += counters.dropped_mode;
	cumulative.dropped_limit += counters.dropped_limit;
	cumulative.truncated += counters.truncated;
	cumulative.redacted += counters.redacted;
	cumulative.high_cardinality += counters.high_cardinality;
}

/**
 * Span attributes describing the policy itself.
 *
 * Emitted once per span so a trace records the gate it passed through; without
 * this, an empty attribute set is indistinguishable from a span that simply had
 * nothing to say. All values are numeric or allowlisted, so this survives its
 * own policy in `metadata` mode (and is correctly suppressed in `none`).
 */
export function capturePolicySpanAttributes(counters: CaptureCounters): SpanAttributes {
	const dropped = counters.dropped_mode + counters.dropped_limit;
	return {
		capture_mode: getCapturePolicy().mode,
		capture_dropped_fields: dropped > 0 ? dropped : undefined,
		capture_truncated_fields: counters.truncated > 0 ? counters.truncated : undefined,
		capture_redacted_fields: counters.redacted > 0 ? counters.redacted : undefined,
		capture_high_cardinality_fields:
			counters.high_cardinality > 0 ? counters.high_cardinality : undefined,
	};
}
