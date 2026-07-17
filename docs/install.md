# Installing Failsafe

Failsafe ships two binaries — the `failsafe` CLI and the `failsafe-mcp` MCP
server — and a ready-to-use agent skill. This page covers all three install
paths. Requires [Bun](https://bun.sh) v1.0+.

## 1. As a CLI

From a checkout:

```bash
bun install                 # install dependencies
bun run build               # bundle dist/index.js + dist/server.js
bun link                    # expose `failsafe` / `failsafe-mcp` on PATH
```

Or run directly without linking:

```bash
bun src/cli/index.ts run "pytest -x"
```

Initialize per-project storage once:

```bash
failsafe init               # creates .failsafe/
```

## 2. As an MCP server

`failsafe-mcp` speaks MCP over stdio and exposes `failsafe_analyze`,
`failsafe_diagnose`, `failsafe_repro`, and `failsafe_verify` (plus two resources
and a prompt), each returning the same JSON contract as the equivalent CLI
command. Register it with any MCP client:

```jsonc
{
  "mcpServers": {
    "failsafe": { "command": "failsafe-mcp" }
  }
}
```

From a checkout (no global install), point the client at the repo entrypoint:

```jsonc
{
  "mcpServers": {
    "failsafe": { "command": "bun", "args": ["run", "mcp"], "cwd": "/path/to/failsafe" }
  }
}
```

The CLI and MCP server share a single implementation (`src/core/operations.ts`),
so their output contracts never diverge.

## 3. As an agent skill

A Claude Code skill is bundled at [`skills/failsafe/SKILL.md`](../skills/failsafe/SKILL.md).
It teaches an agent the `run → diagnose → repro → verify → resolve` loop and
gates the tools it may call. Install it by copying the skill directory:

```bash
# user-level (all projects)
cp -r skills/failsafe ~/.claude/skills/failsafe

# or project-level
cp -r skills/failsafe .claude/skills/failsafe
```

The agent then invokes Failsafe automatically whenever a command fails instead
of reading raw logs. See [`skills/failsafe/SKILL.md`](../skills/failsafe/SKILL.md)
for the full command reference and when-to-use guidance.
