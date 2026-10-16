/**
 * OpenTelemetry GenAI/MCP semantic conventions for Failsafe's own MCP server
 * (item 11).
 *
 * Item 52 settled how Failsafe's core *operations* emit under the GenAI
 * schema. Item 57 settled how an *incoming* trace from somewhere else gets
 * normalized. Neither covers the thing Failsafe itself is from an MCP
 * client's point of view: a `tools/call` server (`src/mcp/server.ts`), which
 * has its own semantic-convention surface
 * (https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md)
 * that nothing in this codebase validates or declares conformance to.
 *
 * Three constraints the conventions impose that this module exists to keep
 * truthful rather than merely plausible-looking:
 *
 * 1. **Only the operations Failsafe actually registers get MCP attributes.**
 *    `FAILSAFE_MCP_TOOL_NAMES` is the one place that lists them (mirrored by
 *    `tests/mcp/server.test.ts`'s "exposes all failsafe tools" list, which is
 *    the ground truth for what the live server registers). A span attributed
 *    to a tool name outside that catalog does not get `gen_ai.tool.name` or
 *    `mcp.method.name` fabricated for it — it gets a named
 *    `failsafe.mcp.unowned_operation` fact instead, which is the "mark
 *    unsupported fields" half of this item.
 *
 * 2. **Only what the stdio transport can actually report is reported.** The
 *    conventions' MCP server span is transport-agnostic (it documents HTTP
 *    examples with `client.address`, `server.port`, `mcp.protocol.version`,
 *    `network.protocol.name/version`), but `src/mcp/server.ts` only ever
 *    connects over `StdioServerTransport`, which exposes none of an HTTP
 *    peer's address/port, the SDK's own `Server` class discards the
 *    negotiated `protocolVersion` after replying to `initialize` (there is no
 *    getter for it — confirmed by enumerating the live `Server` instance's own
 *    properties, which carries `_clientVersion`/`_clientCapabilities` but no
 *    `_protocolVersion`), and `jsonrpc.protocol.version` is only
 *    "Recommended when it's not `2.0`" (this SDK is always `2.0`). Every one
 *    of these is listed in `MCP_LOSSY_FIELDS` with the specific reason it
 *    cannot be populated here, rather than silently omitted or guessed.
 *
 * 3. **`mcp.session.id` is content, not metadata.** It is an unbounded,
 *    caller/transport-supplied identifier — exactly the same shape of risk as
 *    `gen_ai.conversation.id` (item 52's own module header makes the same
 *    call) — so it must earn `redacted-content` like any other identifier,
 *    not ride through on the metadata allowlist by virtue of a `mcp.*` prefix
 *    looking authoritative.
 *
 * Pure: builds attribute objects and a loss report. Carries no implicit
 * network/transport conformance claim either — `MCP_NETWORK_TRANSPORT` is a
 * frozen constant ("pipe") precisely because `src/mcp/server.ts` has exactly
 * one transport today, not a selector between several.
 */
import { genAiSpanAttributes } from "./genai-schema.js";
import type { SpanAttributes } from "./otel.js";

/** The one JSON-RPC method Failsafe's MCP server actually serves: tool calls. */
export const MCP_METHOD_NAME = "tools/call";

/**
 * Transport Failsafe's MCP server runs over.
 *
 * Per the conventions' "Recording MCP transport" table, `network.transport`
 * MUST be `pipe` for stdio. `src/mcp/server.ts` connects exactly one
 * transport (`StdioServerTransport`) at `import.meta.main`, so this is a
 * fact about the shipped server, not a configurable default.
 */
export const MCP_NETWORK_TRANSPORT = "pipe";

/**
 * Tool names Failsafe's MCP server actually registers via `server.tool(...)`
 * in `src/mcp/server.ts`.
 *
 * This list is the "owned operations" catalog: deliberately duplicated by
 * hand into `tests/mcp/server.test.ts`'s own "exposes all failsafe tools"
 * assertion (rather than imported from there) so that adding a tool to one
 * list without the other is a failing test, not a silent gap.
 */
export const FAILSAFE_MCP_TOOL_NAMES = [
	"failsafe_analyze",
	"failsafe_apply",
	"failsafe_debug",
	"failsafe_diagnose",
	"failsafe_explain",
	"failsafe_history",
	"failsafe_inspect",
	"failsafe_repro",
	"failsafe_step",
	"failsafe_verify",
] as const;

export type FailsafeMcpToolName = (typeof FAILSAFE_MCP_TOOL_NAMES)[number];

const OWNED_TOOL_SET: ReadonlySet<string> = new Set(FAILSAFE_MCP_TOOL_NAMES);

export type OwnedOperationCheck =
	| { owned: true; toolName: FailsafeMcpToolName }
	| { owned: false; toolName: string; reason: string };

/**
 * Validate that an operation name is actually one of Failsafe's registered
 * MCP tools, rather than assuming every string handed to a span builder is.
 */
export function checkOwnedMcpOperation(toolName: string): OwnedOperationCheck {
	if (OWNED_TOOL_SET.has(toolName)) {
		return { owned: true, toolName: toolName as FailsafeMcpToolName };
	}
	return {
		owned: false,
		toolName,
		reason: `'${toolName}' is not a tool this MCP server registers; it is not in FAILSAFE_MCP_TOOL_NAMES`,
	};
}

