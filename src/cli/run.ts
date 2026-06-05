import type { Command } from "commander";
import { runCommand } from "../capture/runner.js";
import { detectAndParse, extractPrimaryLocation } from "../parsers/index.js";
import { loadPolicy, parseToArgv, validateCommand } from "../security/policy.js";
import { redactSecrets } from "../security/redaction.js";
import { SCHEMA_VERSION } from "../types/common.js";
import type { FailureRecord, FailureStatus } from "../types/failure.js";
import { formatFailureText } from "../utils/format.js";
import { failureId } from "../utils/id.js";
import { computeTokenBudget } from "../utils/tokens.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { createStore, loadConfig } from "./shared.js";

export function registerRunCommand(program: Command): void {
	program
		.command("run <command>")
		.description("Run a command, capture output, and store a failure record")
		.option("--format <format>", "Output format: json or text")
		.option("--timeout <seconds>", "Command timeout in seconds", "120")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--raw", "Include raw output in response")
		.option("--shell", "Run via 'sh -c' to allow shell syntax (operators, globs, pipes)")
		.option("--no-policy", "Skip command safety policy check")
		.action(async (command: string, opts) => {
			const config = loadConfig();
			const maxBytes = opts.maxBytes ? Number.parseInt(opts.maxBytes, 10) : undefined;
			const outOpts = resolveOutputOptions(
				{ ...opts, maxBytes },
				config.default_format,
				config.token_budget.max_output_bytes,
			);

			// Validate command against policy
			if (opts.policy !== false) {
				const policy = loadPolicy(config);
				const validation = validateCommand(command, policy);
				if (!validation.allowed) {
					const error = {
						error: true,
						message: `Command blocked by policy: ${validation.reason}`,
						command,
					};
					outputResult(error, outOpts);
					process.exit(1);
				}
			}

			// Decide execution mode: argv-first (safe) vs shell.
			// Simple commands run directly without a shell. Shell syntax
			// (operators, globs, redirects, variable expansion) requires an
			// explicit --shell flag, unless --no-policy is set.
			const timeoutMs = Number.parseInt(opts.timeout, 10) * 1000;
			let argv: string[] | undefined;
			if (opts.shell || opts.policy === false) {
				// Explicit shell mode (or policy bypassed): use sh -c.
				argv = undefined;
			} else {
				const parsed = parseToArgv(command);
				if (parsed.kind === "needs_shell") {
					outputResult(
						{
							error: true,
							needs_shell: true,
							message: `${parsed.reason}. Re-run with --shell to allow shell syntax, or simplify the command.`,
							command,
						},
						outOpts,
					);
					process.exit(1);
				}
				argv = parsed.argv;
			}

			const result = await runCommand(command, { timeout_ms: timeoutMs, argv });

			// Redact secrets from output
			const { redacted: redactedStdout, matched: stdoutMatches } = redactSecrets(result.stdout);
			const { redacted: redactedStderr, matched: stderrMatches } = redactSecrets(result.stderr);
			const { redacted: redactedCombined } = redactSecrets(result.combined);
			const allMatches = [...new Set([...stdoutMatches, ...stderrMatches])];

			// Parse the output
			const parsed = detectAndParse(redactedStdout, redactedStderr, command);
			const primaryLocation = extractPrimaryLocation(parsed);

			// Determine status
			let status: FailureStatus = "failed";
			if (result.exit_code === 0) status = "passed";
			else if (result.timed_out) status = "timeout";

			// Build failure record
			const store = createStore(config);
			const id = failureId();

			const rawBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);

			// Build compact output first to compute token budget
			const output: Record<string, unknown> = {
				schema_version: SCHEMA_VERSION,
				command,
				status,
				exit_code: result.exit_code,
				failure_id: id,
				failure_type: parsed[0]?.failure_type ?? "unknown",
				summary:
					parsed[0]?.errors[0]?.message ??
					(status === "passed" ? "All checks passed" : "Command failed"),
				duration_ms: result.duration_ms,
			};

			if (primaryLocation) {
				output.primary_location = primaryLocation;
			}

			if (parsed[0]?.test_summary) {
				output.test_summary = parsed[0].test_summary;
			}

			if (status !== "passed") {
				output.next = buildNextActions(id, parsed[0]?.failure_type, command, !!primaryLocation);
			}

			if (allMatches.length > 0) {
				output.redaction = { applied: true, patterns_matched: allMatches };
			}

			// Compute initial token budget for the record (before --raw fields)
			const compactBytes = Buffer.byteLength(JSON.stringify(output));
			const tokenBudget = computeTokenBudget(rawBytes, compactBytes);
			output.token_budget = tokenBudget;

			const record: FailureRecord = {
				schema_version: SCHEMA_VERSION,
				failure_id: id,
				created_at: new Date().toISOString(),
				workspace: process.cwd(),
				command,
				cwd: result.cwd,
				env_fingerprint: result.env_fingerprint,
				status,
				exit_code: result.exit_code,
				duration_ms: result.duration_ms,
				stdout_path: "",
				stderr_path: "",
				combined_log_path: "",
				parsed,
				primary_location: primaryLocation,
				related_locations: [],
				raw_artifacts: [],
				token_budget: tokenBudget,
			};

			// Save to store — returns actual artifact paths on disk
			const artifactPaths = store.saveRun(record, redactedStdout, redactedStderr, redactedCombined);

			// Include raw_paths so agents can fetch full output on demand,
			// unless explicitly disabled via config.token_budget.include_raw_paths.
			if (config.token_budget.include_raw_paths !== false) {
				output.raw_paths = {
					stdout: artifactPaths.stdout_path,
					stderr: artifactPaths.stderr_path,
					combined: artifactPaths.combined_path,
				};
			}

			if (opts.raw) {
				// Cap raw output per-field to half the byte limit (split between stdout/stderr)
				const rawFieldLimit = outOpts.maxBytes ? Math.floor(outOpts.maxBytes / 2) : undefined;
				if (rawFieldLimit && Buffer.byteLength(redactedStdout) > rawFieldLimit) {
					const buf = Buffer.from(redactedStdout);
					output.raw_stdout = buf.subarray(0, rawFieldLimit).toString("utf-8");
					output.raw_stdout_truncated = true;
					output.raw_stdout_full_bytes = Buffer.byteLength(redactedStdout);
				} else {
					output.raw_stdout = redactedStdout;
				}
				if (rawFieldLimit && Buffer.byteLength(redactedStderr) > rawFieldLimit) {
					const buf = Buffer.from(redactedStderr);
					output.raw_stderr = buf.subarray(0, rawFieldLimit).toString("utf-8");
					output.raw_stderr_truncated = true;
					output.raw_stderr_full_bytes = Buffer.byteLength(redactedStderr);
				} else {
					output.raw_stderr = redactedStderr;
				}
			}

			// Recompute token_budget.returned_bytes after final output shape
			const finalBytes = Buffer.byteLength(JSON.stringify(output));
			output.token_budget = computeTokenBudget(rawBytes, finalBytes);

			outputResult(output, outOpts, () => formatFailureText(record));
			store.close();
		});
}

function buildNextActions(
	id: string,
	failureType?: string,
	command?: string,
	hasPrimaryLocation?: boolean,
): Array<{ command: string; reason: string }> {
	const actions = [
		{
			command: `failsafe diagnose ${id}`,
			reason: "Build a root-cause packet",
		},
	];

	if (failureType === "test_failure") {
		actions.push({
			command: `failsafe repro ${id}`,
			reason: "Create a minimal reproduction",
		});
	}

	// Only suggest debug when the runtime is Python (the only supported
	// DAP adapter) and the failure has a primary location to break at.
	if (hasPrimaryLocation && command && /python3?|pytest|python\s+-m/.test(command)) {
		actions.push({
			command: `failsafe debug ${id} --break primary`,
			reason: "Inspect runtime state at failure line (experimental, requires debugpy)",
		});
	}

	return actions;
}
