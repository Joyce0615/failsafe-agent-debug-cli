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
 *
 * The implementation lives in `src/core/operations.ts` (`applyFix`/
 * `applyFixById`) so the CLI and the `failsafe_apply` MCP tool share one path.
 */
import type { Command } from "commander";
import { applyFixById } from "../core/operations.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

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

			const result = await applyFixById(rawId, store, config, { confirm: opts.confirm });

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