/**
 * Span name per the conventions: `{mcp.method.name} {target}`, where target
 * matches `gen_ai.tool.name` for a tool call.
 */
export function mcpSpanName(toolName: string): string {
	return `${MCP_METHOD_NAME} ${toolName}`;
}

export type McpSpanInput = {
	toolName: string;
	/** Transport-level session id, when the transport in use has one. */
	sessionId?: string;
	/** Whether the `CallToolResult` carried `isError: true`. */
	isToolError: boolean;
};

/**
 * Build the attributes for one `tools/call` server span.
 *
 * Owned operations get the conventions' required (`mcp.method.name`) and
 * recommended (`gen_ai.operation.name`, `gen_ai.tool.name`,
 * `network.transport`, `mcp.session.id` when present) attributes.
 * `error.type` is populated only for a tool-level error, per the conventions'
 * guidance that a successful JSON-RPC response carrying `isError: true`
 * SHOULD report `error.type: "tool_error"` (this module never emits a
 * JSON-RPC-level `error.type`/`rpc.response.status_code` pair, because
 * `src/mcp/server.ts`'s tool handlers never throw a JSON-RPC error — every
 * failure path returns a well-formed `CallToolResult` with `isError: true`
 * instead, confirmed by reading every `server.tool(...)` handler in that
 * file).
 *
 * An unowned operation gets none of the GenAI/MCP enum attributes (rule 1 in
 * the module header: never fabricate `gen_ai.tool.name` for a tool that is
 * not actually Failsafe's), and instead carries
 * `failsafe.mcp.unowned_operation` naming exactly what was unrecognized.
 */
export function mcpSpanAttributes(input: McpSpanInput): SpanAttributes {
	const check = checkOwnedMcpOperation(input.toolName);
	if (!check.owned) {
		return { "failsafe.mcp.unowned_operation": check.toolName };
	}
	return {
		"mcp.method.name": MCP_METHOD_NAME,
		// gen_ai.* attributes are built by genai-schema.ts's own single-writer
		// builder, not hand-rolled here — item 52/57's genai-schema.test.ts
		// asserts "gen_ai.*": is only ever hard-coded in genai-schema.ts.
		...genAiSpanAttributes({ kind: "tool", target: check.toolName }),
		"network.transport": MCP_NETWORK_TRANSPORT,
		"mcp.session.id": input.sessionId,
		"error.type": input.isToolError ? "tool_error" : undefined,
	};
}

export type McpLossyField = {
	key: string;
	reason: string;
};

/**
 * Fields the conventions define for an MCP span that this server cannot
 * populate with a real value, and the specific reason — never silently
 * omitted, never guessed.
 */
export const MCP_LOSSY_FIELDS: readonly McpLossyField[] = [
	{
		key: "mcp.protocol.version",
		reason:
			"the SDK's Server class negotiates and replies with a protocolVersion inside _oninitialize " +
			"but never stores it on an instance field or exposes a getter for it afterward (confirmed by " +
			"enumerating a live Server instance's own properties: it keeps _clientVersion and " +
			"_clientCapabilities but no _protocolVersion), so there is no supported way for this server to " +
			"read back what was negotiated once initialize has returned.",
	},
	{
		key: "jsonrpc.protocol.version",
		reason:
			"Recommended only 'when it's not 2.0'; this SDK's JSON-RPC layer is always 2.0, so the " +
			"conventions' own requirement level says this attribute should not be emitted here.",
	},
	{
		key: "client.address",
		reason:
			"src/mcp/server.ts connects only StdioServerTransport, which has no network peer; there is no " +
			"client address to observe over a stdio pipe.",
	},
	{
		key: "client.port",
		reason:
			"same as client.address: no network peer exists over stdio, so there is no port to observe.",
	},
	{
		key: "server.address",
		reason: "same as client.address, from the other side: a stdio server has no listening address.",
	},
	{
		key: "server.port",
		reason: "same as server.address: a stdio server has no listening port.",
	},
	{
		key: "network.protocol.name",
		reason:
			"Recommended 'when applicable'; it describes an OSI application-layer protocol (http, " +
			"websocket), which does not apply to a stdio pipe.",
	},
	{
		key: "network.protocol.version",
		reason: "same as network.protocol.name: not applicable to a stdio pipe.",
	},
	{
		key: "mcp.resource.uri",
		reason:
			"only applies to resources/read, resources/subscribe, resources/unsubscribe, or " +
			"notifications/resources/updated; this module models tools/call spans only (item 11's scope is " +
			"the owned tool-call operation, not the resource/prompt surface this server also exposes).",
	},
];

/**
 * Render `MCP_LOSSY_FIELDS` as one human-readable line per field, each naming
 * the field and its reason, so the gap is a visible report rather than
 * knowledge locked inside a comment.
 */
export function mcpConventionsLossReport(): string[] {
	return MCP_LOSSY_FIELDS.map((entry) => `${entry.key}: ${entry.reason}`);
}
