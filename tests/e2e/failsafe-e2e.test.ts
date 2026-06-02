import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/capture/runner.js";
import { diagnose } from "../../src/diagnosis/engine.js";
import { detectAndParse, extractPrimaryLocation } from "../../src/parsers/index.js";
import { redactSecrets } from "../../src/security/redaction.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { FailureRecord, FailureStatus } from "../../src/types/failure.js";
import { failureId } from "../../src/utils/id.js";
import { computeTokenBudget } from "../../src/utils/tokens.js";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const PYTEST_PROJECT = join(PROJECT_ROOT, "tests/e2e/pytest_project");
const NODE_PROJECT = join(PROJECT_ROOT, "tests/e2e/node_project");

let tempDir: string;
let store: FailsafeStore;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "failsafe-e2e-"));
	const config = { ...DEFAULT_CONFIG, storage_dir: join(tempDir, ".failsafe") };
	store = new FailsafeStore(config, tempDir);
});

afterAll(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

async function captureFailure(command: string, cwd?: string): Promise<FailureRecord> {
	const result = await runCommand(command, { cwd: cwd ?? PROJECT_ROOT });
	const { redacted: stdout } = redactSecrets(result.stdout);
	const { redacted: stderr } = redactSecrets(result.stderr);
	const { redacted: combined } = redactSecrets(result.combined);
	const parsed = detectAndParse(stdout, stderr, command);
	const primaryLocation = extractPrimaryLocation(parsed);
	const rawBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);

	let status: FailureStatus = "failed";
	if (result.exit_code === 0) status = "passed";
	else if (result.timed_out) status = "timeout";

	const id = failureId();
	const tokenBudget = computeTokenBudget(rawBytes, 500);

	const record: FailureRecord = {
		schema_version: SCHEMA_VERSION,
		failure_id: id,
		created_at: new Date().toISOString(),
		workspace: PROJECT_ROOT,
		command,
		cwd: result.cwd,
		env_fingerprint: result.env_fingerprint,
		status,
		exit_code: result.exit_code,
		duration_ms: result.duration_ms,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed,
		primary_location: primaryLocation,
		related_locations: [],
		raw_artifacts: [],
		token_budget: tokenBudget,
	};

	store.saveRun(record, stdout, stderr, combined);
	return record;
}

describe("E2E: pytest project", () => {
	test("captures multi-failure pytest output", async () => {
		const record = await captureFailure(`pytest ${PYTEST_PROJECT}/tests/test_buggy_calc.py -v`);

		expect(record.status).toBe("failed");
		expect(record.exit_code).toBe(1);
		expect(record.parsed.length).toBeGreaterThan(0);

		// Should detect as test_failure
		const pytestResult = record.parsed.find((p) => p.parser === "pytest");
		expect(pytestResult).toBeDefined();
		expect(pytestResult!.failure_type).toBe("test_failure");

		// Should have test summary
		expect(pytestResult!.test_summary).toBeDefined();
		expect(pytestResult!.test_summary!.failed).toBeGreaterThanOrEqual(3);
		expect(pytestResult!.test_summary!.passed).toBeGreaterThanOrEqual(2);

		// Should have parsed errors with test names
		expect(pytestResult!.errors.length).toBeGreaterThan(0);
		const errorNames = pytestResult!.errors.map((e) => e.test_name).filter(Boolean);
		expect(errorNames.length).toBeGreaterThan(0);
	}, 30_000);

	test("diagnoses pytest failure with builtin template", async () => {
		const record = await captureFailure(`pytest ${PYTEST_PROJECT}/tests/test_buggy_calc.py -v`);

		const diag = await diagnose(record, store, DEFAULT_CONFIG);

		expect(diag.failure_id).toBe(record.failure_id);
		expect(diag.failure_type).toBe("test_failure");
		expect(diag.severity).toBeDefined();
		expect(diag.summary.length).toBeGreaterThan(0);

		// Should have some evidence or context
		expect(diag.evidence.length > 0 || diag.minimal_context.length > 0).toBe(true);

		// Should have suggested actions
		expect(diag.suggested_next_actions.length).toBeGreaterThan(0);
	}, 30_000);

	test("token budget shows compression for large output", async () => {
		const result = await runCommand(`pytest ${PYTEST_PROJECT}/tests/ -v`, { cwd: PROJECT_ROOT });

		const rawBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);

		// Real pytest output with 20+ tests should be substantial
		expect(rawBytes).toBeGreaterThan(1000);

		const parsed = detectAndParse(result.stdout, result.stderr, "pytest");
		// Compact output should be much smaller than raw
		const compactBytes = Buffer.byteLength(
			JSON.stringify({
				status: "failed",
				failure_type: parsed[0]?.failure_type,
				summary: parsed[0]?.errors[0]?.message,
				test_summary: parsed[0]?.test_summary,
			}),
		);

		expect(compactBytes).toBeLessThan(rawBytes);
	}, 30_000);
});

describe("E2E: Node.js/Jest project", () => {
	test("captures Jest failure output", async () => {
		const result = await runCommand(
			`./node_modules/.bin/jest --config='{}' --testMatch='**/*.fixture-test.js'`,
			{ cwd: NODE_PROJECT },
		);

		expect(result.exit_code).not.toBe(0);

		const parsed = detectAndParse(result.stdout, result.stderr, "jest");
		expect(parsed.length).toBeGreaterThan(0);

		const jestResult = parsed.find((p) => p.parser === "jest");
		expect(jestResult).toBeDefined();
		expect(jestResult!.failure_type).toBe("test_failure");
		expect(jestResult!.test_summary).toBeDefined();
		expect(jestResult!.test_summary!.failed).toBe(2);
		expect(jestResult!.test_summary!.passed).toBe(5);
		expect(jestResult!.test_summary!.total).toBe(7);
	}, 30_000);

	test("extracts primary location from Jest stack trace", async () => {
		const result = await runCommand(
			`./node_modules/.bin/jest --config='{}' --testMatch='**/*.fixture-test.js'`,
			{ cwd: NODE_PROJECT },
		);

		const parsed = detectAndParse(result.stdout, result.stderr, "jest");
		const location = extractPrimaryLocation(parsed);

		expect(location).toBeDefined();
		expect(location!.file).toContain("auth");
		expect(location!.line).toBeGreaterThan(0);
	}, 30_000);
});

describe("E2E: stored failure retrieval", () => {
	test("getFailure returns full parsed data from disk", async () => {
		const record = await captureFailure(
			`pytest ${PYTEST_PROJECT}/tests/test_buggy_calc.py::test_divide_items_by_zero -x`,
		);

		const retrieved = store.getFailure(record.failure_id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.failure_id).toBe(record.failure_id);
		expect(retrieved!.parsed.length).toBeGreaterThan(0);

		// Should have full error data (not just summary from DB)
		const errors = retrieved!.parsed.flatMap((p) => p.errors);
		expect(errors.length).toBeGreaterThan(0);
	}, 30_000);

	test("token_budget is persisted on saved failure", async () => {
		const record = await captureFailure(`pytest ${PYTEST_PROJECT}/tests/test_buggy_calc.py -v`);

		const retrieved = store.getFailure(record.failure_id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.token_budget).toBeDefined();
		expect(retrieved!.token_budget!.raw_output_bytes).toBeGreaterThan(0);
	}, 30_000);
});
