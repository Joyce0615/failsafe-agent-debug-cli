import type { Command } from "commander";
import { DebugController } from "../debug/controller.js";
import { type OutputOptions, outputResult, resolveOutputOptions } from "./format.js";
import { createStore, loadConfig } from "./shared.js";

function handleDebugError(err: unknown, sessionId: string, outOpts: OutputOptions): void {
	const message = err instanceof Error ? err.message : String(err);
	const isNoSession = message.includes("No active debug session");

	outputResult(
		{
			error: true,
			debug_unavailable: isNoSession,
			message: isNoSession
				? `No active debug session: ${sessionId}. Debug sessions are in-memory and do not persist across CLI invocations. Use 'failsafe debug <id>' to start a new session.`
				: `Inspect failed: ${message}`,
			next: isNoSession
				? [{ command: "failsafe diagnose last", reason: "Get diagnosis without debug stepping" }]
				: undefined,
		},
		outOpts,
	);
	process.exit(1);
}

export function registerInspectCommand(program: Command): void {
	const inspectCmd = program
		.command("inspect")
		.description(
			"[experimental] Inspect variables, expressions, stack, or source in a debug session",
		);

	inspectCmd
		.command("vars")
		.description("Inspect local variables")
		.requiredOption("--session <id>", "Debug session ID")
		.option("--format <format>", "Output format: json or text")
		.option("--changed", "Show only changed variables")
		.option("--scope <name>", "Filter by scope name")
		.action(async (opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const outOpts = resolveOutputOptions(opts);
			const controller = new DebugController(store);

			try {
				const vars = await controller.getVariables(opts.session, {
					changed: opts.changed,
					scope: opts.scope,
				});

				outputResult(
					{
						debug_session_id: opts.session,
						kind: "variables",
						variables: vars,
						count: vars.length,
					},
					outOpts,
					() => {
						if (vars.length === 0) return "No variables in scope.";
						return vars
							.map((v) => `  ${v.name}: ${v.type ? `(${v.type}) ` : ""}${v.value}`)
							.join("\n");
					},
				);
			} catch (err) {
				handleDebugError(err, opts.session, outOpts);
			}
		});

	inspectCmd
		.command("stack")
		.description("Inspect call stack")
		.requiredOption("--session <id>", "Debug session ID")
		.option("--format <format>", "Output format: json or text")
		.action(async (opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const outOpts = resolveOutputOptions(opts);
			const controller = new DebugController(store);

			try {
				const frames = await controller.getStack(opts.session);

				outputResult(
					{
						debug_session_id: opts.session,
						kind: "stack",
						frames: frames.map((f) => ({
							name: f.name,
							file: f.source?.path,
							line: f.line,
							column: f.column,
						})),
					},
					outOpts,
					() =>
						frames
							.map((f, i) => `  #${i} ${f.name} at ${f.source?.path ?? "?"}:${f.line}`)
							.join("\n"),
				);
			} catch (err) {
				handleDebugError(err, opts.session, outOpts);
			}
		});

	inspectCmd
		.command("expr <expression>")
		.description("Evaluate an expression")
		.requiredOption("--session <id>", "Debug session ID")
		.option("--format <format>", "Output format: json or text")
		.action(async (expression: string, opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const outOpts = resolveOutputOptions(opts);
			const controller = new DebugController(store);

			try {
				const result = await controller.evaluate(opts.session, expression);

				outputResult(
					{
						debug_session_id: opts.session,
						kind: "expression",
						expression,
						value: result.value,
						type: result.type,
						summary: result.summary,
					},
					outOpts,
					() => {
						let line = `${expression} = ${result.value}`;
						if (result.type) line = `(${result.type}) ${line}`;
						return line;
					},
				);
			} catch (err) {
				handleDebugError(err, opts.session, outOpts);
			}
		});

	inspectCmd
		.command("source")
		.description("Inspect source code around current location")
		.requiredOption("--session <id>", "Debug session ID")
		.option("--format <format>", "Output format: json or text")
		.action(async (opts) => {
			const config = loadConfig();
			const store = createStore(config);
			const outOpts = resolveOutputOptions(opts);
			const controller = new DebugController(store);

			try {
				const slice = await controller.inspectSource(opts.session);
				if (!slice) {
					outputResult({ error: true, message: "No source context available" }, outOpts);
					process.exit(1);
				}

				outputResult(
					{
						debug_session_id: opts.session,
						kind: "source",
						file: slice.file,
						start_line: slice.start_line,
						end_line: slice.end_line,
						text: slice.text,
					},
					outOpts,
					() => `${slice.file}:${slice.start_line}-${slice.end_line}\n${slice.text}`,
				);
			} catch (err) {
				handleDebugError(err, opts.session, outOpts);
			}
		});
}
