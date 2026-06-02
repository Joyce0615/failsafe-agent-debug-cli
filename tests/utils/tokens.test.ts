import { describe, expect, test } from "bun:test";
import { computeTokenBudget, estimateTokens, truncateToByteLimit } from "../../src/utils/tokens.js";

describe("estimateTokens", () => {
	test("estimates tokens from bytes", () => {
		expect(estimateTokens(100)).toBe(25);
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(3)).toBe(1);
	});
});

describe("computeTokenBudget", () => {
	test("computes budget with compression ratio", () => {
		const budget = computeTokenBudget(10000, 500);
		expect(budget.raw_output_bytes).toBe(10000);
		expect(budget.returned_bytes).toBe(500);
		expect(budget.compression_ratio).toBe(20);
		expect(budget.estimated_tokens_saved).toBeGreaterThan(0);
	});

	test("handles zero raw bytes", () => {
		const budget = computeTokenBudget(0, 100);
		expect(budget.compression_ratio).toBe(1);
	});
});

describe("truncateToByteLimit", () => {
	test("returns text unchanged if within limit", () => {
		expect(truncateToByteLimit("hello", 100)).toBe("hello");
	});

	test("truncates text exceeding limit", () => {
		const long = "a".repeat(200);
		const result = truncateToByteLimit(long, 50);
		expect(result.length).toBeLessThan(200);
		expect(result).toContain("truncated");
	});
});
