import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FailsafeStore } from "../../src/storage/store.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { FailureRecord } from "../../src/types/failure.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";

let store: FailsafeStore;
let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "failsafe-test-"));
	const config = { ...DEFAULT_CONFIG, storage_dir: join(tempDir, ".failsafe") };
	store = new FailsafeStore(config, tempDir);
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

function makeRecord(overrides?: Partial<FailureRecord>): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: `fail_test_${Date.now()}`,
		created_at: new Date().toISOString(),
		workspace: tempDir,
		command: "pytest tests/",
		cwd: tempDir,
		env_fingerprint: { os: "linux", arch: "x64", cwd: tempDir },
		status: "failed",
		exit_code: 1,
		duration_ms: 1234,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed: [
			{
				parser: "pytest",
				failure_type: "test_failure",
				errors: [{ message: "KeyError: 'email'" }],
			},
		],
		primary_location: { file: "src/auth.py", line: 42 },
		related_locations: [],
		raw_artifacts: [],
		...overrides,
	};
}

describe("FailsafeStore", () => {
	test("saves and retrieves a failure", () => {
		const record = makeRecord();
		store.saveRun(record, "stdout content", "stderr content", "combined");

		const retrieved = store.getFailure(record.failure_id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.failure_id).toBe(record.failure_id);
		expect(retrieved!.command).toBe("pytest tests/");
		expect(retrieved!.status).toBe("failed");
	});

	test("retrieves last failure", () => {
		const r1 = makeRecord({ failure_id: "fail_first" });
		const r2 = makeRecord({ failure_id: "fail_second" });
		store.saveRun(r1, "out1", "err1", "combined1");
		store.saveRun(r2, "out2", "err2", "combined2");

		const last = store.getFailure("last");
		expect(last).not.toBeNull();
		expect(last!.failure_id).toBe("fail_second");
	});

	test("stores and reads raw output", () => {
		const record = makeRecord();
		store.saveRun(record, "hello stdout", "hello stderr", "combined");

		const stdout = store.getRawOutput(record.failure_id, "stdout");
		const stderr = store.getRawOutput(record.failure_id, "stderr");
		expect(stdout).toBe("hello stdout");
		expect(stderr).toBe("hello stderr");
	});

	test("lists failures", () => {
		store.saveRun(makeRecord({ failure_id: "fail_a" }), "", "", "");
		store.saveRun(makeRecord({ failure_id: "fail_b" }), "", "", "");

		const list = store.listFailures({ limit: 10 });
		expect(list.length).toBe(2);
	});

	test("returns null for missing failure", () => {
		const result = store.getFailure("nonexistent");
		expect(result).toBeNull();
	});
});
