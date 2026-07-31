/**
 * `failsafe dump` tests (item 22).
 *
 * Seeds a run whose output carries a secret, then asserts dump returns the
 * selected redacted stream, honors the byte cap (with a token_budget +
 * truncation note), and never leaks the secret.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-dump-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("failsafe dump", () => {
	test("returns the redacted stderr stream for a failure", async () => {
		// The child prints a secret + many lines to stderr; the stored log is
		// redacted before dump ever reads it.
		const seed = await run([
			"run",
			"node -e \"console.error('AKIA'+'IOSFODNN7EXAMPLE'); for(let i=0;i<50;i++)console.error('line '+i); process.exit(1)\"",
		]);
		const id = seed.json.failure_id as string;
		expect(id).toBeDefined();

		const r = await run(["dump", id, "--stderr"]);
		expect(r.exitCode).toBe(0);
		expect(r.json.stream).toBe("stderr");
		expect(r.json.truncated).toBe(false);
		expect(r.json.content as string).toContain("[REDACTED]");
		expect(r.json.content as string).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(r.json.token_budget).toBeDefined();
	}, 30_000);

	test("--max-bytes caps the output and attaches a truncation note", async () => {
		const r = await run(["dump", "last", "--stderr", "--max-bytes", "40"]);
		expect(r.exitCode).toBe(0);
		expect(r.json.truncated).toBe(true);
		expect(r.json.note as string).toContain("truncated");
		const tb = r.json.token_budget as Record<string, unknown>;
		expect(tb.returned_bytes as number).toBeLessThan(tb.raw_output_bytes as number);
		// Truncated content still carries no secret.
		expect(r.json.content as string).not.toContain("AKIAIOSFODNN7EXAMPLE");
	}, 30_000);

	test("defaults to stdout and selects combined when asked", async () => {
		const def = await run(["dump", "last"]);
		expect(def.json.stream).toBe("stdout");
		const combined = await run(["dump", "last", "--combined"]);
		expect(combined.json.stream).toBe("combined");
	}, 30_000);

	test("unknown failure id exits NO_INPUT", async () => {
		const r = await run(["dump", "fail_missing"]);
		expect(r.exitCode).toBe(2);
	});
});
