import { afterEach, describe, expect, test } from "bun:test";
import {
	GEN_AI_OPT_IN,
	diagnoseSpanAttributes,
	genAiToolAttributes,
	isGenAiSemconvEnabled,
	parseSpanAttributes,
	reproSpanAttributes,
	runErrorSpanAttributes,
	runSpanAttributes,
	verifyErrorSpanAttributes,
	verifySpanAttributes,
} from "../../src/telemetry/attributes.js";
import {
	isTelemetryEnabled,
	shutdownTelemetry,
	spanAttributeKey,
	withSpan,
} from "../../src/telemetry/otel.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { ReproRecord } from "../../src/types/repro.js";

const ENDPOINT_VAR = "OTEL_EXPORTER_OTLP_ENDPOINT";
const SEMCONV_VAR = "OTEL_SEMCONV_STABILITY_OPT_IN";

afterEach(async () => {
	delete process.env[ENDPOINT_VAR];
	delete process.env[SEMCONV_VAR];
	await shutdownTelemetry(200);
});

describe("telemetry (disabled by default)", () => {
	test("isTelemetryEnabled is false without endpoint", () => {
		delete process.env[ENDPOINT_VAR];
		expect(isTelemetryEnabled()).toBe(false);
	});

	test("withSpan runs the fn and returns its value when disabled", async () => {
		delete process.env[ENDPOINT_VAR];
		let attrsCalled = false;
		const result = await withSpan("test.op", async (setAttrs) => {
			setAttrs({ foo: "bar" });
			attrsCalled = true;
			return 42;
		});
		expect(result).toBe(42);
		expect(attrsCalled).toBe(true);
	});

	test("withSpan propagates exceptions when disabled", async () => {
		delete process.env[ENDPOINT_VAR];
		await expect(
			withSpan("test.op", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});

describe("telemetry (enabled)", () => {
	test("isTelemetryEnabled is true with endpoint set", () => {
		process.env[ENDPOINT_VAR] = "http://localhost:4318/v1/traces";
		expect(isTelemetryEnabled()).toBe(true);
	});

	test("withSpan still returns fn value when enabled", async () => {
		process.env[ENDPOINT_VAR] = "http://localhost:4318/v1/traces";
		const result = await withSpan(
			"failsafe.run",
			async (setAttrs) => {
				setAttrs({ status: "failed", failure_type: "test_failure" });
				return "ok";
			},
			{ command: "pytest" },
		);
		expect(result).toBe("ok");
	});

	test("withSpan propagates exceptions when enabled", async () => {
		process.env[ENDPOINT_VAR] = "http://localhost:4318/v1/traces";
		await expect(
			withSpan("failsafe.run", async () => {
				throw new Error("kaboom");
			}),
		).rejects.toThrow("kaboom");
	});
});

// ─── Canonical span attribute set (presence + shape per span) ───────────────
//
// These assert against the single source of truth in src/telemetry/attributes.ts
// so the attribute schema can't silently drift between spans. Every span must
// carry schema_version; each builder must surface its span-specific fields and
// must drop undefined values (withSpan does the dropping at emit time, but the
// builders are responsible for not inventing values).

describe("canonical span attributes", () => {
	test("every span carries the schema version", () => {
		const diagnosis = makeDiagnosis();
		const builders = [
			runSpanAttributes({ status: "failed" }),
			runErrorSpanAttributes({ exit_code: 3 }),
			parseSpanAttributes([]),
			diagnoseSpanAttributes(diagnosis),
			reproSpanAttributes(makeRepro()),
			verifySpanAttributes({ status: "passed" }),
			verifyErrorSpanAttributes({ exit_code: 2 }),
		];
		for (const attrs of builders) {
			expect(attrs.schema_version).toBe(SCHEMA_VERSION);
		}
	});

	test("failsafe.run surfaces status, type, exit code, and token-budget shape", () => {
		const attrs = runSpanAttributes({
			status: "failed",
			failure_type: "test_failure",
			exit_code: 1,
			token_budget: { raw_output_bytes: 2048, compression_ratio: 0.1 },
			parsers: [{ parser: "pytest" }, { parser: "tsc" }],
			redaction: { applied: true },
		});
		expect(attrs.status).toBe("failed");
		expect(attrs.failure_type).toBe("test_failure");
		expect(attrs.exit_code).toBe(1);
		expect(attrs.raw_output_bytes).toBe(2048);
		expect(attrs.compression_ratio).toBe(0.1);
		expect(attrs.parser_count).toBe(2);
		expect(attrs.redaction_applied).toBe(true);
	});

	test("failsafe.run omits optional fields when absent (no invented values)", () => {
		const attrs = runSpanAttributes({ status: "passed" });
		expect(attrs.status).toBe("passed");
		expect(attrs.raw_output_bytes).toBeUndefined();
		expect(attrs.compression_ratio).toBeUndefined();
		expect(attrs.parser_count).toBeUndefined();
		expect(attrs.redaction_applied).toBeUndefined();
	});

	test("failsafe.run error path records error_code and needs_shell", () => {
		const shellErr = runErrorSpanAttributes({ exit_code: 1, needs_shell: true });
		expect(shellErr.status).toBe("error");
		expect(shellErr.error_code).toBe(1);
		expect(shellErr.needs_shell).toBe(true);
		// needs_shell is dropped (not `false`) when the error is unrelated to shell syntax.
		const policyErr = runErrorSpanAttributes({ exit_code: 3 });
		expect(policyErr.error_code).toBe(3);
		expect(policyErr.needs_shell).toBeUndefined();
	});

	test("failsafe.parse surfaces the matched parser and count", () => {
		const empty = parseSpanAttributes([]);
		expect(empty.parser_matched).toBeUndefined();
		expect(empty.parser_count).toBe(0);
		const matched = parseSpanAttributes([
			{ parser: "pytest", failure_type: "test_failure", errors: [] },
			{ parser: "tsc", failure_type: "build_error", errors: [] },
		]);
		expect(matched.parser_matched).toBe("pytest");
		expect(matched.failure_type).toBe("test_failure");
		expect(matched.parser_count).toBe(2);
	});

	test("failsafe.diagnose surfaces severity, category, confidence, and the rule tier", () => {
		const attrs = diagnoseSpanAttributes(makeDiagnosis());
		expect(attrs.failure_type).toBe("test_failure");
		expect(attrs.severity).toBe("error");
		expect(attrs.category).toBe("key_error");
		expect(attrs.confidence).toBe(0.9);
		expect(attrs.rule_source).toBe("declared");
		expect(attrs.rule_id).toBe("rule_kerr");
		expect(attrs.enforcement).toBe("suggest");
		expect(attrs.evidence_count).toBe(1);
	});

	test("failsafe.diagnose omits the rule tier for a built-in (unattributed) diagnosis", () => {
		const bare = makeDiagnosis();
		bare.root_cause = undefined;
		bare.rule_source = undefined;
		bare.rule_id = undefined;
		bare.enforcement = undefined;
		const attrs = diagnoseSpanAttributes(bare);
		expect(attrs.rule_source).toBeUndefined();
		expect(attrs.rule_id).toBeUndefined();
		expect(attrs.enforcement).toBeUndefined();
		expect(attrs.category).toBeUndefined();
		expect(attrs.confidence).toBeUndefined();
		// evidence_count is always present (a number), even at zero.
		expect(attrs.evidence_count).toBe(1);
	});

	test("failsafe.repro surfaces status, kind, and confidence", () => {
		const attrs = reproSpanAttributes(makeRepro());
		expect(attrs.status).toBe("verified");
		expect(attrs.kind).toBe("test_selector");
		expect(attrs.confidence).toBe(0.8);
	});

	test("failsafe.verify surfaces status and the number of checks run", () => {
		const attrs = verifySpanAttributes({
			status: "passed",
			checks: [{ kind: "minimal_repro" }, { kind: "original_command" }],
		});
		expect(attrs.status).toBe("passed");
		expect(attrs.checks_count).toBe(2);
		const errAttrs = verifyErrorSpanAttributes({ exit_code: 2 });
		expect(errAttrs.status).toBe("error");
		expect(errAttrs.error_code).toBe(2);
	});
});

// ─── OpenTelemetry GenAI semantic conventions (item 30) ────────────────────
//
// Opt-in only, per the spec's stability-transition guidance: the gen_ai.* keys
// appear if and only if OTEL_SEMCONV_STABILITY_OPT_IN lists
// gen_ai_latest_experimental. The proprietary failsafe.* set is unaffected.

describe("GenAI semantic-convention attributes", () => {
	const enable = (value = GEN_AI_OPT_IN) => {
		process.env[SEMCONV_VAR] = value;
	};

	test("the opt-in gate parses a comma-separated list", () => {
		expect(isGenAiSemconvEnabled()).toBe(false);
		enable("http,database");
		expect(isGenAiSemconvEnabled()).toBe(false);
		enable(`http, ${GEN_AI_OPT_IN} ,database`);
		expect(isGenAiSemconvEnabled()).toBe(true);
	});

	test("no gen_ai attribute is emitted without the opt-in", () => {
		const builders = [
			runSpanAttributes({ status: "failed", token_budget: { estimated_raw_tokens: 500 } }),
			runErrorSpanAttributes({ exit_code: 3 }),
			parseSpanAttributes([]),
			diagnoseSpanAttributes(makeDiagnosis()),
			reproSpanAttributes(makeRepro()),
			verifySpanAttributes({ status: "passed" }),
			verifyErrorSpanAttributes({ exit_code: 2 }),
		];
		for (const attrs of builders) {
			expect(Object.keys(attrs).some((k) => k.startsWith("gen_ai."))).toBe(false);
		}
		expect(genAiToolAttributes("diagnose")).toEqual({});
	});

	test("with the opt-in, every span becomes a GenAI tool span", () => {
		enable();
		const cases: Array<[Record<string, unknown>, string]> = [
			[runSpanAttributes({ status: "failed" }), "failsafe_analyze"],
			[runErrorSpanAttributes({ exit_code: 3 }), "failsafe_analyze"],
			[parseSpanAttributes([]), "failsafe_parse"],
			[diagnoseSpanAttributes(makeDiagnosis()), "failsafe_diagnose"],
			[reproSpanAttributes(makeRepro()), "failsafe_repro"],
			[verifySpanAttributes({ status: "passed" }), "failsafe_verify"],
			[verifyErrorSpanAttributes({ exit_code: 2 }), "failsafe_verify"],
		];
		for (const [attrs, toolName] of cases) {
			expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
			expect(attrs["gen_ai.tool.name"]).toBe(toolName);
			expect(attrs["gen_ai.tool.type"]).toBe("function");
		}
	});

	test("the failsafe.* attribute set is unchanged by the opt-in", () => {
		const before = runSpanAttributes({ status: "failed", failure_type: "test_failure" });
		enable();
		const after = runSpanAttributes({ status: "failed", failure_type: "test_failure" });
		for (const [key, value] of Object.entries(before)) {
			expect(after[key]).toBe(value as never);
		}
		expect(after.schema_version).toBe(SCHEMA_VERSION);
	});

	test("token budget maps onto gen_ai.usage.*", () => {
		enable();
		const attrs = runSpanAttributes({
			status: "failed",
			token_budget: {
				raw_output_bytes: 40_000,
				compression_ratio: 20,
				estimated_raw_tokens: 10_000,
				estimated_returned_tokens: 500,
			},
		});
		expect(attrs["gen_ai.usage.input_tokens"]).toBe(10_000);
		expect(attrs["gen_ai.usage.output_tokens"]).toBe(500);

		const diagnosis = makeDiagnosis();
		diagnosis.token_budget = {
			raw_output_bytes: 8000,
			returned_bytes: 800,
			compression_ratio: 10,
			estimated_raw_tokens: 2000,
			estimated_returned_tokens: 200,
		};
		const diagAttrs = diagnoseSpanAttributes(diagnosis);
		expect(diagAttrs["gen_ai.usage.input_tokens"]).toBe(2000);
		expect(diagAttrs["gen_ai.usage.output_tokens"]).toBe(200);
	});

	test("usage keys are omitted when there is no token budget to map", () => {
		enable();
		const attrs = parseSpanAttributes([]);
		expect(attrs["gen_ai.tool.name"]).toBe("failsafe_parse");
		expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
		expect(attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
	});

	test("gen_ai keys reach the wire un-prefixed; bare keys stay under failsafe.*", () => {
		expect(spanAttributeKey("gen_ai.tool.name")).toBe("gen_ai.tool.name");
		expect(spanAttributeKey("gen_ai.usage.input_tokens")).toBe("gen_ai.usage.input_tokens");
		expect(spanAttributeKey("failure_type")).toBe("failsafe.failure_type");
		expect(spanAttributeKey("schema_version")).toBe("failsafe.schema_version");
	});

	test("a span still emits successfully with the opt-in enabled", async () => {
		enable();
		process.env[ENDPOINT_VAR] = "http://localhost:4318/v1/traces";
		const result = await withSpan("failsafe.diagnose", async (setAttrs) => {
			setAttrs(diagnoseSpanAttributes(makeDiagnosis()));
			return "done";
		});
		expect(result).toBe("done");
	});
});

function makeDiagnosis(): FailureDiagnosis {
	return {
		schema_version: SCHEMA_VERSION,
		diagnosis_id: "diag_1",
		failure_id: "fail_1",
		failure_type: "test_failure",
		severity: "error",
		summary: "KeyError: 'email'",
		root_cause: {
			category: "key_error",
			explanation: "Missing key 'email' in payload",
			confidence: 0.9,
		},
		evidence: [{ kind: "error_message", value: "KeyError: 'email'" }],
		uncertainty: [],
		minimal_context: [],
		suggested_next_actions: [],
		rule_source: "declared",
		rule_id: "rule_kerr",
		enforcement: "suggest",
	};
}

function makeRepro(): ReproRecord {
	return {
		schema_version: SCHEMA_VERSION,
		repro_id: "repro_1",
		failure_id: "fail_1",
		created_at: new Date().toISOString(),
		status: "verified",
		kind: "test_selector",
		command: "pytest tests/test_auth.py::test_missing_email",
		confidence: 0.8,
		reduction: { original_tests: 5000, repro_tests: 1 },
		next: [],
	};
}
