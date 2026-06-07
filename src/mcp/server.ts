#!/usr/bin/env bun
/**
 * Failsafe MCP server.
 *
 * Exposes Failsafe's core operations as Model Context Protocol tools so flow
 * orchestrators (AgentFlow, Statewright, etc.) can call them as validation
 * checkpoints. Each tool returns the SAME JSON contract as the equivalent CLI
 * command — the implementations are shared via src/core/operations.ts.
 *
 * Transport: stdio. Run with `failsafe-mcp` or `bun src/mcp/server.ts`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createStore, loadConfig } from "../cli/shared.js";
import {
	analyzeCommand,
	diagnoseFailure,
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

	return server;
}

// Start the server over stdio when run directly.
if (import.meta.main) {
	const server = createFailsafeMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
