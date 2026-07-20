#!/usr/bin/env bun
/**
 * Failsafe MCP server.
 *
 * Exposes Failsafe's core operations as Model Context Protocol tools so flow
 * orchestrators (AgentFlow, Statewright, etc.) can call them as validation
 * checkpoints. Each tool returns the SAME JSON contract as the equivalent CLI
 * command — the implementations are shared via src/core/operations.ts.
 *
 * Beyond tools, the server also exposes:
 *   - Resources: a stored failure's diagnosis (`failsafe://diagnosis/{id}`,
 *     diagnosed on demand) and its captured run log (`failsafe://log/{id}`),
 *     so orchestrators can pull context without issuing a tool call.
 *   - A prompt: a guided "diagnose then fix" workflow seeded with the current
 *     diagnosis packet.
 *
 * Transport: stdio. Run with `failsafe-mcp` or `bun src/mcp/server.ts`.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ExitCode } from "../cli/exit-codes.js";
import { createStore, loadConfig } from "../cli/shared.js";
import {
	analyzeCommand,
	applyFixById,
	diagnoseFailure,
	explainFailure,
	reproFailure,
	verifyFailure,
} from "../core/operations.js";

/** Serialize a core result to an MCP tool response (text content with JSON). */
function toToolResponse(result: { ok: true; data: unknown } | { ok: false; error: unknown }) {
	const payload = result.ok ? result.data : result.error;
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		isError: !result.ok,
	};
}

