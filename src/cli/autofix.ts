/**
 * `failsafe autofix <failure-id>` — a bounded retry-with-fix loop.
 *
 * Composes the existing cores: diagnose -> apply the suggested fix (a declared
 * rule's `fix_patch` via `applyFix`, plus any `fix_commands`) -> re-run the
 * original command -> repeat, up to `--max-attempts`. Everything runs under the
 * argv-first/no-shell policy, and the loop REFUSES to start on a flaky
 * signature (item 25): a non-deterministic failure must be re-run by a human,
 * not auto-patched on false certainty.
 *
 * The testable core `autofixLoop` is pure of process.exit/console and returns a
 * compact per-attempt trace; the CLI wrapper maps it to output + an exit code.
 */
import type { Command } from "commander";
import { runCommand } from "../capture/runner.js";
import { analyzeCommand, applyFix, diagnoseFailure } from "../core/operations.js";
import { loadDeclaredRules } from "../rules/declared.js";
import { loadPolicy, parseToArgv, validateCommand } from "../security/policy.js";
import type { FailsafeStore } from "../storage/store.js";
import type { FailsafeConfig } from "../types/config.js";
import type { FailureRecord } from "../types/failure.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

type CommandTrace = { command: string; status: "passed" | "failed" | "blocked"; message?: string };

type AttemptTrace = {
	attempt: number;
	fix_source: string;
	patch?: { status: string; files?: string[] };
	commands?: CommandTrace[];
	rerun_status: string;
	rerun_failure_id?: string;
};

export type AutofixResult = {
	exit_code: number;
	data: Record<string, unknown>;
};

type ResolvedFix = {
	source: string;
	rule_id: string;
	has_patch: boolean;
	fix_commands?: string[];
};

