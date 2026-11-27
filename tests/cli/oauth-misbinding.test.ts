/**
 * `failsafe oauth-misbinding diagnose` CLI tests (item 54 — diagnose
 * OAuth issuer, CIMD, DPoP, and delegation misbinding).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(args: string[]): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-oauth-misbinding-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("oauth-misbinding diagnose", () => {
	test("reports an issuer_audience_mismatch finding", async () => {
		const usagesFile = join(workDir, "usages-mismatch.json");
		writeFileSync(
			usagesFile,
			JSON.stringify([
				{
					token_ref: "tok-1",
					issuer: "https://evil.example.com",
					expected_issuer: "https://as.example.com",
					audiences: ["https://api.example.com"],
					expected_audience: "https://api.example.com",
					authorization_server_id: "as-1",
					client_id: "client-1",
				},
			]),
		);
		const { exitCode, stdout } = await run(["oauth-misbinding", "diagnose", "--usages", usagesFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings.some((f: { kind: string }) => f.kind === "issuer_audience_mismatch")).toBe(
			true,
		);
	});

	test("reports no findings for clean usage records", async () => {
		const usagesFile = join(workDir, "usages-clean.json");
		writeFileSync(
			usagesFile,
			JSON.stringify([
				{
					token_ref: "tok-1",
					issuer: "https://as.example.com",
					expected_issuer: "https://as.example.com",
					audiences: ["https://api.example.com"],
					expected_audience: "https://api.example.com",
					authorization_server_id: "as-1",
					client_id: "client-1",
				},
			]),
		);
		const { exitCode, stdout } = await run(["oauth-misbinding", "diagnose", "--usages", usagesFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toEqual([]);
	});

	test("reports cross_as_credential_reuse across two usage records", async () => {
		const usagesFile = join(workDir, "usages-reuse.json");
		const usage = {
			token_ref: "tok-shared",
			issuer: "https://as.example.com",
			expected_issuer: "https://as.example.com",
			audiences: ["https://api.example.com"],
			expected_audience: "https://api.example.com",
			client_id: "client-1",
		};
		writeFileSync(
			usagesFile,
			JSON.stringify([
				{ ...usage, authorization_server_id: "as-1" },
				{ ...usage, authorization_server_id: "as-2" },
			]),
		);
		const { exitCode, stdout } = await run(["oauth-misbinding", "diagnose", "--usages", usagesFile]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(
			json.findings.some((f: { kind: string }) => f.kind === "cross_as_credential_reuse"),
		).toBe(true);
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const usagesFile = join(workDir, "usages-render.json");
		writeFileSync(
			usagesFile,
			JSON.stringify([
				{
					token_ref: "tok-1",
					issuer: "https://as.example.com",
					expected_issuer: "https://as.example.com",
					audiences: ["https://api.example.com"],
					expected_audience: "https://api.example.com",
					authorization_server_id: "as-1",
					client_id: "client-1",
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"oauth-misbinding",
			"diagnose",
			"--usages",
			usagesFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("OAuth Issuer/CIMD/DPoP/Delegation Misbinding Report");
	});

	test("errors with a non-zero exit code when the usages file is missing", async () => {
		const { exitCode, stdout } = await run([
			"oauth-misbinding",
			"diagnose",
			"--usages",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