export function createFailsafeMcpServer(): McpServer {
	const server = new McpServer({
		name: "failsafe",
		version: "0.1.0",
	});

	server.tool(
		"failsafe_analyze",
		"Run a command, capture and parse its failure, and return a compact diagnosis-ready packet. Optionally chain a full diagnosis. Same contract as `failsafe run` (+ `failsafe diagnose` when diagnose=true).",
		{
			command: z.string().describe("The command to run (e.g. 'pytest tests/')"),
			diagnose: z
				.boolean()
				.optional()
				.describe("Also run a full root-cause diagnosis on the captured failure"),
			timeout_seconds: z.number().optional().describe("Command timeout in seconds (default 120)"),
			shell: z.boolean().optional().describe("Allow shell syntax via 'sh -c'"),
		},
		async ({ command, diagnose, timeout_seconds, shell }) => {
			const config = loadConfig();
			const store = createStore(config);
			try {
				const run = await analyzeCommand(command, config, store, {
					timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
					shell,
				});
				if (!run.ok) return toToolResponse(run);

				if (diagnose) {
					const failureId = (run.data as { failure_id: string }).failure_id;
					const diag = await diagnoseFailure(failureId, store, config);
					if (diag.ok) {
						return toToolResponse({ ok: true, data: { run: run.data, diagnosis: diag.data } });
					}
				}
				return toToolResponse(run);
			} finally {
				store.close();
			}
		},
	);

	server.tool(
		"failsafe_diagnose",
		"Build a structured root-cause hypothesis for a stored failure. Same contract as `failsafe diagnose`.",
		{
			failure_id: z.string().describe("Failure id, or 'last' for the most recent failure"),
		},
		async ({ failure_id }) => {
			const config = loadConfig();
			const store = createStore(config);
			try {
				return toToolResponse(await diagnoseFailure(failure_id, store, config));
			} finally {
				store.close();
			}
		},
	);

	server.tool(
		"failsafe_repro",
		"Extract a minimal reproduction (single test selector) for a stored failure. Same contract as `failsafe repro`.",
		{
			failure_id: z.string().describe("Failure id, or 'last' for the most recent failure"),
			verify: z.boolean().optional().describe("Re-run the candidate to verify it reproduces"),
			timeout_seconds: z.number().optional().describe("Verification timeout in seconds"),
		},
		async ({ failure_id, verify, timeout_seconds }) => {
			const config = loadConfig();
			const store = createStore(config);
			try {
				return toToolResponse(
					await reproFailure(failure_id, store, {
						verify,
						timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
					}),
				);
			} finally {
				store.close();
			}
		},
	);

	server.tool(
		"failsafe_verify",
		"Re-run the repro and original command to confirm a fix resolves a stored failure. Same contract as `failsafe verify`.",
		{
			failure_id: z.string().describe("Failure id, or 'last' for the most recent failure"),
			timeout_seconds: z.number().optional().describe("Command timeout in seconds"),
		},
		async ({ failure_id, timeout_seconds }) => {
			const config = loadConfig();
			const store = createStore(config);
			try {
				return toToolResponse(
					await verifyFailure(failure_id, store, config, {
						timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
					}),
				);
			} finally {
				store.close();
			}
		},
	);

	server.tool(
		"failsafe_explain",
		"Combine a stored failure's diagnosis and repro evidence into one compact explanation packet (summary, evidence, ranked fix_options, recommended_fix). Same contract as `failsafe explain`.",
		{
			failure_id: z.string().describe("Failure id, or 'last' for the most recent failure"),
		},
		async ({ failure_id }) => {
			const config = loadConfig();
			const store = createStore(config);
			try {
				return toToolResponse(explainFailure(failure_id, store));
			} finally {
				store.close();
			}
		},
	);

	server.tool(
		"failsafe_apply",
		"Apply a declared rule's suggested fix patch for a stored failure via `git apply` (argv-first, no shell). Validate-only DRY RUN by default; pass confirm=true to write. Same contract as `failsafe apply`.",
		{
			failure_id: z.string().describe("Failure id, or 'last' for the most recent failure"),
			confirm: z
				.boolean()
				.optional()
				.describe("Apply the patch to the working tree (default: validate-only dry run)"),
		},
		async ({ failure_id, confirm }) => {
			const config = loadConfig();
			const store = createStore(config);
			try {
				const result = await applyFixById(failure_id, store, config, { confirm });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
					isError: result.exit_code !== ExitCode.OK,
				};
			} finally {
				store.close();
			}
		},
	);

	// ─── Resources ──────────────────────────────────────────────────────────
	// Orchestrators can read a failure's diagnosis or raw log by URI instead of
	// issuing a tool call. Both list the most recent failures for discovery.
	const RECENT_LIMIT = 20;

	server.registerResource(
		"failsafe_diagnosis",
		new ResourceTemplate("failsafe://diagnosis/{failure_id}", {
			list: () => {
				const config = loadConfig();
				const store = createStore(config);
				try {
					return {
						resources: store.listFailures({ limit: RECENT_LIMIT }).map((f) => ({
							uri: `failsafe://diagnosis/${f.failure_id}`,
							name: `Diagnosis: ${f.command}`,
							description: `Root-cause packet for ${f.failure_id} (${f.status})`,
							mimeType: "application/json",
						})),
					};
				} finally {
					store.close();
				}
			},
		}),
		{
			title: "Failure diagnosis",
			description:
				"Structured root-cause packet for a stored failure as JSON, diagnosed on demand if not already computed. Same contract as `failsafe diagnose`.",
			mimeType: "application/json",
		},
		async (uri, variables) => {
			const failureId = String(variables.failure_id);
			const config = loadConfig();
			const store = createStore(config);
			try {
				const result = await diagnoseFailure(failureId, store, config);
				const payload = result.ok ? result.data : result.error;
				return {
					contents: [
						{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) },
					],
				};
			} finally {
				store.close();
			}
		},
	);

	server.registerResource(
		"failsafe_run_log",
		new ResourceTemplate("failsafe://log/{failure_id}", {
			list: () => {
				const config = loadConfig();
				const store = createStore(config);
				try {
					return {
						resources: store.listFailures({ limit: RECENT_LIMIT }).map((f) => ({
							uri: `failsafe://log/${f.failure_id}`,
							name: `Log: ${f.command}`,
							description: `Captured stdout/stderr for ${f.failure_id} (${f.status})`,
							mimeType: "text/plain",
						})),
					};
				} finally {
					store.close();
				}
			},
		}),
		{
			title: "Run log",
			description:
				"Captured (secret-redacted) stdout and stderr for a stored failure as plain text.",
			mimeType: "text/plain",
		},
		async (uri, variables) => {
			const failureId = String(variables.failure_id);
			const config = loadConfig();
			const store = createStore(config);
			try {
				const failure = store.getFailure(failureId);
				if (!failure) {
					return {
						contents: [
							{ uri: uri.href, mimeType: "text/plain", text: `Failure not found: ${failureId}` },
						],
					};
				}
				const stdout = store.getRawOutput(failure.failure_id, "stdout") ?? "";
				const stderr = store.getRawOutput(failure.failure_id, "stderr") ?? "";
				const parts: string[] = [];
				if (stdout) parts.push(`--- stdout ---\n${stdout}`);
				if (stderr) parts.push(`--- stderr ---\n${stderr}`);
				const text = parts.join("\n") || "(no captured output)";
				return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
			} finally {
				store.close();
			}
		},
	);

	// ─── Prompts ────────────────────────────────────────────────────────────
	// A guided fix loop seeded with the current diagnosis so an agent has the
	// root-cause context inline before it starts editing.
	server.registerPrompt(
		"failsafe_diagnose_and_fix",
		{
			title: "Diagnose then fix",
			description:
				"Guided workflow: diagnose a stored failure, apply a minimal fix, and verify it. Embeds the current diagnosis packet as context.",
			argsSchema: {
				failure_id: z.string().describe("Failure id, or 'last' for the most recent failure"),
			},
		},
		async ({ failure_id }) => {
			const config = loadConfig();
			const store = createStore(config);
			try {
				const result = await diagnoseFailure(failure_id, store, config);
				const context = result.ok
					? JSON.stringify(result.data, null, 2)
					: `No diagnosis available: ${(result.error as { message?: string }).message ?? "unknown failure"}`;
				return {
					messages: [
						{
							role: "user",
							content: {
								type: "text",
								text: [
									`You are fixing a failing command captured by Failsafe (failure ${failure_id}).`,
									"",
									"Diagnosis packet:",
									context,
									"",
									"Follow this loop:",
									"1. Read root_cause and minimal_context to locate the defect.",
									"2. Apply the smallest change that addresses the root cause.",
									`3. Confirm with the failsafe_verify tool on failure_id "${failure_id}".`,
									"4. If verify still fails, refine the fix and repeat. Do not broaden scope beyond the root cause.",
								].join("\n"),
							},
						},
					],
				};
			} finally {
				store.close();
			}
		},
	);

	return server;
}

// Start the server over stdio when run directly.
if (import.meta.main) {
	const server = createFailsafeMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
