/**
 * `failsafe autofix` core (autofixLoop) tests.
 *
 * Drives the bounded retry-with-fix loop end-to-end against a real temp git
 * repo + store: a declared rule carrying a `fix_patch` is applied, then the
 * original command is re-run to see whether the failure cleared. Covers the
 * happy path (fixed), the no-applicable-fix branch, the ineffective-fix guard,
 * and — most importantly — the flaky refusal (item 25): a non-deterministic
 * signature must never be auto-patched. `runWatchCycle`-style cores run the
 * command in `process.cwd()`, so each test pins cwd to its temp repo.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autofixLoop } from "../../src/cli/autofix.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { analyzeCommand } from "../../src/core/operations.js";
import { clearDeclaredRulesCache } from "../../src/rules/declared.js";
import { computeSignatureHash } from "../../src/rules/learned.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import { DEFAULT_CONFIG, type FailsafeConfig } from "../../src/types/config.js";
import type { FailureRecord } from "../../src/types/failure.js";

let repoDir: string;
let store: FailsafeStore;
let config: FailsafeConfig;
let originalCwd: string;

// A check that throws (uncaught TypeError) until greeting.txt reads "goodbye".
// A *named* error type is used deliberately: Node's bare `Error:` lines are not
// recognized by the js-stack parser (it requires a prefixed *Error type), so a
// TypeError gives a clean, parseable failure that a declared rule can match.
const CHECK_JS = [
	'const fs = require("node:fs");',
	'const greeting = fs.readFileSync(__dirname + "/greeting.txt", "utf8").trim();',
	'if (greeting !== "goodbye") {',
	'  throw new TypeError("greeting mismatch: expected goodbye but got " + greeting);',
	"}",
	'console.log("ok");',
	"",
].join("\n");

// Patch that fixes the check by rewriting the greeting to "goodbye".
const GOODBYE_PATCH = [
	"--- a/greeting.txt",
	"+++ b/greeting.txt",
	"@@ -1 +1 @@",
	"-hello",
	"+goodbye",
	"",
].join("\n");

// Patch that applies cleanly to "hello" but does NOT satisfy the check.
const INEFFECTIVE_PATCH = [
	"--- a/greeting.txt",
	"+++ b/greeting.txt",
	"@@ -1 +1 @@",
	"-hello",
	"+farewell",
	"",
].join("\n");

function git(args: string[]): void {
	const proc = Bun.spawnSync(["git", ...args], { cwd: repoDir });
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
}

function writeRules(patch: string, ruleId = "fix_greeting"): void {
	const fixPatch = `      fix_patch: |\n${patch
		.split("\n")
		.map((l) => `        ${l}`)
		.join("\n")}`;
	const yaml = [
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
	writeFileSync(join(repoDir, ".failsafe", "rules.yaml"), yaml);
}

beforeEach(() => {
	originalCwd = process.cwd();
	repoDir = mkdtempSync(join(tmpdir(), "failsafe-autofix-"));
	config = { ...DEFAULT_CONFIG, storage_dir: join(repoDir, ".failsafe") };
	store = new FailsafeStore(config, repoDir);
	process.chdir(repoDir);
	// Declared rules are cached per path+mtime; clear so a fresh temp dir that
	// reuses an inode/path never serves a stale parse.
	clearDeclaredRulesCache();

	// A committed working tree so `git apply` has a real target.
	git(["init", "-q"]);
	git(["config", "user.email", "t@t.test"]);
	git(["config", "user.name", "Test"]);
	writeFileSync(join(repoDir, "greeting.txt"), "hello\n");
	writeFileSync(join(repoDir, "check.js"), CHECK_JS);
	git(["add", "greeting.txt", "check.js"]);
	git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
	process.chdir(originalCwd);
	store.close();
	rmSync(repoDir, { recursive: true, force: true });
});

describe("autofixLoop", () => {
	test("applies a declared patch and the re-run passes (status fixed)", async () => {
		writeRules(GOODBYE_PATCH);
		const run = await analyzeCommand("node check.js", config, store);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		expect(run.data.status).toBe("failed");
		const failure = store.getFailure(run.data.failure_id as string) as FailureRecord;

		const result = await autofixLoop(failure, store, config, { maxAttempts: 2 });

		expect(result.exit_code).toBe(ExitCode.OK);
		expect(result.data.status).toBe("fixed");
		// The patch landed: greeting.txt was rewritten to "goodbye".
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("goodbye\n");
		// A single attempt sufficed.
		expect(result.data.attempts_made).toBe(1);
		// Points the agent at recording the successful fix.
		const next = result.data.next as Array<{ command: string }>;
		expect(next[0].command).toContain("failsafe resolve");
	});

	test("a builtin diagnosis with no patch/commands returns no_fix", async () => {
		// No rules.yaml: the failure diagnoses to a builtin template that carries
		// prose, not an executable fix.
		const run = await analyzeCommand("node check.js", config, store);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		const failure = store.getFailure(run.data.failure_id as string) as FailureRecord;

		const result = await autofixLoop(failure, store, config, { maxAttempts: 2 });

		expect(result.exit_code).toBe(ExitCode.DEBUG_UNAVAILABLE);
		expect(result.data.status).toBe("no_fix");
		// The working tree is untouched when there is nothing to apply.
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("hello\n");
	});

	test("a patch that applies but does not fix the failure is ineffective", async () => {
		writeRules(INEFFECTIVE_PATCH);
		const run = await analyzeCommand("node check.js", config, store);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		const failure = store.getFailure(run.data.failure_id as string) as FailureRecord;

		const result = await autofixLoop(failure, store, config, { maxAttempts: 2 });

		expect(result.exit_code).toBe(ExitCode.ERROR);
		expect(result.data.status).toBe("fix_ineffective");
		// The patch did land on the first attempt, but the check still fails.
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("farewell\n");
	});

	test("a flaky signature is refused before any fix is applied", async () => {
		writeRules(GOODBYE_PATCH);

		// Hand-build a KeyError failure and seed the store so its signature reads
		// as flaky: a prior successful fix followed by >= threshold recurrences.
		const failure: FailureRecord = {
			schema_version: SCHEMA_VERSION,
			failure_id: "fail_flaky",
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

		// A successful fix in the distant past (the fix_outcomes row references an
		// existing failure, so it is keyed to the failure under autofix here).
		store.insertFixOutcome({
			failure_id: "fail_flaky",
			signature_hash: hash,
			resolved_at: "2020-01-01T00:00:00.000Z",
			success: true,
		});
		// Three unresolved recurrences AFTER that fix → flaky once diagnosed.
		for (let i = 0; i < 3; i++) {
			const id = `recur_${i}`;
			store.saveRun({ ...failure, failure_id: id }, "", "", "");
			store.saveSignature(id, { exception_type: "TypeError" });
			store.updateSignatureHash(id, hash);
		}

		const result = await autofixLoop(failure, store, config, { maxAttempts: 2 });

		expect(result.exit_code).toBe(ExitCode.OK);
		expect(result.data.status).toBe("flaky_refused");
		// No attempt was made — the guard fires before any patch is applied.
		expect(result.data.attempts_made).toBe(0);
		expect(readFileSync(join(repoDir, "greeting.txt"), "utf-8")).toBe("hello\n");
		const next = result.data.next as Array<{ command: string }>;
		expect(next[0].command).toContain("failsafe verify");
	});
});
