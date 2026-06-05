import type { Command } from "commander";
import { runCommand } from "../capture/runner.js";
import { detectAndParse } from "../parsers/index.js";
import { computeSignature, signaturesMatch } from "../repro/signatures.js";
import { loadPolicy, parseToArgv, validateCommand } from "../security/policy.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureId } from "./shared.js";

export function registerVerifyCommand(program: Command): void {
	program
		.command("verify <failure-id>")
		.description("Verify that a fix resolves the failure")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--timeout <seconds>", "Command timeout", "120")
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const timeoutMs = Number.parseInt(opts.timeout, 10) * 1000;

			const failureId = resolveFailureId(rawId, store);
			if (!failureId) {
				outputResult({ error: true, message: "No failure found" }, outOpts);
				process.exit(1);
			}

			const failure = store.getFailure(failureId);
			if (!failure) {
				outputResult({ error: true, message: `Failure not found: ${failureId}` }, outOpts);
				process.exit(1);
			}

			const repro = store.getRepro(failureId);
			const policy = loadPolicy(config);
			const checks: Array<{
				kind: string;
				command: string;
				status: "passed" | "failed" | "error" | "blocked";
				duration_ms: number;
				message?: string;
			}> = [];

			// Run the minimal repro first (faster), re-validating policy
			if (repro && repro.status === "verified") {
				const reproValidation = validateCommand(repro.command, policy);
				if (!reproValidation.allowed) {
					checks.push({
						kind: "minimal_repro",
						command: repro.command,
						status: "blocked",
						duration_ms: 0,
						message: `Repro command blocked by policy: ${reproValidation.reason}`,
					});
				} else {
					const reproParsed = parseToArgv(repro.command);
					const reproResult = await runCommand(repro.command, {
						cwd: failure.cwd,
						timeout_ms: timeoutMs,
						argv: reproParsed.kind === "argv" ? reproParsed.argv : undefined,
					});
					checks.push({
						kind: "minimal_repro",
						command: repro.command,
						status: reproResult.exit_code === 0 ? "passed" : "failed",
						duration_ms: reproResult.duration_ms,
						message:
							reproResult.exit_code !== 0 ? "Minimal repro still fails after fix" : undefined,
					});
				}
			}

			// Re-validate the original command against policy before execution
			const origValidation = validateCommand(failure.command, policy);
			if (!origValidation.allowed) {
				checks.push({
					kind: "original_command",
					command: failure.command,
					status: "blocked",
					duration_ms: 0,
					message: `Original command blocked by policy: ${origValidation.reason}`,
				});
			} else {
				const origParsed = parseToArgv(failure.command);
				const originalResult = await runCommand(failure.command, {
					cwd: failure.cwd,
					timeout_ms: timeoutMs,
					argv: origParsed.kind === "argv" ? origParsed.argv : undefined,
				});
				checks.push({
					kind: "original_command",
					command: failure.command,
					status: originalResult.exit_code === 0 ? "passed" : "failed",
					duration_ms: originalResult.duration_ms,
					message: originalResult.exit_code !== 0 ? "Original command still fails" : undefined,
				});
			}

			const allPassed = checks.every((c) => c.status === "passed");

			// Build resolution candidate signature
			const allErrors = failure.parsed.flatMap((p) => p.errors);
			const signature = computeSignature(allErrors, failure.primary_location);

			const output: Record<string, unknown> = {
				failure_id: failureId,
				status: allPassed ? "passed" : "failed",
				checks,
			};

			if (allPassed) {
				output.resolution_candidate = {
					ready_to_store: true,
					signature: `${signature.exception_type ?? "?"}|${signature.top_frame_function ?? "?"}|${signature.top_frame_file ?? "?"}`,
				};
			}

			outputResult(output, outOpts, () => {
				const lines = [`[VERIFY] ${failureId}: ${allPassed ? "PASSED" : "FAILED"}`];
				for (const c of checks) {
					const icon = c.status === "passed" ? "+" : "-";
					lines.push(`  [${icon}] ${c.kind}: ${c.status} (${c.duration_ms}ms)`);
					if (c.message) lines.push(`      ${c.message}`);
				}
				return lines.join("\n");
			});

			store.close();
		});
}
