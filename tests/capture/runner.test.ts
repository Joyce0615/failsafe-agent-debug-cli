import { describe, test, expect } from "bun:test";
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
