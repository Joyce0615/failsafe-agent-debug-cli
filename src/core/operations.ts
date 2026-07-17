/**
 * Core operations shared by the CLI and the MCP server.
 *
 * Each function returns a plain JSON-serializable result object that matches
 * the CLI's output contract exactly, so the MCP tools and the CLI never
 * diverge. Errors are returned as structured objects (never thrown) with an
 * `error: true` flag and an `exit_code` hint mirroring the CLI exit codes.
 */
import { runCommand } from "../capture/runner.js";
import { ExitCode } from "../cli/exit-codes.js";
import { diagnose } from "../diagnosis/engine.js";
import {
	detectAndParse,
	extractPrimaryLocation,
	extractRelatedLocations,
} from "../parsers/index.js";
import { generateRepro } from "../repro/engine.js";
import { computeSignature } from "../repro/signatures.js";
import { loadPolicy, parseToArgv, validateCommand } from "../security/policy.js";
import { redactSecrets } from "../security/redaction.js";
import type { FailsafeStore } from "../storage/store.js";
import {
	diagnoseSpanAttributes,
	parseSpanAttributes,
	reproSpanAttributes,
	runErrorSpanAttributes,
	runSpanAttributes,
	verifyErrorSpanAttributes,
	verifySpanAttributes,
} from "../telemetry/attributes.js";
import { withSpan } from "../telemetry/otel.js";
import { SCHEMA_VERSION } from "../types/common.js";
import type { FailsafeConfig } from "../types/config.js";
import type { FailureDiagnosis } from "../types/diagnosis.js";
import type { FailureRecord, FailureStatus } from "../types/failure.js";
import { failureId } from "../utils/id.js";
import { computeTokenBudget } from "../utils/tokens.js";

export type CoreError = { error: true; exit_code: number; message: string } & Record<
	string,
	unknown
>;

export type CoreResult<T> = { ok: true; data: T } | { ok: false; error: CoreError };

function buildNextActions(
	id: string,
	failureType?: string,
	command?: string,
	hasPrimaryLocation?: boolean,
): Array<{ command: string; reason: string }> {
	const actions = [{ command: `failsafe diagnose ${id}`, reason: "Build a root-cause packet" }];
	if (failureType === "test_failure") {
		actions.push({ command: `failsafe repro ${id}`, reason: "Create a minimal reproduction" });
	}
	if (hasPrimaryLocation && command && /python3?|pytest|python\s+-m/.test(command)) {
		actions.push({
			command: `failsafe debug ${id} --break primary`,
			reason: "Inspect runtime state at failure line (experimental, requires debugpy)",
		});
	}
	return actions;
}

/**
 * Run a command, capture/parse/store the result, and return the compact
 * failure packet — identical to `failsafe run`. Does not add `--raw` fields;
 * callers that want raw output append them on top of the returned packet.
 */
export async function analyzeCommand(
	command: string,
	config: FailsafeConfig,
	store: FailsafeStore,
	opts: { timeoutMs?: number; shell?: boolean; noPolicy?: boolean } = {},
): Promise<CoreResult<Record<string, unknown>>> {
	return withSpan("failsafe.run", async (setAttrs) => {
		const result = await analyzeCommandImpl(command, config, store, opts);
		if (result.ok) {
			setAttrs(runSpanAttributes(result.data));
		} else {
			setAttrs(runErrorSpanAttributes(result.error));
		}
		return result;
	});
}

