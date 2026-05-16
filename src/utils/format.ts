import type { FailureDiagnosis } from "../types/diagnosis.js";
import type { FailureRecord } from "../types/failure.js";

export type OutputFormat = "json" | "text";

export function isAgentMode(): boolean {
	return process.env.FAILSAFE_AGENT === "1";
}

export function resolveFormat(explicit?: string): OutputFormat {
	if (explicit === "json" || explicit === "text") return explicit;
	if (isAgentMode()) return "json";
	return "json"; // Agent-first: JSON by default
}

export function formatOutput(
	data: unknown,
	format: OutputFormat,
	textFormatter?: (d: unknown) => string,
): string {
	if (format === "json") {
		return JSON.stringify(data, null, 2);
	}
	if (textFormatter) {
		return textFormatter(data);
	}
	return JSON.stringify(data, null, 2);
}

export function formatFailureText(record: FailureRecord): string {
	const lines: string[] = [];
	lines.push(`[${record.status.toUpperCase()}] ${record.failure_id}`);
	lines.push(`Command: ${record.command}`);
	lines.push(`Exit code: ${record.exit_code}`);
	if (record.parsed.length > 0) {
		const first = record.parsed[0];
		lines.push(`Type: ${first.failure_type}`);
		if (first.errors.length > 0) {
			lines.push(`Summary: ${first.errors[0].message}`);
		}
		if (first.test_summary) {
			const s = first.test_summary;
			lines.push(`Tests: ${s.failed} failed, ${s.passed} passed, ${s.total} total`);
		}
	}
	if (record.primary_location) {
		const loc = record.primary_location;
		lines.push(`Location: ${loc.file}:${loc.line}${loc.symbol ? ` (${loc.symbol})` : ""}`);
	}
	if (record.token_budget) {
		lines.push(
			`Compression: ${record.token_budget.raw_output_bytes}B -> ${record.token_budget.returned_bytes}B (${record.token_budget.compression_ratio}x)`,
		);
	}
	return lines.join("\n");
}

export function formatDiagnosisText(diag: FailureDiagnosis): string {
	const lines: string[] = [];
	lines.push(`[DIAGNOSIS] ${diag.diagnosis_id} for ${diag.failure_id}`);
	lines.push(`Type: ${diag.failure_type} (${diag.severity})`);
	lines.push(`Summary: ${diag.summary}`);
	if (diag.root_cause) {
		lines.push(
			`Root cause: ${diag.root_cause.category} (confidence: ${Math.round(diag.root_cause.confidence * 100)}%)`,
		);
		lines.push(`  ${diag.root_cause.explanation}`);
	}
	if (diag.rule_source) {
		lines.push(`Rule: [${diag.rule_source}] ${diag.rule_id ?? "unknown"}`);
	}
	if (diag.enforcement) {
		lines.push(`Enforcement: ${diag.enforcement}`);
	}
	if (diag.evidence.length > 0) {
		lines.push("Evidence:");
		for (const e of diag.evidence) {
			lines.push(`  [${e.kind}] ${e.location ? `${e.location}: ` : ""}${e.value}`);
		}
	}
	if (diag.uncertainty.length > 0) {
		lines.push("Uncertainty:");
		for (const u of diag.uncertainty) {
			lines.push(`  - ${u}`);
		}
	}
	if (diag.suggested_next_actions.length > 0) {
		lines.push("Next actions:");
		for (const a of diag.suggested_next_actions) {
			lines.push(`  $ ${a.command}`);
			lines.push(`    ${a.reason}`);
		}
	}
	return lines.join("\n");
}

export function output(
	data: unknown,
	format: OutputFormat,
	textFormatter?: (d: unknown) => string,
): void {
	console.log(formatOutput(data, format, textFormatter));
}
