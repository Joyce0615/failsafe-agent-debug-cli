import { describe, expect, test } from "bun:test";
import { runCommand } from "../../src/capture/runner.js";

describe("runCommand", () => {
	test("captures stdout from successful command", async () => {
		const result = await runCommand("echo hello world");
		expect(result.exit_code).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");
		expect(result.timed_out).toBe(false);
	});

	test("captures exit code from failing command", async () => {
		const result = await runCommand("exit 42");
		expect(result.exit_code).toBe(42);
	});

	test("captures stderr", async () => {
		const result = await runCommand("echo error >&2");
		expect(result.stderr.trim()).toBe("error");
	});

	test("records duration", async () => {
		const result = await runCommand("echo fast");
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
		expect(result.duration_ms).toBeLessThan(10000);
	});

	test("captures env fingerprint", async () => {
		const result = await runCommand("echo test");
		expect(result.env_fingerprint.os).toBeDefined();
		expect(result.env_fingerprint.arch).toBeDefined();
		expect(result.env_fingerprint.cwd).toBeDefined();
	});

	test("handles timeout", async () => {
		const result = await runCommand("sleep 10", { timeout_ms: 500 });
		expect(result.timed_out).toBe(true);
		expect(result.exit_code).toBeNull();
	});
});

describe("runCommand argv mode (no shell)", () => {
	test("argv mode runs the array directly and ignores the command string", async () => {
		// If this went through `sh -c "<command>"`, the bogus command string
		// would fail (exit 127). Getting ARGV_OK proves the shell is bypassed
		// and the argv array is executed directly.
		const result = await runCommand("DEFINITELY_NOT_A_REAL_COMMAND_zzz --nope", {
			argv: ["node", "-e", "process.stdout.write('ARGV_OK')"],
		});
		expect(result.exit_code).toBe(0);
		expect(result.stdout).toContain("ARGV_OK");
	});

	test("argv mode does not perform shell expansion on arguments", async () => {
		// A literal '$HOME' arg is passed verbatim (no shell variable expansion).
		const result = await runCommand("ignored", {
			argv: ["node", "-e", "process.stdout.write(process.argv[1])", "$HOME"],
		});
		expect(result.exit_code).toBe(0);
		expect(result.stdout).toContain("$HOME");
	});

	test("shell mode (no argv) interprets shell operators via sh -c", async () => {
		// Without argv, the command string runs through sh -c, so '&&' chains.
		const result = await runCommand("echo first && echo second");
		expect(result.stdout).toContain("first");
		expect(result.stdout).toContain("second");
	});
});
