import { describe, expect, test } from "bun:test";
import { makeLargePytestLog, measure, runBenchmarks } from "../../scripts/bench.js";
import { detectAndParse, extractPrimaryLocation } from "../../src/parsers/index.js";

// CI-safe ceilings: ~10x the observed local per-op cost (parse ≈ 3 ms,
// diagnose ≈ 40 ms). Generous enough to avoid flakiness on slow shared
// runners while still catching catastrophic (order-of-magnitude) regressions.
const PARSE_CEILING_MS = 50;
const DIAGNOSE_CEILING_MS = 500;

describe("parse/diagnose latency", () => {
	test("the large fixture is representative (~200 KiB, one failure)", () => {
		const log = makeLargePytestLog(200);
		expect(log.length).toBeGreaterThan(150 * 1024);
		const results = detectAndParse(log, "", "pytest tests/");
		expect(results.some((r) => r.parser === "pytest")).toBe(true);
		expect(extractPrimaryLocation(results)).toBeDefined();
	});

	test("parsing a large log stays within budget", () => {
		const log = makeLargePytestLog(200);
		const m = measure("parse", 30, () => void detectAndParse(log, "", "pytest tests/"));
		expect(m.per_op_ms).toBeLessThan(PARSE_CEILING_MS);
	});

	test("parse + diagnose both stay within budget", async () => {
		const [parse, diag] = await runBenchmarks(15);
		expect(parse.per_op_ms).toBeLessThan(PARSE_CEILING_MS);
		expect(diag.per_op_ms).toBeLessThan(DIAGNOSE_CEILING_MS);
	});
});
