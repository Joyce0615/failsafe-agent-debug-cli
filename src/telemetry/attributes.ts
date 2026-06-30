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

/** `failsafe.run` — successful capture/parse of a command's output. */
export function runSpanAttributes(data: Record<string, unknown>): SpanAttributes {
	const tb = data.token_budget as
		| { raw_output_bytes?: number; compression_ratio?: number }
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
	};
}

/** `failsafe.run` — error path (policy block, shell-syntax rejection, etc.). */
export function runErrorSpanAttributes(error: CoreErrorLike): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		status: "error",
		error_code: error.exit_code,
		needs_shell: error.needs_shell === true ? true : undefined,
	};
}

/** `failsafe.parse` — output detection/parsing across all matching parsers. */
export function parseSpanAttributes(parsed: ParserResult[]): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		parser_matched: parsed[0]?.parser,
		failure_type: parsed[0]?.failure_type,
		parser_count: parsed.length,
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
	};
}

/** `failsafe.repro` — minimal-reproduction generation/verification. */
export function reproSpanAttributes(repro: ReproRecord): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		status: repro.status,
		kind: repro.kind,
		confidence: repro.confidence,
	};
}

/** `failsafe.verify` — re-running commands to confirm a fix. */
export function verifySpanAttributes(data: Record<string, unknown>): SpanAttributes {
	const checks = data.checks as unknown[] | undefined;
	return {
		schema_version: SCHEMA_VERSION,
		status: data.status as string | undefined,
		checks_count: Array.isArray(checks) ? checks.length : undefined,
	};
}

/** `failsafe.verify` — error path (failure not found, etc.). */
export function verifyErrorSpanAttributes(error: CoreErrorLike): SpanAttributes {
	return {
		schema_version: SCHEMA_VERSION,
		status: "error",
		error_code: error.exit_code,
	};
}
