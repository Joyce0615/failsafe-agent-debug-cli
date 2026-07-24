/**
 * Multi-candidate fix ranking + validation tests (item 28).
 *
 * `buildFixCandidates` ranks the tiered fix options (declared patch, learned
 * commands, builtin suggestion) by confidence; `validateCandidates` applies
 * each declared patch in order, re-runs verify, and selects the first that
 * flips the failing command to passing — reverting a non-resolving patch so the
 * next candidate applies to a clean tree.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FixCandidate,
	buildFixCandidates,
	validateCandidates,
} from "../../src/core/operations.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import { DEFAULT_CONFIG, type FailsafeConfig } from "../../src/types/config.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { FailureRecord } from "../../src/types/failure.js";

let repoDir: string;
let store: FailsafeStore;
let config: FailsafeConfig;

// The failing command exits 0 only once value.txt says "fixed".
const CHECK_JS = `const v = require('fs').readFileSync('value.txt','utf8').trim();\nprocess.exit(v === 'fixed' ? 0 : 1);\n`;

function patchValue(from: string, to: string): string {
	return ["--- a/value.txt", "+++ b/value.txt", "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");
}

function git(args: string[]): void {
	const p = Bun.spawnSync(["git", ...args], { cwd: repoDir });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
}

function makeFailure(): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: "fail_validate",
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
			{ parser: "js-stack", failure_type: "runtime_exception", errors: [{ message: "boom" }] },
		],
		primary_location: { file: "value.txt", line: 1 },
		related_locations: [],
		raw_artifacts: [],
	};
}

function saveDiagnosis(): void {
	const diag: FailureDiagnosis = {
		schema_version: SCHEMA_VERSION,
		diagnosis_id: "diag_validate",
		failure_id: "fail_validate",
		failure_type: "runtime_exception",
		severity: "error",
		summary: "boom",
		root_cause: { category: "unknown", explanation: "value not fixed", confidence: 0.5 },
		evidence: [],
		uncertainty: [],
		minimal_context: [],
		suggested_next_actions: [],
	};
	store.saveDiagnosis(diag);
}

beforeEach(() => {
	repoDir = mkdtempSync(join(tmpdir(), "failsafe-fixcand-"));
	config = { ...DEFAULT_CONFIG, storage_dir: join(repoDir, ".failsafe") };
	store = new FailsafeStore(config, repoDir);

	git(["init", "-q"]);
	git(["config", "user.email", "t@t.test"]);
	git(["config", "user.name", "Test"]);
	writeFileSync(join(repoDir, "value.txt"), "broken\n");
	writeFileSync(join(repoDir, "check.js"), CHECK_JS);
	git(["add", "value.txt", "check.js"]);
	git(["commit", "-q", "-m", "init"]);

	store.saveRun(makeFailure(), "", "", "");
	saveDiagnosis();
});

afterEach(() => {
	store.close();
	rmSync(repoDir, { recursive: true, force: true });
});

describe("buildFixCandidates", () => {
	test("ranks a builtin suggestion when only a diagnosis exists", () => {
		const failure = store.getFailure("fail_validate") as FailureRecord;
		const candidates = buildFixCandidates(failure, store, config);
		// No declared rule / learned commands here → just the builtin suggestion.
		expect(candidates.map((c) => c.kind)).toEqual(["builtin_suggestion"]);
		expect(candidates[0].confidence).toBeLessThanOrEqual(0.5);
	});
});

describe("validateCandidates", () => {
	test("skips a non-resolving patch and selects the next one that passes verify", async () => {
		const failure = store.getFailure("fail_validate") as FailureRecord;
		// Two competing declared patches: the first applies but does NOT fix the
		// command; the second applies and flips it to passing.
		const candidates: FixCandidate[] = [
			{
				kind: "declared_patch",
				confidence: 0.9,
				rule_id: "bad_fix",
				summary: "does not resolve",
				patch: patchValue("broken", "still-broken"),
			},
			{
				kind: "declared_patch",
				confidence: 0.8,
				rule_id: "good_fix",
				summary: "resolves",
				patch: patchValue("broken", "fixed"),
			},
		];

		const result = await validateCandidates(failure, store, config, candidates, {
			timeoutMs: 30_000,
		});

		expect(result.exit_code).toBe(0);
		expect(result.data.status).toBe("validated");
		const selected = result.data.selected as { rule_id: string };
		expect(selected.rule_id).toBe("good_fix");
		const attempts = result.data.attempts as Array<{ rule_id: string; status: string }>;
		expect(attempts[0]).toMatchObject({ rule_id: "bad_fix", status: "unresolved" });
		expect(attempts[1]).toMatchObject({ rule_id: "good_fix", status: "resolved" });
		// The winning patch is left applied; the reverted one did not persist.
		expect(
			Bun.spawnSync(["git", "diff", "--name-only"], { cwd: repoDir }).stdout.toString(),
		).toContain("value.txt");
	}, 60_000);

	test("returns no_fix_validated when every candidate fails verify", async () => {
		const failure = store.getFailure("fail_validate") as FailureRecord;
		const candidates: FixCandidate[] = [
			{
				kind: "declared_patch",
				confidence: 0.9,
				rule_id: "bad_fix",
				summary: "does not resolve",
				patch: patchValue("broken", "still-broken"),
			},
		];

		const result = await validateCandidates(failure, store, config, candidates, {
			timeoutMs: 30_000,
		});

		expect(result.exit_code).not.toBe(0);
		expect(result.data.status).toBe("no_fix_validated");
		// The non-resolving patch was reverted, leaving tracked files unchanged.
		expect(
			Bun.spawnSync(["git", "diff", "--name-only"], { cwd: repoDir }).stdout.toString().trim(),
		).toBe("");
	}, 60_000);
});
