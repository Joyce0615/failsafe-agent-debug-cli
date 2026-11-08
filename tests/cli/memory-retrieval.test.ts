/**
 * `failsafe memory-retrieve` CLI tests (item 34 — privacy-safe debugging
 * memory retrieval).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(
	args: string[],
	env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout };
}

const KEY_ENV = { FAILSAFE_BUNDLE_KEY: "test-signing-key" };

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-memory-retrieve-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function unsignedBundle() {
	return {
		schema_version: "0.1",
		bundle_id: "b1",
		created_at: new Date().toISOString(),
		origin: { workspace_hash: "abc123abc123abc123abc123abc123ab", tool_version: "0.1.0" },
		consent: {
			granted: true,
			scope: ["failure"],
			grantor: "team-a",
			granted_at: "2026-01-01T00:00:00.000Z",
		},
		failure: {
			signature_hash: "sig-abc",
			failure_type: "test_failure",
			normalized_message: "KeyError",
		},
	};
}

describe("memory-retrieve", () => {
	test("refuses without FAILSAFE_BUNDLE_KEY set", async () => {
		const candidatesFile = join(workDir, "no-key-candidates.json");
		writeFileSync(candidatesFile, JSON.stringify([]));
		const { exitCode, stdout } = await run(["memory-retrieve", "--candidates", candidatesFile]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});

	test("a query with no --tenant and no --cross-tenant is refused, preventing tenant leakage", async () => {
		const candidatesFile = join(workDir, "candidates.json");
		writeFileSync(candidatesFile, JSON.stringify([{ bundle: unsignedBundle(), tenant: "acme" }]));
		const { exitCode, stdout } = await run(
			["memory-retrieve", "--candidates", candidatesFile],
			KEY_ENV,
		);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});

	test("an unsigned bundle is retrieved as zero results with a low_trust refusal, not an error", async () => {
		const candidatesFile = join(workDir, "scoped-candidates.json");
		writeFileSync(candidatesFile, JSON.stringify([{ bundle: unsignedBundle(), tenant: "acme" }]));
		const { exitCode, stdout } = await run(
			["memory-retrieve", "--candidates", candidatesFile, "--tenant", "acme"],
			KEY_ENV,
		);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.scope).toBe("tenant 'acme'");
		expect(json.retrieved).toBe(0);
		expect(json.refusals[0]?.reason).toBe("low_trust");
	});
});
