import type { Command } from "commander";
import { verifyFailure } from "../core/operations.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

export function registerVerifyCommand(program: Command): void {
	program
		.command("verify <failure-id>")
		.description("Verify that a fix resolves the failure")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON for composable shell usage")
		.option("--timeout <seconds>", "Command timeout", "120")
		.option(
			"--flaky-check <runs>",
			"Re-run the minimal repro N times to confirm or refute flakiness",
		)
		.action(async (rawId: string, opts) => {
			const { config, store, outOpts } = initCommand(opts);
			const timeoutMs = Number.parseInt(opts.timeout, 10) * 1000;
			const flakyCheckRuns = opts.flakyCheck
				? Number.parseInt(opts.flakyCheck as string, 10)
				: undefined;

			// Delegate to the shared core so the CLI and the `failsafe_verify`
			// MCP tool emit exactly the same packet — including the item-32
			// fix-attempt recording on a failed verification.
			const result = await verifyFailure(rawId, store, config, { timeoutMs, flakyCheckRuns });
			if (!result.ok) {
				outputResult({ error: true, message: result.error.message }, outOpts);
				store.close();
				process.exit(result.error.exit_code);
			}

			const data = result.data;
			outputResult(data, outOpts, (d) => {
				const packet = d as Record<string, unknown>;
				const checks = (packet.checks ?? []) as Array<{
					kind: string;
					status: string;
					duration_ms: number;
					message?: string;
				}>;
				const lines = [
					`[VERIFY] ${packet.failure_id}: ${packet.status === "passed" ? "PASSED" : "FAILED"}`,
				];
				for (const c of checks) {
					const icon = c.status === "passed" ? "+" : "-";
					lines.push(`  [${icon}] ${c.kind}: ${c.status} (${c.duration_ms}ms)`);
					if (c.message) lines.push(`      ${c.message}`);
				}
				const attempt = packet.recorded_attempt as { summary: string; outcome: string } | undefined;
				if (attempt && attempt.outcome === "unresolved") {
					lines.push(`  recorded attempt (unresolved): ${attempt.summary}`);
				}
				const flaky = packet.flaky_check as { verdict?: string; note?: string } | undefined;
				if (flaky?.note) {
					lines.push(`  flaky check [${flaky.verdict}]: ${flaky.note}`);
				}
				return lines.join("\n");
			});

			store.close();
		});
}
