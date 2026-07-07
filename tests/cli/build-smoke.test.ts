/**
 * Publish-build smoke test.
 *
 * Runs the real `scripts/build.ts` to produce the publishable `dist/` bundles
 * and asserts the built `bin` entrypoints are runnable: each starts with the
 * Bun shebang, the CLI bundle reports its version and help, and the MCP server
 * bundle is emitted. This guards the npm packaging path (`bin` → `dist/*.js`,
 * `prepublishOnly` build) so a publish never ships a broken binary.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLI_BUNDLE = join(ROOT, "dist/index.js");
const MCP_BUNDLE = join(ROOT, "dist/server.js");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(["bun", ...args], { cwd: ROOT });
	return {
		code: proc.exitCode ?? -1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

beforeAll(() => {
	const build = run(["scripts/build.ts"]);
	if (build.code !== 0) throw new Error(`build failed: ${build.stderr}`);
});

describe("publish build", () => {
	test("emits both bin bundles with a Bun shebang on line 1", () => {
		expect(existsSync(CLI_BUNDLE)).toBe(true);
		expect(existsSync(MCP_BUNDLE)).toBe(true);
		expect(readFileSync(CLI_BUNDLE, "utf-8").split("\n")[0]).toBe("#!/usr/bin/env bun");
		expect(readFileSync(MCP_BUNDLE, "utf-8").split("\n")[0]).toBe("#!/usr/bin/env bun");
	});

	test("the built CLI reports its version", () => {
		const { code, stdout } = run([CLI_BUNDLE, "--version"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("0.1.0");
	});

	test("the built CLI prints help listing its commands", () => {
		const { code, stdout } = run([CLI_BUNDLE, "--help"]);
		expect(code).toBe(0);
		expect(stdout).toContain("Usage: failsafe");
		expect(stdout).toContain("diagnose");
		expect(stdout).toContain("ci");
	});
});
