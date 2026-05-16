import { describe, test, expect } from "bun:test";
import { resolveOutputOptions } from "../../src/cli/format.js";

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