/** Resolve the fix actions (patch availability + fix_commands) for a failure. */
function resolveFix(
	failure: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
): ResolvedFix | null {
	const diagnosis = store.getDiagnosis(failure.failure_id);
	if (!diagnosis || !diagnosis.rule_source || !diagnosis.rule_id) return null;

	if (diagnosis.rule_source === "declared") {
		const rulesFilePath = `${failure.cwd}/${config.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
		const rule = loadDeclaredRules(rulesFilePath).find((r) => r.id === diagnosis.rule_id);
		if (!rule) return null;
		return {
			source: "declared",
			rule_id: rule.id,
			has_patch: !!rule.diagnosis.fix_patch,
			fix_commands: rule.diagnosis.fix_commands,
		};
	}
	if (diagnosis.rule_source === "learned") {
		const learned = store.getLearnedRule(diagnosis.rule_id);
		return {
			source: "learned",
			rule_id: diagnosis.rule_id,
			has_patch: false,
			fix_commands: learned?.fix_commands,
		};
	}
	// builtin tiers carry prose, not executable fix actions.
	return { source: diagnosis.rule_source, rule_id: diagnosis.rule_id, has_patch: false };
}

/** Run a rule's `fix_commands` under the no-shell policy, collecting a trace. */
async function runFixCommands(
	commands: string[],
	cwd: string,
	config: FailsafeConfig,
	timeoutMs: number,
): Promise<CommandTrace[]> {
	const policy = loadPolicy(config);
	const trace: CommandTrace[] = [];
	for (const command of commands) {
		const validation = validateCommand(command, policy);
		if (!validation.allowed) {
			trace.push({ command, status: "blocked", message: validation.reason });
			continue;
		}
		const parsed = parseToArgv(command);
		if (parsed.kind === "needs_shell") {
			trace.push({ command, status: "blocked", message: parsed.reason });
			continue;
		}
		const res = await runCommand(command, { cwd, timeout_ms: timeoutMs, argv: parsed.argv });
		trace.push({ command, status: res.exit_code === 0 ? "passed" : "failed" });
	}
	return trace;
}

/**
 * Run the bounded autofix loop for a failure. Returns the terminal status and a
 * per-attempt trace. Statuses: `fixed` (OK), `flaky_refused` (OK — deliberate
 * safe stop), `no_fix` (DEBUG_UNAVAILABLE), `fix_ineffective`/`exhausted`
 * (ERROR).
 */
export async function autofixLoop(
	failure: FailureRecord,
	store: FailsafeStore,
	config: FailsafeConfig,
	opts: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<AutofixResult> {
	const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const attempts: AttemptTrace[] = [];
	const triedFixes = new Set<string>();
	let current = failure;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const diag = await diagnoseFailure(current.failure_id, store, config);
		if (!diag.ok) {
			return { exit_code: diag.error.exit_code, data: { ...diag.error, attempts } };
		}

		// Safety guard (item 25): never auto-patch a flaky signature.
		if (diag.data.severity === "flaky") {
			return {
				exit_code: ExitCode.OK,
				data: {
					failure_id: current.failure_id,
					status: "flaky_refused",
					attempts_made: attempts.length,
					attempts,
					message:
						"Failure signature is flaky; refusing to auto-fix. Re-run the command to confirm before fixing.",
					next: [{ command: `failsafe verify ${current.failure_id}`, reason: "Re-run to confirm" }],
				},
			};
		}

		const fix = resolveFix(current, store, config);
		if (!fix || (!fix.has_patch && !(fix.fix_commands && fix.fix_commands.length > 0))) {
			return {
				exit_code: ExitCode.DEBUG_UNAVAILABLE,
				data: {
					failure_id: current.failure_id,
					status: "no_fix",
					attempts_made: attempts.length,
					attempts,
					message: "No applicable fix (patch or commands) for this failure.",
				},
			};
		}

		// Don't loop forever applying the same ineffective fix.
		const fixKey = `${fix.rule_id}|${fix.has_patch}|${(fix.fix_commands ?? []).join(";")}`;
		if (triedFixes.has(fixKey)) {
			return {
				exit_code: ExitCode.ERROR,
				data: {
					failure_id: current.failure_id,
					status: "fix_ineffective",
					attempts_made: attempts.length,
					attempts,
					message: "The same fix was already applied but the failure persists.",
				},
			};
		}
		triedFixes.add(fixKey);

		const trace: AttemptTrace = { attempt, fix_source: fix.source, rerun_status: "unknown" };

		if (fix.has_patch) {
			const applied = await applyFix(current, store, config, { confirm: true });
			trace.patch = {
				status: String(applied.data.status),
				files: applied.data.files as string[] | undefined,
			};
		}
		if (fix.fix_commands && fix.fix_commands.length > 0) {
			trace.commands = await runFixCommands(fix.fix_commands, current.cwd, config, timeoutMs);
		}

		// Re-run the original command fresh to see whether the fix took.
		const rerun = await analyzeCommand(current.command, config, store, { timeoutMs });
		if (!rerun.ok) {
			trace.rerun_status = "error";
			attempts.push(trace);
			return {
				exit_code: ExitCode.ERROR,
				data: {
					failure_id: current.failure_id,
					status: "rerun_error",
					attempts_made: attempts.length,
					attempts,
					message: rerun.error.message,
				},
			};
		}

		const rerunStatus = String(rerun.data.status);
		const rerunId = rerun.data.failure_id as string;
		trace.rerun_status = rerunStatus;
		trace.rerun_failure_id = rerunId;
		attempts.push(trace);

		if (rerunStatus === "passed") {
			return {
				exit_code: ExitCode.OK,
				data: {
					failure_id: current.failure_id,
					status: "fixed",
					attempts_made: attempts.length,
					attempts,
					next: [
						{
							command: `failsafe resolve ${current.failure_id}`,
							reason: "Record the successful fix in the knowledge base",
						},
					],
				},
			};
		}

		// The re-run produced a fresh failure record; diagnose/fix it next round.
		const next = store.getFailure(rerunId);
		if (next) current = next;
	}

	return {
		exit_code: ExitCode.ERROR,
		data: {
			failure_id: failure.failure_id,
			status: "exhausted",
			attempts_made: attempts.length,
			attempts,
			message: `Failure still present after ${maxAttempts} attempt(s).`,
		},
	};
}

export function registerAutofixCommand(program: Command): void {
	program
		.command("autofix <failure-id>")
		.description("Bounded retry-with-fix loop: diagnose -> apply fix -> re-run, up to N attempts")
		.option("--max-attempts <n>", "Maximum fix/verify attempts", "2")
		.option("--timeout <seconds>", "Per-command timeout in seconds", "120")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);

			const result = await autofixLoop(failure, store, config, {
				maxAttempts: Number.parseInt(opts.maxAttempts, 10),
				timeoutMs: Number.parseInt(opts.timeout, 10) * 1000,
			});

			outputResult(result.data, outOpts, () => {
				const d = result.data;
				const lines = [`[AUTOFIX] ${d.failure_id}: ${String(d.status).toUpperCase()}`];
				if (d.message) lines.push(`  ${d.message}`);
				for (const a of (d.attempts as AttemptTrace[]) ?? []) {
					lines.push(`  attempt ${a.attempt} (${a.fix_source}) -> re-run: ${a.rerun_status}`);
				}
				return lines.join("\n");
			});

			store.close();
			if (result.exit_code !== ExitCode.OK) process.exit(result.exit_code);
		});
}
