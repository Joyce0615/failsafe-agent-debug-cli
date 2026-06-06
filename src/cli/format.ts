import type { TokenBudget } from "../types/common.js";
import { computeTokenBudget } from "../utils/tokens.js";

export type OutputOptions = {
	format: "json" | "text";
	maxBytes?: number;
	raw: boolean;
	/** Quiet mode: emit minified single-line JSON for composable shell usage. */
	quiet: boolean;
};

export function resolveOutputOptions(
	opts: {
		format?: string;
		raw?: boolean;
		maxBytes?: number;
		quiet?: boolean;
	},
	configDefault?: "json" | "text",
	configMaxBytes?: number,
): OutputOptions {
	let format: "json" | "text";
	if (opts.format === "json" || opts.format === "text") {
		format = opts.format;
	} else if (process.env.FAILSAFE_AGENT === "1") {
		format = "json";
	} else if (configDefault) {
		format = configDefault;
	} else {
		format = "json";
	}
	// Quiet mode implies JSON (minified) regardless of configured default.
	const quiet = opts.quiet ?? false;
	return {
		format: quiet ? "json" : format,
		raw: opts.raw ?? false,
		maxBytes: opts.maxBytes ?? configMaxBytes,
		quiet,
	};
}

export function outputResult(
	data: unknown,
	opts: OutputOptions,
	textFormatter?: (d: unknown) => string,
): void {
	// Quiet mode: minified single-line JSON, no truncation decoration.
	if (opts.quiet) {
		console.log(JSON.stringify(data));
		return;
	}

	let output: string;
	if (opts.format === "json") {
		output = JSON.stringify(data, null, 2);
	} else if (textFormatter) {
		output = textFormatter(data);
	} else {
		output = JSON.stringify(data, null, 2);
	}

	// Enforce byte limit
	if (opts.maxBytes && Buffer.byteLength(output) > opts.maxBytes) {
		if (opts.format === "json") {
			// For JSON: rebuild with truncation metadata
			const truncated = truncateJsonOutput(data as Record<string, unknown>, opts.maxBytes);
			console.log(JSON.stringify(truncated, null, 2));
		} else {
			// For text: simple byte truncation
			const buf = Buffer.from(output);
			console.log(
				`${buf.subarray(0, opts.maxBytes).toString("utf-8")}\n... [truncated, ${Buffer.byteLength(output) - opts.maxBytes} bytes omitted]`,
			);
		}
	} else {
		console.log(output);
	}
}

/**
 * Recompute token_budget.returned_bytes on a result object so it reflects
 * the actual emitted JSON size. Mutates and returns the object.
 */
function refreshReturnedBytes(result: Record<string, unknown>): Record<string, unknown> {
	const tb = result.token_budget as Record<string, unknown> | undefined;
	if (tb && typeof tb === "object") {
		// Iterate to a fixed point: writing returned_bytes changes the
		// serialized length, so converge until the value is stable.
		const raw = typeof tb.raw_output_bytes === "number" ? tb.raw_output_bytes : 0;
		for (let i = 0; i < 5; i++) {
			const emitted = Buffer.byteLength(JSON.stringify(result, null, 2));
			if (tb.returned_bytes === emitted) break;
			tb.returned_bytes = emitted;
			tb.compression_ratio =
				raw > 0 ? Math.round((raw / Math.max(emitted, 1)) * 10) / 10 : tb.compression_ratio;
		}
	}
	return result;
}

/**
 * Truncate a JSON output object to fit within maxBytes.
 *
 * Contract:
 * - `returned_bytes` always reflects the ACTUAL emitted byte count.
 * - Essential fields (raw_paths, failure_id, status, token_budget) are
 *   preserved even when the response is hard-truncated.
 * - Every truncated response includes `truncated: true`, the original
 *   logical size, omitted byte count, max_bytes, and a truncation_reason.
 */
function truncateJsonOutput(
	data: Record<string, unknown>,
	maxBytes: number,
): Record<string, unknown> {
	const originalBytes = Buffer.byteLength(JSON.stringify(data, null, 2));

	// Fields to strip in priority order (largest/least essential first)
	const strippableFields = [
		"raw_stdout",
		"raw_stderr",
		"minimal_context",
		"evidence",
		"state_delta",
		"source_context",
	];

	const result = { ...data };
	const removedFields: string[] = [];

	for (const field of strippableFields) {
		if (field in result) {
			const withField = JSON.stringify(result, null, 2);
			if (Buffer.byteLength(withField) > maxBytes) {
				delete result[field];
				removedFields.push(field);
			}
		}
	}

	if (removedFields.length > 0) {
		result.truncated = true;
		result.truncated_fields = removedFields;
		result.max_bytes = maxBytes;
		result.original_bytes = originalBytes;
		result.omitted_bytes = originalBytes - Buffer.byteLength(JSON.stringify(result, null, 2));
		result.truncation_reason = `Output exceeded max_bytes (${maxBytes}); removed fields: ${removedFields.join(", ")}`;
	}

	// If still over limit after stripping, build a minimal essential packet
	// that preserves raw_paths so the agent can fetch full data on disk.
	if (Buffer.byteLength(JSON.stringify(result, null, 2)) > maxBytes) {
		const essential: Record<string, unknown> = {
			truncated: true,
			truncation_reason: "Output exceeded max_bytes even after stripping large fields",
			max_bytes: maxBytes,
			original_bytes: originalBytes,
		};
		// Preserve key identity and pointers to full data
		for (const key of [
			"schema_version",
			"failure_id",
			"diagnosis_id",
			"status",
			"summary",
			"exit_code",
			"raw_paths",
			"token_budget",
		]) {
			if (key in data) essential[key] = data[key];
		}
		essential.omitted_bytes = originalBytes - Buffer.byteLength(JSON.stringify(essential, null, 2));
		return refreshReturnedBytes(essential);
	}

	return refreshReturnedBytes(result);
}

export function addTokenBudget<T extends Record<string, unknown>>(
	data: T,
	rawBytes: number,
): T & { token_budget: TokenBudget } {
	const returnedBytes = Buffer.byteLength(JSON.stringify(data));
	return {
		...data,
		token_budget: computeTokenBudget(rawBytes, returnedBytes),
	};
}
