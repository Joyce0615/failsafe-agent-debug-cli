/**
 * `failsafe trace diagnose` CLI tests (item 21 — OpenTelemetry agent/workflow
 * conformance ingestion).
 *
 * Drives the real CLI binary end-to-end: a locally-exported Jaeger trace
 * payload is normalized, validated for conformance, and diagnosed through
 * one command — the first CLI entry point `trace/diagnose.ts` (item 40) and
 * `trace/conformance.ts` (item 21) are ever wired to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

const CLEAN_JAEGER_PAYLOAD = {
	data: [
		{
			traceID: TRACE_ID,
			processes: { p1: { serviceName: "checkout" }, p2: { serviceName: "payments" } },
			spans: [
				{
					spanID: "aaaa1111",
					operationName: "POST /checkout",
					processID: "p1",
					startTime: 1_700_000_000_000_000,
					duration: 500_000,
					tags: [],
				},
				{
					spanID: "bbbb2222",
					operationName: "charge",
					processID: "p2",
					startTime: 1_700_000_000_050_000,
					duration: 40_000,
					references: [{ refType: "CHILD_OF", spanID: "aaaa1111" }],
					tags: [
						{ key: "error", value: true },
						{ key: "exception.message", value: "gateway refused connection" },
					],
				},
			],
		},
	],
};

const BLOCKING_JAEGER_PAYLOAD = {
	data: [
		{
			traceID: TRACE_ID,
			processes: { p1: { serviceName: "checkout" } },
			spans: [
				{
					spanID: "aaaa1111",
					operationName: "weird_op",
					processID: "p1",
					startTime: 1_700_000_000_000_000,
					duration: 1000,
					tags: [{ key: "gen_ai.operation.name", value: "not_a_real_operation" }],
				},
			],
		},
	],
};

async function run(args: string[]): Promise<{ exitCode: number; json: Record<string, unknown> }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(stdout);
	} catch {}
	return { exitCode, json };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-trace-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("failsafe trace diagnose", () => {
	test("diagnoses a clean trace and reports the conformance summary", async () => {
		const file = join(workDir, "trace.json");
		writeFileSync(file, JSON.stringify(CLEAN_JAEGER_PAYLOAD));

		const r = await run(["trace", "diagnose", TRACE_ID, "--backend", "jaeger", "--file", file]);
		expect(r.exitCode).toBe(0);
		expect(r.json.summary as string).toContain("payments:charge");
		const conformance = r.json.conformance as Record<string, unknown>;
		expect(conformance.spans_examined).toBe(2);
		expect(conformance.blocking_issues).toBe(0);
	}, 30_000);

	test("a blocking conformance issue refuses diagnosis and exits non-zero", async () => {
		const file = join(workDir, "blocking.json");
		writeFileSync(file, JSON.stringify(BLOCKING_JAEGER_PAYLOAD));

		const r = await run(["trace", "diagnose", TRACE_ID, "--backend", "jaeger", "--file", file]);
		expect(r.exitCode).not.toBe(0);
		expect(r.json.message as string).toContain("blocking conformance issue");
		const conformance = r.json.conformance as Record<string, unknown>;
		expect(conformance.blocking_issues).toBe(1);
	}, 30_000);

	test("correlated log records supplied via --logs are tallied in the report", async () => {
		const file = join(workDir, "trace2.json");
		const logsFile = join(workDir, "logs.json");
		writeFileSync(file, JSON.stringify(CLEAN_JAEGER_PAYLOAD));
		writeFileSync(
			logsFile,
			JSON.stringify([
				{
					ts_ms: 1_700_000_000_000,
					severity_text: "ERROR",
					body: "gateway refused connection",
					trace_id: TRACE_ID,
					span_id: "bbbb2222",
				},
			]),
		);

		const r = await run([
			"trace",
			"diagnose",
			TRACE_ID,
			"--backend",
			"jaeger",
			"--file",
			file,
			"--logs",
			logsFile,
		]);
		expect(r.exitCode).toBe(0);
		const conformance = r.json.conformance as Record<string, unknown>;
		expect(conformance.logs_examined).toBe(1);
		expect((conformance.log_correlation as Record<string, unknown>).exact).toBe(1);
	}, 30_000);

	test("an invalid --backend value is rejected before any file is read", async () => {
		const r = await run([
			"trace",
			"diagnose",
			TRACE_ID,
			"--backend",
			"not-a-backend",
			"--file",
			join(workDir, "trace.json"),
		]);
		expect(r.exitCode).not.toBe(0);
		expect(r.json.message as string).toContain("--backend must be");
	}, 30_000);
});
