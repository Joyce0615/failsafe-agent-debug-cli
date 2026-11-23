/**
 * `failsafe oauth-misbinding diagnose` — OAuth issuer/CIMD/DPoP/
 * delegation misbinding diagnosis CLI entry point (item 54).
 *
 * Mirrors `mrtr.ts`'s (item 51) and `mcp-subscription.ts`'s (item 52)
 * read-only, local-JSON-file pattern. A caller supplies already-
 * extracted `OAuthCredentialUsage[]` claim/validation metadata; this
 * command never parses, verifies, or touches a raw token itself, and
 * the input schema's own `token_ref` field is documented as opaque so
 * nothing resembling a bearer secret is expected on this path.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type OAuthCredentialUsage,
	diagnoseOAuthMisbinding,
	renderOAuthMisbindingReport,
} from "../diagnosis/oauth-misbinding.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand } from "./shared.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function registerOAuthMisbindingCommand(program: Command): void {
	const oauth = program
		.command("oauth-misbinding")
		.description(
			"Diagnose OAuth issuer/audience mismatch, cross-AS credential reuse, stale client metadata (CIMD), DPoP key/nonce failures, and delegation binding errors",
		);

	oauth
		.command("diagnose")
		.description("Diagnose every misbinding finding across a set of credential usage records")
		.requiredOption(
			"--usages <path>",
			"Path to a JSON OAuthCredentialUsage[] array (token_ref is opaque -- never a raw token)",
		)
		.option("--render", "Emit the human-readable Markdown rendering instead of JSON")
		.option("--format <format>", "Output format: json or text")
		.option("--quiet", "Emit minified single-line JSON")
		.action((opts) => {
			const { store, outOpts } = initCommand(opts);

			let usages: OAuthCredentialUsage[];
			try {
				usages = readJson(opts.usages as string) as OAuthCredentialUsage[];
			} catch (err) {
				outputResult(
					{ error: true, message: `Failed to read input: ${(err as Error).message}` },
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
				return;
			}

			const findings = diagnoseOAuthMisbinding(usages);

			if (opts.render) {
				process.stdout.write(renderOAuthMisbindingReport(findings));
			} else {
				outputResult({ findings } as unknown as Record<string, unknown>, outOpts);
			}
			store.close();
		});
}
