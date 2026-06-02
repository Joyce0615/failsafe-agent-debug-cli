import { describe, expect, test } from "bun:test";
import { debugId, diagnosisId, failureId, reproId } from "../../src/utils/id.js";

describe("id generation", () => {
	test("failureId has correct prefix", () => {
		const id = failureId();
		expect(id.startsWith("fail_")).toBe(true);
		expect(id.length).toBeGreaterThan(5);
	});

	test("diagnosisId has correct prefix", () => {
		const id = diagnosisId();
		expect(id.startsWith("diag_")).toBe(true);
	});

	test("reproId has correct prefix", () => {
		const id = reproId();
		expect(id.startsWith("repro_")).toBe(true);
	});

	test("debugId has correct prefix", () => {
		const id = debugId();
		expect(id.startsWith("dbg_")).toBe(true);
	});

	test("ids are unique", () => {
		const ids = new Set(Array.from({ length: 100 }, () => failureId()));
		expect(ids.size).toBe(100);
	});
});
