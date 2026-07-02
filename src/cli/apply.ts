/**
 * `failsafe apply <failure-id>` — apply a declared rule's suggested fix patch.
 *
 * Declared rules may carry a unified diff in `diagnosis.fix_patch`. This command
 * resolves the stored diagnosis for a failure, looks up the winning declared
 * rule, and applies its patch via `git apply` — always argv-first with no shell
 * interpolation, so a malicious `fix_patch` string can never inject a command.
 *
 * The patch is validated with `git apply --check` first. Without `--confirm`
 * the command stops there (a dry run) and reports the files that WOULD change;
 * `--confirm` then applies it. The follow-up next-action is always
 * `failsafe verify <id>` so the fix is confirmed by re-running the failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { runCommand } from "../capture/runner.js";
import { loadDeclaredRules } from "../rules/declared.js";
import type { FailsafeStore } from "../storage/store.js";
import type { FailsafeConfig } from "../types/config.js";
import type { FailureRecord } from "../types/failure.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

export type ApplyResult = {
	exit_code: number;
	data: Record<string, unknown>;
};

/** Resolve the declared-rule fix patch for a diagnosed failure, if any. */
function resolvePatch(
	failure: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
): { rule_id: string; diff: string } | null {
	const diagnosis = store.getDiagnosis(failure.failure_id);
	// Only declared rules carry an authored `fix_patch`; learned/builtin tiers
	// supply prose or commands, not a diff.
	if (!diagnosis || diagnosis.rule_source !== "declared" || !diagnosis.rule_id) return null;
	const rulesFilePath = `${failure.cwd}/${config.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
	const rule = loadDeclaredRules(rulesFilePath).find((r) => r.id === diagnosis.rule_id);
	const diff = rule?.diagnosis.fix_patch;
	if (!diff) return null;
	return { rule_id: rule.id, diff };
}

/** Parse `git apply --numstat` output into the list of touched file paths. */
function filesFromNumstat(numstat: string): string[] {
	const files: string[] = [];
	for (const line of numstat.split("\n")) {
		const parts = line.split("\t");
		if (parts.length >= 3 && parts[2]) files.push(parts[2]);
	}
	return files;
}

/**
 * Validate and (optionally) apply the declared fix patch for a resolved
 * failure. Pure of process.exit/console so it is unit-testable; the CLI wrapper
 * maps the result to output + an exit code.
 */
export async function applyFix(
	failure: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
	opts: { confirm?: boolean } = {},
): Promise<ApplyResult> {
	const failureId = failure.failure_id;

	if (!store.getDiagnosis(failureId)) {
		return {
			exit_code: ExitCode.NO_INPUT,
			data: {
				error: true,
				failure_id: failureId,
				status: "no_diagnosis",
				message: `No diagnosis found. Run \`failsafe diagnose ${failureId}\` first.`,
				next: [{ command: `failsafe diagnose ${failureId}`, reason: "Produce a diagnosis" }],
			},
		};
	}

	const patch = resolvePatch(failure, store, config);
	if (!patch) {
		return {
			exit_code: ExitCode.DEBUG_UNAVAILABLE,
			data: {
				failure_id: failureId,
				status: "no_patch",
				message: "No declared rule supplies a fix_patch for this failure.",
			},
		};
	}

	const dir = mkdtempSync(join(tmpdir(), "failsafe-apply-"));
	const patchFile = join(dir, "fix.patch");
	writeFileSync(patchFile, patch.diff.endsWith("\n") ? patch.diff : `${patch.diff}\n`);

	try {
		// Validate first — `git apply --check` neither stages nor writes anything.
		const check = await runCommand("git apply --check", {
			cwd: failure.cwd,
			timeout_ms: 30_000,
			argv: ["git", "apply", "--check", patchFile],
		});
		if (check.exit_code !== 0) {
			return {
				exit_code: ExitCode.ERROR,
				data: {
					failure_id: failureId,
					rule_id: patch.rule_id,
					status: "invalid_patch",
					message: "Patch does not apply cleanly to the working tree.",
					detail: check.stderr.trim() || check.stdout.trim(),
				},
			};
		}

		const numstat = await runCommand("git apply --numstat", {
			cwd: failure.cwd,
			timeout_ms: 30_000,
			argv: ["git", "apply", "--numstat", patchFile],
		});
		const files = filesFromNumstat(numstat.stdout);

		if (!opts.confirm) {
			return {
				exit_code: ExitCode.OK,
				data: {
					failure_id: failureId,
					rule_id: patch.rule_id,
					status: "dry_run",
					files,
					message: "Patch applies cleanly. Re-run with --confirm to apply it.",
					next: [
						{
							command: `failsafe apply ${failureId} --confirm`,
							reason: "Apply the validated patch",
						},
					],
				},
			};
		}

		const applied = await runCommand("git apply", {
			cwd: failure.cwd,
			timeout_ms: 30_000,
			argv: ["git", "apply", patchFile],
		});
		if (applied.exit_code !== 0) {
			return {
				exit_code: ExitCode.ERROR,
				data: {
					failure_id: failureId,
					rule_id: patch.rule_id,
					status: "apply_failed",
					message: "Patch validated but failed to apply.",
					detail: applied.stderr.trim() || applied.stdout.trim(),
				},
			};
		}

		return {
			exit_code: ExitCode.OK,
			data: {
				failure_id: failureId,
				rule_id: patch.rule_id,
				status: "applied",
				files,
				next: [
					{
						command: `failsafe verify ${failureId}`,
						reason: "Confirm the fix resolves the failure",
					},
				],
			},
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function registerApplyCommand(program: Command): void {
	program
		.command("apply <failure-id>")
		.description("Apply a declared rule's suggested fix patch (dry-run unless --confirm)")
		.option("--confirm", "Apply the patch (default is a validate-only dry run)")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);

			const result = await applyFix(failure, store, config, { confirm: opts.confirm });

			outputResult(result.data, outOpts, () => {
				const d = result.data;
				const lines = [`[APPLY] ${d.failure_id}: ${String(d.status).toUpperCase()}`];
				if (d.message) lines.push(`  ${d.message}`);
				if (Array.isArray(d.files) && d.files.length > 0) {
					lines.push(`  files: ${(d.files as string[]).join(", ")}`);
				}
				return lines.join("\n");
			});

			store.close();
			if (result.exit_code !== ExitCode.OK) process.exit(result.exit_code);
		});
}
