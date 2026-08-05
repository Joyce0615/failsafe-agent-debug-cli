/**
 * Canonical span attribute set.
 *
 * Defines, in one place, exactly which `failsafe.*` attributes each core span
 * carries. The core operations call these builders instead of hand-assembling
 * attribute objects at each call site, so the telemetry schema can't silently
 * drift between spans, and `tests/telemetry/otel.test.ts` asserts presence and
 * shape against this same source of truth.
 *
 * Every span carries `schema_version` so traces can be correlated with the
 * packet schema that produced them. Attributes whose value is `undefined` are
 * dropped downstream by `withSpan`'s `applyAttributes`, so optional fields can
 * be returned unconditionally here.
 */
import type { ParserResult } from "../parsers/types.js";
import { SCHEMA_VERSION } from "../types/common.js";
import type { FailureDiagnosis } from "../types/diagnosis.js";
import type { ReproRecord } from "../types/repro.js";
import type { SpanAttributes } from "./otel.js";

/** Minimal shape of a `CoreError` needed for error-path attribution. */
type CoreErrorLike = { exit_code: number; needs_shell?: unknown };

/**
 * Value that opts a process into the (still experimental) OpenTelemetry GenAI
 * semantic conventions, per the spec's stability-transition guidance.
 */
export const GEN_AI_OPT_IN = "gen_ai_latest_experimental";

/**
 * Whether to emit GenAI semantic-convention attributes alongside the
 * proprietary `failsafe.*` set (item 30).
 *
 * Opt-in only: `OTEL_SEMCONV_STABILITY_OPT_IN` must list
 * `gen_ai_latest_experimental`. Read at call time (not module load) so tests
 * and long-lived processes observe env changes.
 */
export function isGenAiSemconvEnabled(): boolean {
	const raw = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
	if (!raw) return false;
	return raw
		.split(",")
		.map((s) => s.trim())
		.includes(GEN_AI_OPT_IN);
}

/** Tool names, aligned 1:1 with the MCP tool surface an agent actually calls. */
const GEN_AI_TOOL_NAMES = {
	run: "failsafe_analyze",
	parse: "failsafe_parse",
	diagnose: "failsafe_diagnose",
	repro: "failsafe_repro",
	verify: "failsafe_verify",
} as const;

export type GenAiOperation = keyof typeof GEN_AI_TOOL_NAMES;

/**
 * GenAI tool-span attributes for one core operation.
 *
 * Failsafe is a *tool* in an agent's trace, so the operation is `execute_tool`
 * and the span carries `gen_ai.tool.name`/`gen_ai.tool.type`. The token budget
 * maps onto `gen_ai.usage.input_tokens` (what the raw output would have cost
 * the agent) and `gen_ai.usage.output_tokens` (what the compact packet costs),
 * which is exactly the saving an observability backend should be able to plot.
 *
 * Returns `{}` unless the opt-in flag is set, so no unexpected attributes ever
 * appear on a default trace.
 */
export function genAiToolAttributes(
	operation: GenAiOperation,
	usage?: { input_tokens?: number; output_tokens?: number },
): SpanAttributes {
	if (!isGenAiSemconvEnabled()) return {};
	return {
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": GEN_AI_TOOL_NAMES[operation],
		"gen_ai.tool.type": "function",
		"gen_ai.usage.input_tokens": usage?.input_tokens,
		"gen_ai.usage.output_tokens": usage?.output_tokens,
	};
}

/** `failsafe.run` — successful capture/parse of a command's output. */
export function runSpanAttributes(data: Record<string, unknown>): SpanAttributes {
	const tb = data.token_budget as
		| {
				raw_output_bytes?: number;
				compression_ratio?: number;
				estimated_raw_tokens?: number;
				estimated_returned_tokens?: number;
		  }
		| undefined;
	const parsers = data.parsers as unknown[] | undefined;
	const redaction = data.redaction as { applied?: boolean } | undefined;
	return {
		schema_version: SCHEMA_VERSION,
		status: data.status as string | undefined,
		failure_type: data.failure_type as string | undefined,
		exit_code: data.exit_code as number | undefined,
		raw_output_bytes: tb?.raw_output_bytes,
		compression_ratio: tb?.compression_ratio,
		parser_count: Array.isArray(parsers) ? parsers.length : undefined,
		redaction_applied: redaction?.applied,
		...genAiToolAttributes("run", {
			input_tokens: tb?.estimated_raw_tokens,
			output_tokens: tb?.estimated_returned_tokens,
		}),
	};
}

/** `failsafe.run` — error path (policy block, shell-syntax rejection, etc.). */
export function runErrorSpanAttributes(error: CoreErrorLike): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		status: "error",
		error_code: error.exit_code,
		needs_shell: error.needs_shell === true ? true : undefined,
		...genAiToolAttributes("run"),
	};
}

/** `failsafe.parse` — output detection/parsing across all matching parsers. */
export function parseSpanAttributes(parsed: ParserResult[]): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		parser_matched: parsed[0]?.parser,
		failure_type: parsed[0]?.failure_type,
		parser_count: parsed.length,
		...genAiToolAttributes("parse"),
	};
}

/** `failsafe.diagnose` — root-cause packet, including the winning rule tier. */
export function diagnoseSpanAttributes(diagnosis: FailureDiagnosis): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		failure_type: diagnosis.failure_type,
		severity: diagnosis.severity,
		category: diagnosis.root_cause?.category,
		confidence: diagnosis.root_cause?.confidence,
		// rule_source is the conflict-resolution tier (declared > learned > builtin).
		rule_source: diagnosis.rule_source,
		rule_id: diagnosis.rule_id,
		enforcement: diagnosis.enforcement,
		evidence_count: diagnosis.evidence.length,
		...genAiToolAttributes("diagnose", {
			input_tokens: diagnosis.token_budget?.estimated_raw_tokens,
			output_tokens: diagnosis.token_budget?.estimated_returned_tokens,
		}),
	};
}

/** `failsafe.repro` — minimal-reproduction generation/verification. */
export function reproSpanAttributes(repro: ReproRecord): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		status: repro.status,
		kind: repro.kind,
		confidence: repro.confidence,
		...genAiToolAttributes("repro"),
	};
}

/** `failsafe.verify` — re-running commands to confirm a fix. */
export function verifySpanAttributes(data: Record<string, unknown>): SpanAttributes {
	const checks = data.checks as unknown[] | undefined;
	return {
		schema_version: SCHEMA_VERSION,
		status: data.status as string | undefined,
		checks_count: Array.isArray(checks) ? checks.length : undefined,
		...genAiToolAttributes("verify"),
	};
}

/** `failsafe.verify` — error path (failure not found, etc.). */
export function verifyErrorSpanAttributes(error: CoreErrorLike): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		status: "error",
		error_code: error.exit_code,
		...genAiToolAttributes("verify"),
	};
}