async function analyzeCommandImpl(
	command: string,
	config: FailsafeConfig,
	store: FailsafeStore,
	opts: { timeoutMs?: number; shell?: boolean; noPolicy?: boolean } = {},
): Promise<CoreResult<Record<string, unknown>>> {
	// Policy check
	if (!opts.noPolicy) {
		const policy = loadPolicy(config);
		const validation = validateCommand(command, policy);
		if (!validation.allowed) {
			return {
				ok: false,
				error: {
					error: true,
					exit_code: ExitCode.POLICY_BLOCK,
					message: `Command blocked by policy: ${validation.reason}`,
					command,
				},
			};
		}
	}

	// Execution mode: argv-first unless shell explicitly requested
	let argv: string[] | undefined;
	if (opts.shell || opts.noPolicy) {
		argv = undefined;
	} else {
		const parsed = parseToArgv(command);
		if (parsed.kind === "needs_shell") {
			return {
				ok: false,
				error: {
					error: true,
					exit_code: ExitCode.ERROR,
					needs_shell: true,
					message: `${parsed.reason}. Use shell mode to allow shell syntax, or simplify the command.`,
					command,
				},
			};
		}
		argv = parsed.argv;
	}

	const result = await runCommand(command, { timeout_ms: opts.timeoutMs ?? 120_000, argv });

	const { redacted: redactedStdout, matched: stdoutMatches } = redactSecrets(result.stdout);
	const { redacted: redactedStderr, matched: stderrMatches } = redactSecrets(result.stderr);
	const { redacted: redactedCombined } = redactSecrets(result.combined);
	const allMatches = [...new Set([...stdoutMatches, ...stderrMatches])];

	const parsed = await withSpan("failsafe.parse", async (setAttrs) => {
		const p = detectAndParse(redactedStdout, redactedStderr, command);
		setAttrs(parseSpanAttributes(p));
		return p;
	});
	const primaryLocation = extractPrimaryLocation(parsed);
	const relatedLocations = extractRelatedLocations(parsed, primaryLocation);

	let status: FailureStatus = "failed";
	if (result.exit_code === 0) status = "passed";
	else if (result.timed_out) status = "timeout";

	const id = failureId();
	const rawBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);

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
	if (primaryLocation) output.primary_location = primaryLocation;
	// Surface mixed-language output: when more than one parser matched, list the
	// languages/parsers involved and the secondary locations so an agent sees
	// every failure source, not just the highest-precedence one.
	if (parsed.length > 1) {
		output.parsers = parsed.map((p) => ({
			parser: p.parser,
			failure_type: p.failure_type,
			error_count: p.errors.length,
		}));
		if (relatedLocations.length > 0) output.related_locations = relatedLocations;
	}
	if (parsed[0]?.test_summary) output.test_summary = parsed[0].test_summary;
	if (status !== "passed") {
		output.next = buildNextActions(id, parsed[0]?.failure_type, command, !!primaryLocation);
	}
	if (allMatches.length > 0) {
		output.redaction = { applied: true, patterns_matched: allMatches };
	}

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
		related_locations: relatedLocations,
		raw_artifacts: [],
		token_budget: tokenBudget,
	};

	const artifactPaths = store.saveRun(record, redactedStdout, redactedStderr, redactedCombined);

	if (config.token_budget.include_raw_paths !== false) {
		output.raw_paths = {
			stdout: artifactPaths.stdout_path,
			stderr: artifactPaths.stderr_path,
			combined: artifactPaths.combined_path,
		};
	}

	return { ok: true, data: output };
}

/** Diagnose a stored failure by id-or-"last". Returns the diagnosis packet. */
export async function diagnoseFailure(
	rawId: string,
	store: FailsafeStore,
	config: FailsafeConfig,
): Promise<CoreResult<FailureDiagnosis>> {
	return withSpan("failsafe.diagnose", async (setAttrs) => {
		const fid = resolveId(rawId, store);
		if (!fid) return notFound(rawId);
		const failure = store.getFailure(fid);
		if (!failure) return notFound(rawId);

		const diagnosis = await diagnose(failure, store, config);
		store.saveDiagnosis(diagnosis);
		setAttrs(diagnoseSpanAttributes(diagnosis));
		return { ok: true, data: diagnosis };
	});
}

