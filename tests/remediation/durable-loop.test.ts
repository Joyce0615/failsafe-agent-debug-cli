/**
 * Detect -> Attribute -> Recover -> Rerun durable state machine tests
 * (item 96).
 *
 * The critical property under test is crash recovery: a process that dies
 * partway through a remediation run must not lose the fact that it was
 * remediating, and must not duplicate a non-idempotent `fix_commands` side
 * effect when a caller resumes. Each "crash" is simulated by closing the
 * store mid-run (exactly like `autofix.test.ts` simulates everything else
 * against a real temp git repo + real sqlite store) and reopening a fresh
 * `FailsafeStore` against the same on-disk database, then calling
 * `resumeDurableRemediation` instead of starting over.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { analyzeCommand } from "../../src/core/operations.js";
import {
	resumeDurableRemediation,
	startDurableRemediation,
} from "../../src/remediation/durable-loop.js";
import { clearDeclaredRulesCache } from "../../src/rules/declared.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { DEFAULT_CONFIG, type FailsafeConfig } from "../../src/types/config.js";
import type { FailureRecord } from "../../src/types/failure.js";

let repoDir: string;
let store: FailsafeStore;
let config: FailsafeConfig;
let originalCwd: string;

function git(args: string[]): void {
	const proc = Bun.spawnSync(["git", ...args], { cwd: repoDir });
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
}

function writeRules(yaml: string): void {
	writeFileSync(join(repoDir, ".failsafe", "rules.yaml"), yaml);
}

function patchRuleYaml(patch: string, ruleId = "fix_greeting"): string {
	const fixPatch = `      fix_patch: |\n${patch
		.split("\n")
		.map((l) => `        ${l}`)
		.join("\n")}`;
	return [
		'version: "1"',
		"rules:",
		`  - id: ${ruleId}`,
		"    pattern:",
		'      error_contains: "greeting mismatch"',
		"    diagnosis:",
		"      category: type_error",
		'      explanation: "Rewrite the greeting"',
		fixPatch,
		"    confidence: 0.95",
		"",
	].join("\n");
}

function commandRuleYaml(commands: string[], ruleId = "bump_counter"): string {
	return [
		'version: "1"',
		"rules:",
		`  - id: ${ruleId}`,
		"    pattern:",
		'      error_contains: "counter mismatch"',
		"    diagnosis:",
		"      category: type_error",
		'      explanation: "Bump the counter"',
		"      fix_commands:",
		...commands.map((c) => `        - ${JSON.stringify(c)}`),
		"    confidence: 0.95",
		"",
	].join("\n");
}

const GOODBYE_PATCH = [
	"--- a/greeting.txt",
	"+++ b/greeting.txt",
	"@@ -1 +1 @@",
	"-hello",
	"+goodbye",
	"",
].join("\n");

const CHECK_JS = [
	'const fs = require("node:fs");',
	'const greeting = fs.readFileSync(__dirname + "/greeting.txt", "utf8").trim();',
	'if (greeting !== "goodbye") {',
	'  throw new TypeError("greeting mismatch: expected goodbye but got " + greeting);',
	"}",
	'console.log("ok");',
	"",
].join("\n");

const COUNTER_CHECK_JS = [
	'const fs = require("node:fs");',
	'const v = fs.readFileSync(__dirname + "/counter.txt", "utf8").trim();',
	'if (v !== "1") {',
	'  throw new TypeError("counter mismatch: expected exactly 1 but got [" + v + "]");',
	"}",
	'console.log("ok");',
	"",
].join("\n");

beforeEach(() => {
	originalCwd = process.cwd();
	repoDir = mkdtempSync(join(tmpdir(), "failsafe-durable-"));
	config = { ...DEFAULT_CONFIG, storage_dir: join(repoDir, ".failsafe") };
	store = new FailsafeStore(config, repoDir);
	process.chdir(repoDir);
	clearDeclaredRulesCache();

	git(["init", "-q"]);
	git(["config", "user.email", "t@t.test"]);
	git(["config", "user.name", "Test"]);
});

afterEach(() => {
	process.chdir(originalCwd);
	store.close();
	rmSync(repoDir, { recursive: true, force: true });
});

describe("startDurableRemediation (happy paths, parity with autofixLoop)", () => {
	test("applies a declared patch, re-run passes, run persists as fixed", async () => {
		writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
		writeFileSync(join(repoDir, "check.js"), CHECK_JS);
		git(["add", "greeting.txt", "check.js"]);
		git(["commit", "-q", "-m", "init"]);
		writeRules(patchRuleYaml(GOODBYE_PATCH));

		const run0 = await analyzeCommand("node check.js", config, store);
		expect(run0.ok).toBe(true);
		if (!run0.ok) return;
		const failure = store.getFailure(run0.data.failure_id as string) as FailureRecord;

		const result = await startDurableRemediation(failure, store, config, { maxAttempts: 2 });

		expect(result.exit_code).toBe(ExitCode.OK);
		expect(result.run.status).toBe("fixed");
		expect(result.run.phase).toBe("done");
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("goodbye\n");
		expect(result.run.attempts).toHaveLength(1);
		expect(result.run.attempts[0].effects[0].status).toBe("applied");

		// Durably persisted: a fresh read of the same run_id from the store
		// (as a crash-recovery inspector would do) agrees.
		const reloaded = store.getRemediationRun(result.run.run_id);
		expect(reloaded?.status).toBe("fixed");
		expect(reloaded?.attempts).toHaveLength(1);
	});

	test("no applicable fix is recorded as no_fix, not silently dropped", async () => {
		writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
		writeFileSync(join(repoDir, "check.js"), CHECK_JS);
		git(["add", "greeting.txt", "check.js"]);
		git(["commit", "-q", "-m", "init"]);

		const run0 = await analyzeCommand("node check.js", config, store);
		expect(run0.ok).toBe(true);
		if (!run0.ok) return;
		const failure = store.getFailure(run0.data.failure_id as string) as FailureRecord;

		const result = await startDurableRemediation(failure, store, config, { maxAttempts: 2 });

		expect(result.exit_code).toBe(ExitCode.DEBUG_UNAVAILABLE);
		expect(result.run.status).toBe("no_fix");
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("hello\n");
	});
});

describe("crash recovery (the item 96 property)", () => {
	test("resuming after a crash during recover does not re-run a non-idempotent fix_command", async () => {
		// This reproduces the confirmed real bug: a fix_command that appends to
		// a file is NOT idempotent. A naive in-memory loop restarted after a
		// crash re-runs it, duplicating the side effect (counter "1" -> "11").
		// The durable state machine must instead recognize the already-applied
		// effect and halt for review rather than re-execute it blind.
		writeFileSync(join(repoDir, "counter.txt"), "");
		writeFileSync(join(repoDir, "check.js"), COUNTER_CHECK_JS);
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "init"]);
		writeRules(
			commandRuleYaml(["node -e \"require('fs').appendFileSync('counter.txt','1')\""]),
		);

		const run0 = await analyzeCommand("node check.js", config, store);
		expect(run0.ok).toBe(true);
		if (!run0.ok) return;
		const failure = store.getFailure(run0.data.failure_id as string) as FailureRecord;

		// Start the run; it will run the fix_command (counter -> "1"), then
		// re-run and pass. This represents "the recovery side effect already
		// landed durably" -- but to exercise the resume path meaningfully we
		// need a crash truly mid-recover (an effect in `pending`), which a
		// completed run cannot produce. Simulate that directly: open a run,
		// drive it through the `pending` recovery-effect write, then "crash"
		// (never flip the effect's status, never do the rerun), close the
		// store, reopen, and resume.
		const openRun = {
			run_id: "rr_test_crash_1",
			failure_id: failure.failure_id,
			phase: "recover" as const,
			status: "in_progress" as const,
			max_attempts: 2,
			attempts: [
				{
					attempt: 1,
					fix_source: "declared",
					attributed_failure_id: failure.failure_id,
					effects: [
						{
							kind: "command" as const,
							descriptor: "node -e \"require('fs').appendFileSync('counter.txt','1')\"",
							status: "pending" as const,
							recorded_at: new Date().toISOString(),
						},
					],
					rerun_status: "pending" as const,
				},
			],
			tried_fix_keys: ["bump_counter|false|node -e \"require('fs').appendFileSync('counter.txt','1')\""],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		store.insertRemediationRun(openRun);

		// Actually run the side effect "out of band" the way the crashed
		// process would have, right before it died -- counter is now "1" on
		// disk, but the run row still says `pending` because the process never
		// got to record the outcome.
		Bun.spawnSync(["node", "-e", "require('fs').appendFileSync('counter.txt','1')"], {
			cwd: repoDir,
		});
		expect(readFileSync(join(repoDir, "counter.txt"), "utf-8")).toBe("1");

		// "Crash": close and reopen the store (same on-disk DB file).
		store.close();
		store = new FailsafeStore(config, repoDir);

		const resumed = await resumeDurableRemediation(failure.failure_id, store, config);
		expect(resumed).not.toBeNull();
		if (!resumed) return;

		// The durable loop must NOT have re-executed the fix_command: the
		// counter must still read "1", never "11".
		expect(readFileSync(join(repoDir, "counter.txt"), "utf-8")).toBe("1");

		// It must also refuse to silently treat the effect as successful: the
		// run halts for human review, with the ambiguous effect marked
		// `blocked` (never silently re-labeled `applied`).
		expect(resumed.run.status).toBe("requires_review");
		expect(resumed.exit_code).toBe(ExitCode.ERROR);
		const effect = resumed.run.attempts[0].effects[0];
		expect(effect.status).toBe("blocked");

		// The halted run is itself durable: re-reading it from a brand new
		// store handle agrees.
		const reloaded = store.getRemediationRun(openRun.run_id);
		expect(reloaded?.status).toBe("requires_review");
	});

	test("resuming after a crash right after recover completes (before rerun) re-runs ONLY the rerun, not recovery", async () => {
		writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
		writeFileSync(join(repoDir, "check.js"), CHECK_JS);
		git(["add", "greeting.txt", "check.js"]);
		git(["commit", "-q", "-m", "init"]);
		writeRules(patchRuleYaml(GOODBYE_PATCH));

		const run0 = await analyzeCommand("node check.js", config, store);
		expect(run0.ok).toBe(true);
		if (!run0.ok) return;
		const failure = store.getFailure(run0.data.failure_id as string) as FailureRecord;

		// Simulate: the patch effect already ran and durably recorded `applied`
		// (greeting.txt really was rewritten to "goodbye" on disk), but the
		// process crashed before calling analyzeCommand() to verify.
		writeFileSync(join(repoDir, "greeting.txt"), "goodbye\n");
		const openRun = {
			run_id: "rr_test_crash_2",
			failure_id: failure.failure_id,
			phase: "recover" as const,
			status: "in_progress" as const,
			max_attempts: 2,
			attempts: [
				{
					attempt: 1,
					fix_source: "declared",
					attributed_failure_id: failure.failure_id,
					effects: [
						{
							kind: "patch" as const,
							descriptor: "declared fix_patch",
							status: "applied" as const,
							detail: "applied",
							files_changed: ["greeting.txt"],
							recorded_at: new Date().toISOString(),
						},
					],
					rerun_status: "pending" as const,
				},
			],
			tried_fix_keys: ["fix_greeting|true|"],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		store.insertRemediationRun(openRun);

		store.close();
		store = new FailsafeStore(config, repoDir);

		const resumed = await resumeDurableRemediation(failure.failure_id, store, config);
		expect(resumed).not.toBeNull();
		if (!resumed) return;

		// Recovery was NOT redone (the patch was already `applied`): the file
		// was never re-patched, and the loop went straight to verifying.
		expect(resumed.run.status).toBe("fixed");
		expect(resumed.exit_code).toBe(ExitCode.OK);
		expect(resumed.run.attempts).toHaveLength(1);
		expect(resumed.run.attempts[0].effects).toHaveLength(1);
		expect(resumed.run.attempts[0].rerun_status).toBe("passed");
	});

	test("resuming a run with no open attempt yet (crashed right after Detect) runs Attribute fresh", async () => {
		writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
		writeFileSync(join(repoDir, "check.js"), CHECK_JS);
		git(["add", "greeting.txt", "check.js"]);
		git(["commit", "-q", "-m", "init"]);
		writeRules(patchRuleYaml(GOODBYE_PATCH));

		const run0 = await analyzeCommand("node check.js", config, store);
		expect(run0.ok).toBe(true);
		if (!run0.ok) return;
		const failure = store.getFailure(run0.data.failure_id as string) as FailureRecord;

		const openRun = {
			run_id: "rr_test_crash_3",
			failure_id: failure.failure_id,
			phase: "detect" as const,
			status: "in_progress" as const,
			max_attempts: 2,
			attempts: [],
			tried_fix_keys: [],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		store.insertRemediationRun(openRun);
		store.close();
		store = new FailsafeStore(config, repoDir);

		const resumed = await resumeDurableRemediation(failure.failure_id, store, config);
		expect(resumed).not.toBeNull();
		if (!resumed) return;
		expect(resumed.run.status).toBe("fixed");
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("goodbye\n");
	});

	test("resumeDurableRemediation returns null when there is no in-progress run", async () => {
		writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
		writeFileSync(join(repoDir, "check.js"), CHECK_JS);
		git(["add", "greeting.txt", "check.js"]);
		git(["commit", "-q", "-m", "init"]);
		const run0 = await analyzeCommand("node check.js", config, store);
		expect(run0.ok).toBe(true);
		if (!run0.ok) return;
		const failure = store.getFailure(run0.data.failure_id as string) as FailureRecord;

		const resumed = await resumeDurableRemediation(failure.failure_id, store, config);
		expect(resumed).toBeNull();
	});

	test("a run that already finished (status fixed) is not picked up by resume", async () => {
		writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
		writeFileSync(join(repoDir, "check.js"), CHECK_JS);
		git(["add", "greeting.txt", "check.js"]);
		git(["commit", "-q", "-m", "init"]);
		writeRules(patchRuleYaml(GOODBYE_PATCH));

		const run0 = await analyzeCommand("node check.js", config, store);
		expect(run0.ok).toBe(true);
		if (!run0.ok) return;
		const failure = store.getFailure(run0.data.failure_id as string) as FailureRecord;

		const result = await startDurableRemediation(failure, store, config, { maxAttempts: 2 });
		expect(result.run.status).toBe("fixed");

		const resumed = await resumeDurableRemediation(failure.failure_id, store, config);
		expect(resumed).toBeNull();
	});
});

describe("flaky guard parity (item 25, must still hold in the durable loop)", () => {
	test("a flaky signature is refused before any recovery effect is recorded", async () => {
		writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
		writeFileSync(join(repoDir, "check.js"), CHECK_JS);
		git(["add", "greeting.txt", "check.js"]);
		git(["commit", "-q", "-m", "init"]);
		writeRules(patchRuleYaml(GOODBYE_PATCH));

		const { SCHEMA_VERSION } = await import("../../src/types/common.js");
		const { computeSignatureHash } = await import("../../src/rules/learned.js");

		const failure: FailureRecord = {
			schema_version: SCHEMA_VERSION,
			failure_id: "fail_flaky_durable",
			created_at: new Date().toISOString(),
			workspace: repoDir,
			command: "node check.js",
			cwd: repoDir,
			env_fingerprint: { os: "linux", arch: "x64", cwd: repoDir },
			status: "failed",
			exit_code: 1,
			duration_ms: 1,
			stdout_path: "",
			stderr_path: "",
			combined_log_path: "",
			parsed: [
				{
					parser: "js-stack",
					failure_type: "runtime_exception",
					errors: [{ message: "greeting mismatch: expected goodbye", error_type: "TypeError" }],
				},
			],
			primary_location: undefined,
			related_locations: [],
			raw_artifacts: [],
		};
		store.saveRun(failure, "", "", "");
		const hash = computeSignatureHash(failure.parsed[0].errors, failure.primary_location);
		store.insertFixOutcome({
			failure_id: "fail_flaky_durable",
			signature_hash: hash,
			resolved_at: "2020-01-01T00:00:00.000Z",
			success: true,
		});
		for (let i = 0; i < 3; i++) {
			const id = `recur_durable_${i}`;
			store.saveRun({ ...failure, failure_id: id }, "", "", "");
			store.saveSignature(id, { exception_type: "TypeError" });
			store.updateSignatureHash(id, hash);
		}

		const result = await startDurableRemediation(failure, store, config, { maxAttempts: 2 });

		expect(result.exit_code).toBe(ExitCode.OK);
		expect(result.run.status).toBe("flaky_refused");
		expect(result.run.attempts).toHaveLength(0);
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("hello\n");
	});
});
