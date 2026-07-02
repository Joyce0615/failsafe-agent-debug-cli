/**
 * `failsafe apply` core (applyFix) tests.
 *
 * Drives the testable core directly against a real temp git repo and store:
 * a declared rule carrying a unified-diff `fix_patch` is validated and applied
 * via `git apply` (argv-first, no shell). Covers the dry-run gate, the
 * --confirm apply, and the no-diagnosis / no-patch / invalid-patch branches.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFix } from "../../src/cli/apply.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import type { RuleSource } from "../../src/rules/types.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import { DEFAULT_CONFIG, type FailsafeConfig } from "../../src/types/config.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { FailureRecord } from "../../src/types/failure.js";

let repoDir: string;
let store: FailsafeStore;
let config: FailsafeConfig;

const GREETING_PATCH = [
	"--- a/greeting.txt",
	"+++ b/greeting.txt",
	"@@ -1 +1 @@",
	"-hello",
	"+goodbye",
	"",
].join("\n");

/** A patch whose context will never match the working tree. */
const STALE_PATCH = [
	"--- a/greeting.txt",
	"+++ b/greeting.txt",
	"@@ -1 +1 @@",
	"-nonexistent line",
	"+something else",
	"",
].join("\n");

function git(args: string[]): void {
	const proc = Bun.spawnSync(["git", ...args], { cwd: repoDir });
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
}

function writeRules(patch: string | undefined, ruleId = "fix_greeting"): void {
	const diagnosis = patch
		? `      fix_patch: |\n${patch
				.split("\n")
				.map((l) => `        ${l}`)
				.join("\n")}`
		: '      fix: "edit greeting.txt by hand"';
	const yaml = [
		'version: "1"',
		"rules:",
		`  - id: ${ruleId}`,
		"    pattern:",
		'      error_contains: "KeyError"',
		"    diagnosis:",
		"      category: key_error",
		'      explanation: "Replace greeting"',
		diagnosis,
		"    confidence: 0.95",
		"",
	].join("\n");
	writeFileSync(join(repoDir, ".failsafe", "rules.yaml"), yaml);
}

function makeFailure(): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: "fail_apply",
		created_at: new Date().toISOString(),
		workspace: repoDir,
		command: "pytest tests/",
		cwd: repoDir,
		env_fingerprint: { os: "linux", arch: "x64", cwd: repoDir },
		status: "failed",
		exit_code: 1,
		duration_ms: 1,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed: [
			{ parser: "pytest", failure_type: "test_failure", errors: [{ message: "KeyError: 'x'" }] },
		],
		primary_location: { file: "greeting.txt", line: 1 },
		related_locations: [],
		raw_artifacts: [],
	};
}

function saveDiagnosis(opts: { ruleSource?: RuleSource; ruleId?: string } = {}): void {
	const diag: FailureDiagnosis = {
		schema_version: SCHEMA_VERSION,
		diagnosis_id: "diag_apply",
		failure_id: "fail_apply",
		failure_type: "test_failure",
		severity: "error",
		summary: "KeyError",
		root_cause: { category: "key_error", explanation: "missing key", confidence: 0.9 },
		evidence: [],
		uncertainty: [],
		minimal_context: [],
		suggested_next_actions: [],
		rule_source: opts.ruleSource ?? "declared",
		rule_id: opts.ruleId ?? "fix_greeting",
	};
	store.saveDiagnosis(diag);
}

beforeEach(() => {
	repoDir = mkdtempSync(join(tmpdir(), "failsafe-apply-"));
	config = { ...DEFAULT_CONFIG, storage_dir: join(repoDir, ".failsafe") };
	store = new FailsafeStore(config, repoDir);

	// A committed working tree so `git apply` has a real target.
	git(["init", "-q"]);
	git(["config", "user.email", "t@t.test"]);
	git(["config", "user.name", "Test"]);
	writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
	git(["add", "greeting.txt"]);
	git(["commit", "-q", "-m", "init"]);

	store.saveRun(makeFailure(), "", "", "");
});

afterEach(() => {
	store.close();
	rmSync(repoDir, { recursive: true, force: true });
});

describe("applyFix", () => {
	test("dry run validates the patch without writing (status dry_run)", async () => {
		writeRules(GREETING_PATCH);
		saveDiagnosis();
		const failure = store.getFailure("fail_apply") as FailureRecord;

		const result = await applyFix(failure, store, config, { confirm: false });

		expect(result.exit_code).toBe(ExitCode.OK);
		expect(result.data.status).toBe("dry_run");
		expect(result.data.files).toEqual(["greeting.txt"]);
		// The working tree is untouched on a dry run.
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("hello\n");
		// The suggested next action is to re-run with --confirm.
		const next = result.data.next as Array<{ command: string }>;
		expect(next[0].command).toContain("--confirm");
	});

	test("--confirm applies the patch and points to verify", async () => {
		writeRules(GREETING_PATCH);
		saveDiagnosis();
		const failure = store.getFailure("fail_apply") as FailureRecord;

		const result = await applyFix(failure, store, config, { confirm: true });

		expect(result.exit_code).toBe(ExitCode.OK);
		expect(result.data.status).toBe("applied");
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("goodbye\n");
		const next = result.data.next as Array<{ command: string }>;
		expect(next[0].command).toBe("failsafe verify fail_apply");
	});

	test("missing diagnosis returns NO_INPUT and never touches the tree", async () => {
		writeRules(GREETING_PATCH);
		// No saveDiagnosis() call.
		const failure = store.getFailure("fail_apply") as FailureRecord;

		const result = await applyFix(failure, store, config, { confirm: true });

		expect(result.exit_code).toBe(ExitCode.NO_INPUT);
		expect(result.data.status).toBe("no_diagnosis");
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("hello\n");
	});

	test("a declared rule without a patch returns DEBUG_UNAVAILABLE (no_patch)", async () => {
		writeRules(undefined); // rule has `fix:` prose but no fix_patch
		saveDiagnosis();
		const failure = store.getFailure("fail_apply") as FailureRecord;

		const result = await applyFix(failure, store, config, { confirm: true });

		expect(result.exit_code).toBe(ExitCode.DEBUG_UNAVAILABLE);
		expect(result.data.status).toBe("no_patch");
	});

	test("a non-declared (learned/builtin) diagnosis has no patch to apply", async () => {
		writeRules(GREETING_PATCH);
		saveDiagnosis({ ruleSource: "builtin", ruleId: undefined });
		const failure = store.getFailure("fail_apply") as FailureRecord;

		const result = await applyFix(failure, store, config, { confirm: true });

		expect(result.exit_code).toBe(ExitCode.DEBUG_UNAVAILABLE);
		expect(result.data.status).toBe("no_patch");
	});

	test("a patch that does not apply is rejected (invalid_patch) without writing", async () => {
		writeRules(STALE_PATCH);
		saveDiagnosis();
		const failure = store.getFailure("fail_apply") as FailureRecord;

		const result = await applyFix(failure, store, config, { confirm: true });

		expect(result.exit_code).toBe(ExitCode.ERROR);
		expect(result.data.status).toBe("invalid_patch");
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("hello\n");
	});
});
