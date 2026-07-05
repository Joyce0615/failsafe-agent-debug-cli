/**
 * `failsafe ci "<command>"` — a thin CI wrapper that runs a command through
 * Failsafe and emits its compact diagnosis as GitHub Actions check annotations
 * (workflow commands), mapping the standardized exit codes to a pass/fail job
 * result. Backs the reusable composite action in `ci/action.yml`.
 *
 * A *captured* command failure (e.g. `npm test` exits non-zero) is a SUCCESSFUL
 * Failsafe run, so — unlike the rest of the CLI — this wrapper deliberately
 * fails the CI job (exit ERROR) on a failed/timeout capture and renders an
 * annotation from the diagnosis `primary_location`. The testable `runCiCheck`
 * core is pure of process.exit/console; the CLI wrapper prints + exits.
 */
import { isAbsolute, relative } from "node:path";
import type { Command } from "commander";
import { analyzeCommand, diagnoseFailure } from "../core/operations.js";
import type { FailsafeStore } from "../storage/store.js";
import type { FailsafeConfig } from "../types/config.js";
import type { Severity } from "../types/diagnosis.js";
import { ExitCode } from "./exit-codes.js";
import { createStore, loadConfig } from "./shared.js";

/** A single GitHub Actions check annotation (rendered as a workflow command). */
export type CiAnnotation = {
	level: "error" | "warning" | "notice";
	file?: string;
	line?: number;
	col?: number;
	title?: string;
	message: string;
};

export type CiResult = {
	exit_code: number;
	status: "passed" | "failed" | "error";
	annotations: CiAnnotation[];
	data: Record<string, unknown>;
};

/** Map a diagnosis severity to a GitHub annotation level. */
function severityToLevel(severity: Severity): CiAnnotation["level"] {
	if (severity === "blocker" || severity === "error") return "error";
	// "warning" and "flaky" are non-blocking signals in CI.
	return "warning";
}

/** Make an absolute path repo-relative for annotation rendering, if possible. */
function relativizePath(file: string, base: string): string {
	if (!isAbsolute(file)) return file;
	const rel = relative(base, file);
	// Don't emit paths that escape the workspace (../...) — leave them absolute.
	return rel && !rel.startsWith("..") ? rel : file;
}

/** Escape a workflow-command *property* value (file/title/line/col). */
function escapeProperty(value: string): string {
	return value
		.replace(/%/g, "%25")
		.replace(/\r/g, "%0D")
		.replace(/\n/g, "%0A")
		.replace(/:/g, "%3A")
		.replace(/,/g, "%2C");
}

/** Escape a workflow-command message body. */
function escapeData(value: string): string {
	return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Render an annotation as a GitHub Actions workflow command, e.g.
 * `::error file=src/x.ts,line=12,col=3,title=failsafe: type_error::message`.
 */
export function renderAnnotation(a: CiAnnotation): string {
	const props: string[] = [];
	if (a.file) props.push(`file=${escapeProperty(a.file)}`);
	if (a.line !== undefined) props.push(`line=${a.line}`);
	if (a.col !== undefined) props.push(`col=${a.col}`);
	if (a.title) props.push(`title=${escapeProperty(a.title)}`);
	const head = props.length > 0 ? `${a.level} ${props.join(",")}` : a.level;
	return `::${head}::${escapeData(a.message)}`;
}

/**
 * Run a command through Failsafe and produce a CI-shaped result: a pass/fail
 * exit code plus the annotations to render. On a captured failure it diagnoses
 * the run and builds one annotation from the diagnosis + primary location.
 */
export async function runCiCheck(
	command: string,
	config: FailsafeConfig,
	store: FailsafeStore,
	opts: { timeoutMs?: number; shell?: boolean; noPolicy?: boolean; relativeTo?: string } = {},
): Promise<CiResult> {
	const run = await analyzeCommand(command, config, store, {
		timeoutMs: opts.timeoutMs,
		shell: opts.shell,
		noPolicy: opts.noPolicy,
	});

	// A policy block / needs-shell rejection is a setup error, not a code defect.
	if (!run.ok) {
		return {
			exit_code: run.error.exit_code,
			status: "error",
			annotations: [{ level: "error", title: "failsafe", message: run.error.message }],
			data: { ...run.error, command },
		};
	}

	const data = run.data;
	const status = String(data.status);
	const failureId = data.failure_id as string;

	if (status === "passed") {
		return {
			exit_code: ExitCode.OK,
			status: "passed",
			annotations: [],
			data: { failure_id: failureId, status, command },
		};
	}

	const base = opts.relativeTo ?? process.cwd();
	const loc = data.primary_location as
		| { file?: string; line?: number; column?: number }
		| undefined;

	const diag = await diagnoseFailure(failureId, store, config);
	const annotation: CiAnnotation = {
		level: "error",
		message: String(data.summary ?? "Command failed"),
		title: "failsafe",
	};
	const out: Record<string, unknown> = { failure_id: failureId, status, command };

	if (diag.ok) {
		const d = diag.data;
		annotation.level = severityToLevel(d.severity);
		annotation.title = d.root_cause?.category ? `failsafe: ${d.root_cause.category}` : "failsafe";
		annotation.message = d.summary ?? annotation.message;
		out.severity = d.severity;
		out.category = d.root_cause?.category;
		out.summary = d.summary;
	}
	if (loc?.file) {
		annotation.file = relativizePath(loc.file, base);
		annotation.line = loc.line;
		annotation.col = loc.column;
		out.primary_location = data.primary_location;
	}

	return {
		exit_code: ExitCode.ERROR,
		status: "failed",
		annotations: [annotation],
		data: out,
	};
}

export function registerCiCommand(program: Command): void {
	program
		.command("ci <command>")
		.description("Run a command through Failsafe and emit GitHub Actions check annotations")
		.option("--timeout <seconds>", "Command timeout in seconds", "300")
		.option("--relative-to <dir>", "Base directory for repo-relative annotation paths")
		.option("--shell", "Run via 'sh -c' to allow shell syntax (operators, globs, pipes)")
		.option("--no-policy", "Skip command safety policy check")
		.action(async (command: string, opts) => {
			const config = loadConfig();
			const store = createStore(config);

			const result = await runCiCheck(command, config, store, {
				timeoutMs: Number.parseInt(opts.timeout, 10) * 1000,
				shell: opts.shell,
				noPolicy: opts.policy === false,
				relativeTo: opts.relativeTo,
			});

			// Render annotations as workflow commands (GitHub parses these from logs).
			for (const annotation of result.annotations) {
				console.log(renderAnnotation(annotation));
			}
			// Emit the compact packet too, so a human reading the log sees the detail.
			console.log(JSON.stringify(result.data));

			store.close();
			if (result.exit_code !== ExitCode.OK) process.exit(result.exit_code);
		});
}
