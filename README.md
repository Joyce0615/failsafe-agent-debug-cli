# Failsafe

Agent-first debugging CLI. Compresses noisy failure output into compact structured JSON packets so coding agents spend fewer tokens on debugging loops.

```
failure -> compact diagnosis -> minimal repro -> verify
```

## Install

```bash
bun install
```

Requires [Bun](https://bun.sh) v1.0+.

## Quick Start

```bash
# Initialize storage
failsafe init

# Run a command and capture the failure
failsafe run "pytest tests/"

# Get a structured diagnosis
failsafe diagnose last

# Create a minimal reproduction
failsafe repro last

# Verify after fixing
failsafe verify last

# Record the fix for the knowledge base
failsafe resolve last --success --fix-summary "Added null check"
```

All commands output JSON by default. Use `--format text` for human-readable output. Use `--max-bytes` to cap output size.

## Commands

### Core

| Command | Description |
|---------|-------------|
| `failsafe run <cmd>` | Execute a command, capture output, return compact failure packet |
| `failsafe diagnose <id\|last>` | Root-cause hypothesis with evidence and confidence |
| `failsafe repro <id\|last>` | Extract a minimal reproduction (single test selector) |
| `failsafe verify <id>` | Re-run repro and original command to confirm fix |
| `failsafe explain <id>` | Combine all evidence into a compact explanation |
| `failsafe init` | Initialize `.failsafe/` storage directory |
| `failsafe config show\|set` | View or modify configuration |
| `failsafe doctor` | Check system dependencies |
| `failsafe history` | List past failures, find similar ones with `--similar <id>` |

### Debug (experimental)

`failsafe debug <id>` emits **launch guidance** — a ready-to-run `debugpy` command and breakpoint location for an interactive debugger you attach from your editor/IDE. It does not manage a live session. Currently only **Python** (debugpy) has a working adapter; Node.js DAP support is planned (`@vscode/js-debug`).

| Command | Description |
|---------|-------------|
| `failsafe debug <id>` | Emit a `debugpy` launch command + breakpoint for interactive debugging |
| `failsafe step --session <id>` | (experimental) In-process stepping; does not persist across invocations |
| `failsafe inspect vars\|stack\|expr\|source` | (experimental) In-process inspection; does not persist across invocations |

Debug sessions are in-memory within a single process, so `step` and `inspect` cannot reconnect from a separate CLI invocation — they return a structured `debug_unavailable` packet. For unsupported runtimes (Node.js, Go, Rust, Java, .NET), `failsafe debug` returns a structured packet naming the needed adapter and fallback commands (`diagnose`, `repro`).

### Tiered Rules

| Command | Description |
|---------|-------------|
| `failsafe resolve <id>` | Record fix outcome, update learned rules |
| `failsafe rules list` | List all rules (declared + learned + builtin) |
| `failsafe rules show <id>` | Show rule details and statistics |
| `failsafe rules validate` | Validate `.failsafe/rules.yaml` |
| `failsafe rules export-learned` | Export learned rules as YAML for promotion |
| `failsafe rules disable <id>` | Disable a learned rule |
| `failsafe rules flaky` | List flaky failure signatures |
| `failsafe kb export` | Export knowledge base to JSON |
| `failsafe kb import <file>` | Import knowledge base from JSON |

## Tiered Rule System

Rules are evaluated in priority order:

1. **Declared** (`.failsafe/rules.yaml`) -- team-authored, project-specific
2. **Learned** (knowledge base) -- auto-generated from past resolutions
3. **Built-in** (12 templates) -- universal patterns shipped with Failsafe

Learned rules auto-promote when they reach sufficient confidence and occurrence count. Flaky tests are detected when failures recur after a fix.

## MCP Interface

Failsafe ships an MCP (Model Context Protocol) server so flow orchestrators (AgentFlow, Statewright, etc.) can call it as a validation checkpoint. It exposes four tools over stdio, each returning the same JSON contract as the equivalent CLI command:

| Tool | Equivalent CLI | Purpose |
|------|----------------|---------|
| `failsafe_analyze` | `run` (+ `diagnose` if `diagnose=true`) | Run a command, capture/parse the failure, optionally diagnose |
| `failsafe_diagnose` | `diagnose` | Root-cause hypothesis for a stored failure |
| `failsafe_repro` | `repro` | Minimal reproduction selector |
| `failsafe_verify` | `verify` | Re-run repro + original to confirm a fix |

Start the server:

```bash
failsafe-mcp        # installed binary
# or
bun run mcp         # from the repo
```

MCP client config example:

```json
{
  "mcpServers": {
    "failsafe": { "command": "failsafe-mcp" }
  }
}
```

The CLI and MCP server share a single implementation (`src/core/operations.ts`), so their output contracts never diverge.

Example `.failsafe/rules.yaml`:

```yaml
version: "1"
rules:
  - id: "team-jwt-expired"
    pattern:
      error_contains: "token expired"
    diagnosis:
      category: "auth_error"
      explanation: "JWT expired. Auth service returns 422."
      fix: "Refresh token: POST /api/auth/refresh"
      enforcement: "suggest"
    confidence: 0.92
```

## Output

Default output is JSON, optimized for agent consumption:

```json
{
  "status": "failed",
  "failure_id": "fail_01HZX...",
  "summary": "KeyError: 'email' in create_user_from_oauth",
  "primary_location": { "file": "src/auth.py", "line": 42 },
  "test_summary": { "total": 18, "passed": 12, "failed": 6, "skipped": 0 },
  "raw_paths": {
    "stdout": ".failsafe/runs/fail_01HZX/stdout.log",
    "stderr": ".failsafe/runs/fail_01HZX/stderr.log"
  },
  "next": [
    { "command": "failsafe diagnose fail_01HZX", "reason": "Build a root-cause packet" }
  ],
  "token_budget": {
    "raw_output_bytes": 9231,
    "returned_bytes": 701,
    "compression_ratio": 13.2
  }
}
```

Output is capped by `config.token_budget.max_output_bytes` (default 6000). Use `--max-bytes` to override. When output is truncated, `raw_paths` point to the full untruncated files on disk. Use `--format text` for human-readable summaries.

## Parsers

Built-in parsers (8 parsers across Python, JavaScript/TypeScript):

| Language | Framework | What it extracts |
|----------|-----------|-----------------|
| Python | traceback | Stack frames, exception type, message |
| Python | pytest | Test names, assertion diffs, test summary, collection errors |
| JavaScript | stack trace | Stack frames, error type, application vs library frames |
| JavaScript | Jest | Test names, Expected/Received diffs, test summary |
| JavaScript | Vitest | Nested test paths, assertion diffs, test summary |
| TypeScript | tsc | TS error codes, file:line locations, total count |
| JavaScript | ESLint | Rule names, locations, problem count |
| JavaScript | Biome | Rule names, locations, error count |

## Security

- **Command policy**: Commands are validated against an allowlist. Shell operators (`&&`, `||`, `;`, `|`) are split and each sub-command is checked. Shell metacharacters (backticks, `$(...)`, `${...}`) are blocked.
- **Secret redaction**: 11 patterns (OpenAI, Anthropic, GitHub, AWS, HF tokens, etc.) plus 30+ sensitive env var names are redacted before storage and output.
- **Local-first**: No cloud uploads, no telemetry, no external API calls.

## Storage

Local-first under `.failsafe/`:

```
.failsafe/
  config.json          # Project configuration
  history.sqlite       # Failure records, diagnoses, learned rules, signatures
  runs/
    fail_01HZX/
      stdout.log       # Raw captured output
      stderr.log
      parsed.json      # Structured parse results
      diagnosis.json   # Diagnosis packet
```

## Configuration

```bash
failsafe config show
failsafe config set token_budget.max_output_bytes 4000
failsafe config set security.allow_commands '["pytest","npm","bun"]'
```

Key settings:

| Key | Default | Description |
|-----|---------|-------------|
| `default_format` | `"json"` | Output format |
| `token_budget.max_output_bytes` | `6000` | Max output size in bytes |
| `security.allow_commands` | 16 common tools | Command allowlist |
| `security.deny_patterns` | rm -rf, sudo, etc. | Blocked command patterns |
| `rules.auto_learn` | `true` | Record failures for learning |
| `rules.staleness_days` | `90` | Days before a learned rule is flagged stale |
| `timeouts.run_seconds` | `120` | Command execution timeout |

## Agent Integration

Instruct your coding agent:

```
When a command fails, call Failsafe first:
1. failsafe run "<command>" to capture the failure
2. failsafe diagnose last before opening source files
3. failsafe repro last before stepping through code
4. failsafe verify last after applying a fix
5. failsafe resolve last --success after confirming the fix
Treat Failsafe output as the compact failure context. Only request raw logs when the diagnosis lacks evidence.
```

A Claude Code skill is included at `skills/failsafe/` — copy to `~/.claude/skills/failsafe/` or `.claude/skills/failsafe/` for automatic integration.

## Development

```bash
bun install              # Install dependencies
bun test tests/          # Run tests (163 tests)
bun run test:e2e         # Run e2e tests against fixture projects
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun src/cli/index.ts     # Run CLI directly
```

## License

MIT
