import { describe, expect, spyOn, test } from "bun:test";
import { outputResult, resolveOutputOptions } from "../../src/cli/format.js";

/** Capture a single console.log call and return the parsed JSON. */
function captureJson(fn: () => void): Record<string, unknown> {
	let captured = "";
	const spy = spyOn(console, "log").mockImplementation((s: string) => {
		captured = s;
	});
	try {
		fn();
	} finally {
		spy.mockRestore();
	}
	return JSON.parse(captured) as Record<string, unknown>;
}

describe("resolveOutputOptions", () => {
	test("defaults to json without any config", () => {
		const opts = resolveOutputOptions({});
		expect(opts.format).toBe("json");
	});

	test("explicit --format overrides config", () => {
		const opts = resolveOutputOptions({ format: "text" }, "json");
		expect(opts.format).toBe("text");
	});

	test("uses config default_format when no explicit flag", () => {
		const opts = resolveOutputOptions({}, "text");
		expect(opts.format).toBe("text");
	});

	test("uses configMaxBytes as maxBytes fallback", () => {
		const opts = resolveOutputOptions({}, "json", 6000);
		expect(opts.maxBytes).toBe(6000);
	});

	test("explicit maxBytes overrides configMaxBytes", () => {
		const opts = resolveOutputOptions({ maxBytes: 3000 }, "json", 6000);
		expect(opts.maxBytes).toBe(3000);
	});

	test("raw defaults to false", () => {
		const opts = resolveOutputOptions({});
		expect(opts.raw).toBe(false);
	});

	test("raw respects explicit flag", () => {
		const opts = resolveOutputOptions({ raw: true });
		expect(opts.raw).toBe(true);
	});
});

describe("outputResult truncation", () => {
	test("emits output unchanged when within byte limit", () => {
		const data = {
			status: "failed",
			failure_id: "fail_x",
			token_budget: { raw_output_bytes: 100, returned_bytes: 50 },
		};
		const result = captureJson(() =>
			outputResult(data, { format: "json", raw: false, maxBytes: 10000, quiet: false }),
		);
		expect(result.status).toBe("failed");
		expect(result.truncated).toBeUndefined();
	});

	test("strips large fields and adds truncation metadata", () => {
		const data = {
			status: "failed",
			failure_id: "fail_x",
			raw_paths: { stdout: "/p/stdout.log", stderr: "/p/stderr.log" },
			raw_stdout: "X".repeat(2000),
			token_budget: { raw_output_bytes: 5000, returned_bytes: 2200 },
		};
		const result = captureJson(() =>
			outputResult(data, { format: "json", raw: true, maxBytes: 500, quiet: false }),
		);
		expect(result.truncated).toBe(true);
		expect(result.truncation_reason).toBeDefined();
		expect(result.max_bytes).toBe(500);
		expect(result.original_bytes).toBeDefined();
		expect(result.omitted_bytes).toBeDefined();
		// raw_paths preserved so the agent can fetch full output
		expect(result.raw_paths).toBeDefined();
	});

	test("returned_bytes reflects actual emitted size after truncation", () => {
		const data = {
			status: "failed",
			failure_id: "fail_x",
			raw_paths: { stdout: "/p/stdout.log" },
			raw_stdout: "X".repeat(3000),
			token_budget: { raw_output_bytes: 5000, returned_bytes: 3100 },
		};
		const result = captureJson(() =>
			outputResult(data, { format: "json", raw: true, maxBytes: 400, quiet: false }),
		);
		const tb = result.token_budget as Record<string, number>;
		// The reported returned_bytes should match the actual emitted JSON size
		const actualBytes = Buffer.byteLength(JSON.stringify(result, null, 2));
		expect(tb.returned_bytes).toBe(actualBytes);
	});

	test("preserves essential fields in hard-truncation fallback", () => {
		const data = {
			schema_version: "0.1",
			status: "failed",
			failure_id: "fail_essential",
			summary: "boom",
			raw_paths: { stdout: "/p/stdout.log" },
			// A huge non-strippable field forces the essential-packet path
			some_huge_unknown_field: "Y".repeat(5000),
			token_budget: { raw_output_bytes: 8000, returned_bytes: 5200 },
		};
		const result = captureJson(() =>
			outputResult(data, { format: "json", raw: false, maxBytes: 300, quiet: false }),
		);
		expect(result.truncated).toBe(true);
		expect(result.failure_id).toBe("fail_essential");
		expect(result.raw_paths).toBeDefined();
		expect(result.some_huge_unknown_field).toBeUndefined();
	});
});