/** Generate (or fetch) a minimal reproduction for a stored failure. */
export async function reproFailure(
	rawId: string,
	store: FailsafeStore,
	opts: { verify?: boolean; timeoutMs?: number } = {},
): Promise<CoreResult<Record<string, unknown>>> {
	return withSpan("failsafe.repro", async (setAttrs) => {
		const fid = resolveId(rawId, store);
		if (!fid) return notFound(rawId);
		const failure = store.getFailure(fid);
		if (!failure) return notFound(rawId);

		const repro = await generateRepro(failure, store, {
			verify: opts.verify ?? false,
			timeout_ms: opts.timeoutMs ?? 60_000,
			cwd: failure.cwd,
		});

		setAttrs(reproSpanAttributes(repro));
		return {
			ok: true,
			data: {
				failure_id: failure.failure_id,
				repro_id: repro.repro_id,
				status: repro.status,
				kind: repro.kind,
				command: repro.command,
				confidence: repro.confidence,
				reduction: repro.reduction,
				next: repro.next,
			},
		};
	});
}

/** Verify whether a fix resolves a stored failure by re-running commands. */
export async function verifyFailure(
	rawId: string,
	store: FailsafeStore,
	config: FailsafeConfig,
	opts: { timeoutMs?: number } = {},
): Promise<CoreResult<Record<string, unknown>>> {
	return withSpan("failsafe.verify", async (setAttrs) => {
		const result = await verifyFailureImpl(rawId, store, config, opts);
		if (result.ok) {
			setAttrs(verifySpanAttributes(result.data));
		} else {
			setAttrs(verifyErrorSpanAttributes(result.error));
		}
		return result;
	});
}

async function verifyFailureImpl(
	rawId: string,
	store: FailsafeStore,
	config: FailsafeConfig,
	opts: { timeoutMs?: number } = {},
): Promise<CoreResult<Record<string, unknown>>> {
	const fid = resolveId(rawId, store);
	if (!fid) return notFound(rawId);
	const failure = store.getFailure(fid);
	if (!failure) return notFound(rawId);

	const timeoutMs = opts.timeoutMs ?? 120_000;
	const repro = store.getRepro(fid);
	const policy = loadPolicy(config);
	const checks: Array<{
		kind: string;
		command: string;
		status: "passed" | "failed" | "blocked";
		duration_ms: number;
		message?: string;
	}> = [];

	if (repro && repro.status === "verified") {
		const v = validateCommand(repro.command, policy);
		if (!v.allowed) {
			checks.push({
				kind: "minimal_repro",
				command: repro.command,
				status: "blocked",
				duration_ms: 0,
				message: `Repro command blocked by policy: ${v.reason}`,
			});
		} else {
			const p = parseToArgv(repro.command);
			const res = await runCommand(repro.command, {
				cwd: failure.cwd,
				timeout_ms: timeoutMs,
				argv: p.kind === "argv" ? p.argv : undefined,
			});
			checks.push({
				kind: "minimal_repro",
				command: repro.command,
				status: res.exit_code === 0 ? "passed" : "failed",
				duration_ms: res.duration_ms,
				message: res.exit_code !== 0 ? "Minimal repro still fails after fix" : undefined,
			});
		}
	}

	const ov = validateCommand(failure.command, policy);
	if (!ov.allowed) {
		checks.push({
			kind: "original_command",
			command: failure.command,
			status: "blocked",
			duration_ms: 0,
			message: `Original command blocked by policy: ${ov.reason}`,
		});
	} else {
		const p = parseToArgv(failure.command);
		const res = await runCommand(failure.command, {
			cwd: failure.cwd,
			timeout_ms: timeoutMs,
			argv: p.kind === "argv" ? p.argv : undefined,
		});
		checks.push({
			kind: "original_command",
			command: failure.command,
			status: res.exit_code === 0 ? "passed" : "failed",
			duration_ms: res.duration_ms,
			message: res.exit_code !== 0 ? "Original command still fails" : undefined,
		});
	}

	const allPassed = checks.every((c) => c.status === "passed");
	const allErrors = failure.parsed.flatMap((p) => p.errors);
	const signature = computeSignature(allErrors, failure.primary_location);

	const data: Record<string, unknown> = {
		failure_id: fid,
		status: allPassed ? "passed" : "failed",
		checks,
	};
	if (allPassed) {
		data.resolution_candidate = {
			ready_to_store: true,
			signature: `${signature.exception_type ?? "?"}|${signature.top_frame_function ?? "?"}|${signature.top_frame_file ?? "?"}`,
		};
	}
	return { ok: true, data };
}

