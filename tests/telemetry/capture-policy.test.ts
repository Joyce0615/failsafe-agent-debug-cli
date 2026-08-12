import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	CAPTURE_MODE_ENV,
	DEFAULT_CAPTURE_POLICY,
	HIGH_CARDINALITY_PLACEHOLDER,
	type CapturePolicy,
	applyCapturePolicy,
	capturePolicySpanAttributes,
	capturePolicyStats,
	classifyAttribute,
	configureTelemetryCapture,
	getCapturePolicy,
	resetCapturePolicy,
	resolveCapturePolicy,
} from "../../src/telemetry/capture-policy.js";
import { applyAttributes } from "../../src/telemetry/otel.js";
import { DEFAULT_CONFIG, FailsafeConfigSchema } from "../../src/types/config.js";

/** Recording sink standing in for a Span; sees exactly what an exporter would. */
function recorder() {
	const seen: Record<string, string | number | boolean> = {};
	return {
		seen,
		setAttribute(key: string, value: string | number | boolean) {
			seen[key] = value;
		},
	};
}

function policy(overrides: Partial<CapturePolicy> = {}): CapturePolicy {
	return { ...DEFAULT_CAPTURE_POLICY, ...overrides };
}

beforeEach(() => {
	resetCapturePolicy();
	delete process.env[CAPTURE_MODE_ENV];
});

afterEach(() => {
	resetCapturePolicy();
	delete process.env[CAPTURE_MODE_ENV];
});

describe("attribute classification", () => {
	test("numbers and booleans are metadata regardless of key", () => {
		expect(classifyAttribute("anything_at_all", 42)).toBe("metadata");
		expect(classifyAttribute("raw_output", true)).toBe("metadata");
	});

	test("allowlisted string keys are metadata", () => {
		expect(classifyAttribute("failure_type", "assertion_error")).toBe("metadata");
		expect(classifyAttribute("gen_ai.tool.name", "failsafe_analyze")).toBe("metadata");
	});

	test("unknown string keys are content (deny by default)", () => {
		expect(classifyAttribute("error_message", "boom")).toBe("content");
		expect(classifyAttribute("some_future_field", "text")).toBe("content");
	});
});

describe("capture modes", () => {
	const attrs = {
		failure_type: "assertion_error",
		parser_count: 2,
		error_message: "expected 3 got 4",
		absent: undefined,
	};

	test("none emits no attributes and counts every drop", () => {
		const { attributes, counters } = applyCapturePolicy(attrs, policy({ mode: "none" }));
		expect(Object.keys(attributes)).toHaveLength(0);
		expect(counters.dropped_mode).toBe(3);
	});

	test("metadata keeps allowlisted fields and withholds content", () => {
		const { attributes, counters } = applyCapturePolicy(attrs, policy({ mode: "metadata" }));
		expect(attributes).toEqual({ failure_type: "assertion_error", parser_count: 2 });
		expect(counters.dropped_mode).toBe(1);
	});

	test("redacted-content admits content after redaction", () => {
		const { attributes, counters } = applyCapturePolicy(
			attrs,
			policy({ mode: "redacted-content" }),
		);
		expect(attributes.error_message).toBe("expected 3 got 4");
		expect(counters.dropped_mode).toBe(0);
	});

	test("undefined values are dropped silently, not counted", () => {
		const { counters } = applyCapturePolicy({ absent: undefined }, policy());
		expect(counters.dropped_mode).toBe(0);
		expect(counters.dropped_limit).toBe(0);
	});
});

describe("content redaction happens before capture", () => {
	test("secrets are stripped from admitted content", () => {
		const { attributes, counters } = applyCapturePolicy(
			{ error_message: "auth failed with sk-abcdefghijklmnopqrstuvwxyz012345" },
			policy({ mode: "redacted-content" }),
		);
		expect(attributes.error_message).toBe("auth failed with [REDACTED]");
		expect(counters.redacted).toBe(1);
	});

	test("a secret never reaches the attribute sink", () => {
		const sink = recorder();
		applyAttributes(sink, { error_message: "token ghp_" + "a".repeat(36) });
		for (const value of Object.values(sink.seen)) {
			expect(String(value)).not.toContain("ghp_");
		}
	});

	test("metadata mode keeps content out of the sink entirely", () => {
		const sink = recorder();
		configureTelemetryCapture(DEFAULT_CONFIG);
		applyAttributes(sink, { failure_type: "type_error", error_message: "secret business logic" });
		expect(sink.seen["failsafe.failure_type"]).toBe("type_error");
		expect(sink.seen["failsafe.error_message"]).toBeUndefined();
	});
});

