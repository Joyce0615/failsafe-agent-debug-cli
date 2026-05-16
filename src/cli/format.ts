import type { TokenBudget } from "../types/common.js";
import { computeTokenBudget } from "../utils/tokens.js";

export type OutputOptions = {
	format: "json" | "text";
	maxBytes?: number;
	raw: boolean;
};

export function resolveOutputOptions(
	opts: {
		format?: string;
		raw?: boolean;
		maxBytes?: number;
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
	return {
		format,
		raw: opts.raw ?? false,
		maxBytes: opts.maxBytes ?? configMaxBytes,
	};
}

export function outputResult(
	data: unknown,
	opts: OutputOptions,
	textFormatter?: (d: unknown) => string,
): void {
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
 * Truncate a JSON output object to fit within maxBytes.
 * Removes large fields (raw_stdout, raw_stderr, evidence, minimal_context)
 * and adds truncation metadata.
 */
function truncateJsonOutput(
	data: Record<string, unknown>,
	maxBytes: number,
): Record<string, unknown> {
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

	// If still over limit, stringify and hard-truncate
	let serialized = JSON.stringify(result, null, 2);
	if (Buffer.byteLength(serialized) > maxBytes) {
		// Last resort: truncate the serialized string
		const buf = Buffer.from(serialized);
		serialized = buf.subarray(0, maxBytes - 100).toString("utf-8");
		return {
			truncated: true,
			truncated_bytes: Buffer.byteLength(JSON.stringify(data)),
			max_bytes: maxBytes,
			partial: serialized,
		};
	}

	if (removedFields.length > 0) {
		result.truncated = true;
		result.truncated_fields = removedFields;
		result.max_bytes = maxBytes;
	}

	return result;
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
