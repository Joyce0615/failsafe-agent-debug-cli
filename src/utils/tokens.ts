import type { TokenBudget } from "../types/common.js";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(bytes: number): number {
	return Math.ceil(bytes / CHARS_PER_TOKEN);
}

export function computeTokenBudget(rawBytes: number, returnedBytes: number): TokenBudget {
	const rawTokens = estimateTokens(rawBytes);
	const returnedTokens = estimateTokens(returnedBytes);
	return {
		raw_output_bytes: rawBytes,
		returned_bytes: returnedBytes,
		compression_ratio:
			rawBytes > 0 ? Math.round((rawBytes / Math.max(returnedBytes, 1)) * 10) / 10 : 1,
		estimated_raw_tokens: rawTokens,
		estimated_returned_tokens: returnedTokens,
		estimated_tokens_saved: Math.max(0, rawTokens - returnedTokens),
	};
}

export function truncateToByteLimit(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const buf = Buffer.from(text);
	const truncated = buf.subarray(0, maxBytes).toString("utf-8");
	return `${truncated}\n... [truncated, ${Buffer.byteLength(text) - maxBytes} bytes omitted]`;
}