describe("ceilings", () => {
	test("byte ceiling truncates on a character boundary", () => {
		const { attributes, counters } = applyCapturePolicy(
			{ error_message: "é".repeat(200) },
			policy({ mode: "redacted-content", max_value_bytes: 40 }),
		);
		const out = attributes.error_message as string;
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(40);
		expect(out).toContain("[TRUNCATED]");
		expect(out).not.toContain("\uFFFD");
		expect(counters.truncated).toBe(1);
	});

	test("attribute-count ceiling drops the overflow", () => {
		const many: Record<string, number> = {};
		for (let i = 0; i < 10; i++) many[`n${i}`] = i;
		const { attributes, counters } = applyCapturePolicy(many, policy({ max_attributes: 4 }));
		expect(Object.keys(attributes)).toHaveLength(4);
		expect(counters.dropped_limit).toBe(6);
	});

	test("cardinality ceiling collapses novel values per key", () => {
		const p = policy({ mode: "redacted-content", max_value_cardinality: 2 });
		applyCapturePolicy({ error_message: "a" }, p);
		applyCapturePolicy({ error_message: "b" }, p);
		const third = applyCapturePolicy({ error_message: "c" }, p);
		expect(third.attributes.error_message).toBe(HIGH_CARDINALITY_PLACEHOLDER);
		expect(third.counters.high_cardinality).toBe(1);
		// A previously seen value is still admitted.
		const repeat = applyCapturePolicy({ error_message: "a" }, p);
		expect(repeat.attributes.error_message).toBe("a");
	});
});

describe("policy resolution", () => {
	test("defaults to metadata with no config or env", () => {
		expect(getCapturePolicy().mode).toBe("metadata");
	});

	test("config drives mode and ceilings", () => {
		const config = FailsafeConfigSchema.parse({
			schema_version: "0.1",
			telemetry: { capture_mode: "redacted-content", max_attribute_bytes: 128 },
		});
		const resolved = configureTelemetryCapture(config);
		expect(resolved.mode).toBe("redacted-content");
		expect(resolved.max_value_bytes).toBe(128);
		expect(getCapturePolicy().mode).toBe("redacted-content");
	});

	test("environment overrides the configured mode", () => {
		process.env[CAPTURE_MODE_ENV] = "none";
		const config = FailsafeConfigSchema.parse({
			schema_version: "0.1",
			telemetry: { capture_mode: "redacted-content" },
		});
		expect(resolveCapturePolicy(config).mode).toBe("none");
	});

	test("an unrecognized environment value is ignored", () => {
		process.env[CAPTURE_MODE_ENV] = "everything";
		expect(resolveCapturePolicy().mode).toBe("metadata");
	});
});

describe("single-writer invariant", () => {
	// The policy is only a guarantee if nothing else can write to a span. Lock
	// that in at the source level so a future call site can't route around it.
	test("setAttribute is called from exactly one place in src/", async () => {
		const root = new URL("../../src/", import.meta.url).pathname;
		const files = new Bun.Glob("**/*.ts").scanSync(root);
		const callSites: string[] = [];
		for (const rel of files) {
			const text = await Bun.file(`${root}${rel}`).text();
			for (const [i, line] of text.split("\n").entries()) {
				if (/\.setAttribute\(/.test(line)) callSites.push(`${rel}:${i + 1}`);
			}
		}
		expect(callSites).toHaveLength(1);
		expect(callSites[0]).toStartWith("telemetry/otel.ts:");
	});
});

describe("counters", () => {
	test("cumulative stats accumulate across batches", () => {
		applyCapturePolicy({ a: "x" }, policy({ mode: "metadata" }));
		applyCapturePolicy({ b: "y" }, policy({ mode: "metadata" }));
		expect(capturePolicyStats().dropped_mode).toBe(2);
	});

	test("reset clears counters and the cardinality registry", () => {
		applyCapturePolicy({ a: "x" }, policy({ mode: "metadata" }));
		resetCapturePolicy();
		expect(capturePolicyStats().dropped_mode).toBe(0);
	});

	test("summary attributes report only non-zero counters", () => {
		const summary = capturePolicySpanAttributes({
			dropped_mode: 2,
			dropped_limit: 1,
			truncated: 0,
			redacted: 3,
			high_cardinality: 0,
		});
		expect(summary.capture_dropped_fields).toBe(3);
		expect(summary.capture_redacted_fields).toBe(3);
		expect(summary.capture_truncated_fields).toBeUndefined();
		expect(summary.capture_high_cardinality_fields).toBeUndefined();
		expect(summary.capture_mode).toBe("metadata");
	});

	test("summary attributes survive their own policy in metadata mode", () => {
		const summary = capturePolicySpanAttributes({
			dropped_mode: 1,
			dropped_limit: 0,
			truncated: 0,
			redacted: 0,
			high_cardinality: 0,
		});
		const { attributes } = applyCapturePolicy(summary, policy({ mode: "metadata" }));
		expect(attributes.capture_mode).toBe("metadata");
		expect(attributes.capture_dropped_fields).toBe(1);
	});
});