export type ExplainFixOption = {
	title: string;
	risk: string;
	files: string[];
	rationale: string;
};

/**
 * Combine a stored failure's diagnosis + repro evidence into a single compact
 * explanation packet — identical to `failsafe explain`. Pure (store reads only)
 * so the CLI and a future `failsafe_explain` MCP tool share one implementation.
 */
export function explainFailure(
	rawId: string,
	store: FailsafeStore,
): CoreResult<Record<string, unknown>> {
	const fid = resolveId(rawId, store);
	if (!fid) return notFound(rawId);
	const failure = store.getFailure(fid);
	if (!failure) return notFound(rawId);

	const diagnosis = store.getDiagnosis(fid);
	const repro = store.getRepro(fid);

	const evidence: string[] = [];
	const fixOptions: ExplainFixOption[] = [];

	// From diagnosis
	if (diagnosis) {
		for (const e of diagnosis.evidence) {
			evidence.push(`${e.location ? `${e.location}: ` : ""}${e.value}`);
		}
	}

	// From repro
	if (repro && repro.status === "verified") {
		evidence.push(`Minimal repro: ${repro.command}`);
	}

	const summary = diagnosis?.summary ?? failure.parsed[0]?.errors[0]?.message ?? "Unknown failure";

	// Suggest fix options based on diagnosis category
	if (diagnosis?.root_cause) {
		const cat = diagnosis.root_cause.category;
		if (cat === "null_reference" || cat === "key_error" || cat === "attribute_error") {
			fixOptions.push({
				title: "Add null/undefined guard",
				risk: "low",
				files: failure.primary_location ? [failure.primary_location.file] : [],
				rationale: "Prevent access to undefined values",
			});
			fixOptions.push({
				title: "Validate input before usage",
				risk: "low",
				files: failure.primary_location ? [failure.primary_location.file] : [],
				rationale: "Reject invalid data early",
			});
		} else if (cat === "import_error") {
			fixOptions.push({
				title: "Install missing dependency",
				risk: "low",
				files: ["package.json"],
				rationale: "Module needs to be installed",
			});
			fixOptions.push({
				title: "Fix import path",
				risk: "low",
				files: failure.primary_location ? [failure.primary_location.file] : [],
				rationale: "Import path may be incorrect",
			});
		} else if (cat === "assertion_mismatch") {
			fixOptions.push({
				title: "Fix the code to produce expected output",
				risk: "medium",
				files: failure.primary_location ? [failure.primary_location.file] : [],
				rationale: "Code behavior doesn't match test expectations",
			});
			fixOptions.push({
				title: "Update test expectations",
				risk: "medium",
				files: failure.parsed[0]?.errors[0]?.test_file
					? [failure.parsed[0].errors[0].test_file]
					: [],
				rationale: "Test expectations may be outdated",
			});
		}
	}

	const output: Record<string, unknown> = {
		failure_id: fid,
		summary,
		evidence,
	};

	if (fixOptions.length > 0) {
		output.fix_options = fixOptions;
		output.recommended_fix = fixOptions[0].title;
	}

	output.verify = { command: `failsafe verify ${fid}` };

	return { ok: true, data: output };
}

function resolveId(rawId: string, store: FailsafeStore): string | null {
	if (rawId === "--last" || rawId === "last") {
		return store.getFailure("last")?.failure_id ?? null;
	}
	return rawId;
}

function notFound(rawId: string): { ok: false; error: CoreError } {
	return {
		ok: false,
		error: {
			error: true,
			exit_code: ExitCode.NO_INPUT,
			message: rawId === "last" ? "No failure found in history" : `Failure not found: ${rawId}`,
		},
	};
}
