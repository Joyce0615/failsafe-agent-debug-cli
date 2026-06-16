import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, checkSchemaCompatibility } from "../../src/types/common.js";

describe("checkSchemaCompatibility", () => {
	test("current version is ok", () => {
		const r = checkSchemaCompatibility(SCHEMA_VERSION);
		expect(r.action).toBe("ok");
	});

	test("missing version is migrate (legacy best-effort)", () => {
		const r = checkSchemaCompatibility(undefined);
		expect(r.action).toBe("migrate");
		expect(r.reason).toContain("legacy");
	});

	test("same major newer minor is migrate", () => {
		const r = checkSchemaCompatibility("0.9", "0.1");
		expect(r.action).toBe("migrate");
		expect(r.reason).toContain("newer");
	});

	test("same major older minor is migrate (compatible)", () => {
		const r = checkSchemaCompatibility("0.0", "0.1");
		expect(r.action).toBe("migrate");
		expect(r.reason).toContain("older");
	});

	test("different major is rejected", () => {
		const r = checkSchemaCompatibility("1.0", "0.1");
		expect(r.action).toBe("reject");
		expect(r.reason).toContain("major");
	});

	test("malformed version is rejected", () => {
		const r = checkSchemaCompatibility("garbage", "0.1");
		expect(r.action).toBe("reject");
		expect(r.reason).toContain("Malformed");
	});

	test("returns version and current for diagnostics", () => {
		const r = checkSchemaCompatibility("1.2", "0.1");
		expect(r.version).toBe("1.2");
		expect(r.current).toBe("0.1");
	});
});
