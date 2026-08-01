import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputResult, resolveOutputOptions, stripFixFields } from "../../src/cli/format.js";

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

	test("evidence-only is applied before the byte budget", () => {
		const data = {
			failure_id: "fail_budget",
			evidence: [{ kind: "log", value: "E".repeat(200) }],
			suggested_next_actions: [{ command: "x".repeat(400), reason: "y".repeat(400) }],
			token_budget: { raw_output_bytes: 9000, returned_bytes: 1200 },
		};
		// Without the filter this exceeds 700 bytes and would be truncated;
		// with it the evidence survives intact and no truncation is needed.
		const result = captureJson(() =>
			outputResult(data, {
				format: "json",
				raw: false,
				maxBytes: 700,
				quiet: false,
				evidenceOnly: true,
			}),
		);
		expect(result.truncated).toBeUndefined();
		expect(result.evidence).toBeDefined();
		expect(result.suggested_next_actions).toBeUndefined();
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

describe("--evidence-only filter (item 24)", () => {
	const diagnosisPacket = () => ({
		schema_version: "0.1",
		diagnosis_id: "diag_1",
		failure_id: "fail_1",
		summary: "KeyError: 'user_id'",
		evidence: [{ kind: "git_diff", location: "app.py", value: "+ del row['user_id']" }],
		uncertainty: ["Only one frame available"],
		minimal_context: [{ file: "app.py", start_line: 1, end_line: 3, content: "..." }],
		root_cause: { category: "key_error", explanation: "missing key", confidence: 0.8 },
		suggested_next_actions: [{ command: "failsafe repro fail_1", reason: "narrow it down" }],
		fix_options: [{ title: "guard the lookup", risk: "low", rationale: "safe" }],
		recommended_fix: { title: "guard the lookup" },
		token_budget: { raw_output_bytes: 4000, returned_bytes: 800 },
	});

	test("strips fix/next-action fields but keeps evidence and token_budget", () => {
		const filtered = stripFixFields(diagnosisPacket()) as Record<string, unknown>;
		expect(filtered.evidence).toBeDefined();
		expect(filtered.minimal_context).toBeDefined();
		expect(filtered.uncertainty).toBeDefined();
		expect(filtered.root_cause).toBeDefined();
		expect(filtered.token_budget).toBeDefined();
		expect(filtered.suggested_next_actions).toBeUndefined();
		expect(filtered.fix_options).toBeUndefined();
		expect(filtered.recommended_fix).toBeUndefined();
		expect(filtered.evidence_only).toBe(true);
	});

	test("does not mutate the input packet", () => {
		const original = diagnosisPacket();
		stripFixFields(original);
		expect(original.suggested_next_actions).toBeDefined();
		expect(original.fix_options).toBeDefined();
		expect(original.token_budget.returned_bytes).toBe(800);
	});

	test("recomputes returned_bytes for the reduced packet", () => {
		const filtered = stripFixFields(diagnosisPacket()) as Record<string, unknown>;
		const tb = filtered.token_budget as Record<string, number>;
		expect(tb.returned_bytes).toBe(Buffer.byteLength(JSON.stringify(filtered, null, 2)));
		expect(tb.returned_bytes).toBeLessThan(800);
		expect(tb.raw_output_bytes).toBe(4000);
	});

	test("is a no-op for packets with no fix fields", () => {
		const packet = { failure_id: "fail_2", evidence: [] };
		expect(stripFixFields(packet)).toBe(packet);
	});

	test("outputResult honors evidenceOnly, including in quiet mode", () => {
		const json = captureJson(() =>
			outputResult(diagnosisPacket(), {
				format: "json",
				raw: false,
				quiet: false,
				evidenceOnly: true,
			}),
		);
		expect(json.evidence).toBeDefined();
		expect(json.suggested_next_actions).toBeUndefined();
		expect(json.fix_options).toBeUndefined();

		const quiet = captureJson(() =>
			outputResult(diagnosisPacket(), {
				format: "json",
				raw: false,
				quiet: true,
				evidenceOnly: true,
			}),
		);
		expect(quiet.evidence).toBeDefined();
		expect(quiet.fix_options).toBeUndefined();
	});

	test("leaves the packet untouched when the flag is off", () => {
		const json = captureJson(() =>
			outputResult(diagnosisPacket(), { format: "json", raw: false, quiet: false }),
		);
		expect(json.suggested_next_actions).toBeDefined();
		expect(json.fix_options).toBeDefined();
		expect(json.evidence_only).toBeUndefined();
	});
});

describe("failsafe diagnose --evidence-only (CLI)", () => {
	const CLI = join(import.meta.dir, "../../src/cli/index.ts");
	let workDir: string;

	async function run(args: string[]): Promise<{ exitCode: number; stdout: string }> {
		const proc = Bun.spawn(["bun", CLI, ...args], {
			cwd: workDir,
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		return { exitCode, stdout };
	}

	beforeAll(async () => {
		workDir = mkdtempSync(join(tmpdir(), "failsafe-evidence-only-"));
		await run(["init"]);
		await run(["run", "node -e \"throw new Error('boom')\""]);
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	test("diagnose keeps evidence and drops next actions", async () => {
		const full = await run(["diagnose", "last"]);
		const fullJson = JSON.parse(full.stdout) as Record<string, unknown>;
		expect(fullJson.suggested_next_actions).toBeDefined();

		const lean = await run(["diagnose", "last", "--evidence-only"]);
		expect(lean.exitCode).toBe(0);
		const leanJson = JSON.parse(lean.stdout) as Record<string, unknown>;
		expect(leanJson.evidence).toBeDefined();
		expect(leanJson.uncertainty).toBeDefined();
		expect(leanJson.evidence_only).toBe(true);
		expect(leanJson.suggested_next_actions).toBeUndefined();
		expect(leanJson.fix_options).toBeUndefined();
		// The lean packet is strictly smaller than the full one.
		expect(lean.stdout.length).toBeLessThan(full.stdout.length);
	}, 30_000);

	test("explain --evidence-only drops fix options in json and text", async () => {
		const lean = await run(["explain", "last", "--evidence-only"]);
		const leanJson = JSON.parse(lean.stdout) as Record<string, unknown>;
		expect(leanJson.evidence).toBeDefined();
		expect(leanJson.fix_options).toBeUndefined();
		expect(leanJson.recommended_fix).toBeUndefined();

		const text = await run(["explain", "last", "--evidence-only", "--format", "text"]);
		expect(text.stdout).toContain("Evidence:");
		expect(text.stdout).not.toContain("Fix options:");
	}, 30_000);
});
