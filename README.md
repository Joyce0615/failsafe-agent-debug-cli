# Failsafe

Agent-first debugging CLI. Compresses noisy failure output into compact structured JSON packets so coding agents spend fewer tokens on debugging loops.

```
failure -> compact diagnosis -> minimal repro -> debugger stepping -> state deltas -> verify
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
failsafe diagnose --last

# Create a minimal reproduction
failsafe repro --last

# Verify after fixing
failsafe verify --last
```

All commands output JSON by default. Use `--format text` for human-readable output.

## Commands

### Core (Phase 0)

| Command | Description |
|---------|-------------|
| `failsafe run <cmd>` | Execute a command, capture output, return compact failure packet |
| `failsafe diagnose <id>` | Build a root-cause hypothesis with evidence and confidence |
| `failsafe init` | Initialize `.failsafe/` storage directory |
| `failsafe config show\|set` | View or modify configuration |
| `failsafe doctor` | Check system dependencies |
| `failsafe history` | List past failures, find similar ones with `--similar <id>` |

### Repro (Phase 1)

| Command | Description |
|---------|-------------|
| `failsafe repro <id>` | Extract a minimal reproduction (single test selector) |

### Debug (Phase 2)

| Command | Description |
|---------|-------------|
| `failsafe debug <id>` | Launch debugger at failure location (Python/debugpy, Node/inspector) |
| `failsafe step --session <id>` | Step through execution, return state deltas |
| `failsafe inspect vars\|stack\|expr\|source` | Inspect runtime state in a debug session |
| `failsafe verify <id>` | Re-run repro and original command to confirm fix |
| `failsafe explain <id>` | Combine all evidence into a compact explanation |

### Tiered Rules (Phase 3)

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
  "next": [
    { "command": "failsafe diagnose fail_01HZX", "reason": "Build a root-cause packet" }
  ],
  "token_budget": {
    "raw_output_bytes": 48192,
    "returned_bytes": 1260,
    "compression_ratio": 38.2
  }
}
```

Output is capped by `config.token_budget.max_output_bytes` (default 6000). Use `--max-bytes` to override. Use `--format text` for human-readable summaries.

## Parsers

Built-in parsers for:

- **Python**: tracebacks, pytest (FAILED markers, assertion introspection, test selectors)
- **JavaScript/TypeScript**: stack traces, Jest, Vitest (expected/received, test selectors)
- **TypeScript compiler**: `tsc` errors (TS codes, file locations)
- **Linters**: ESLint, Biome (rule violations, file locations)

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
2. failsafe diagnose --last before opening source files
3. failsafe repro --last before stepping through code
4. failsafe verify --last after applying a fix
5. failsafe resolve --last --success after confirming the fix
Treat Failsafe output as the compact failure context. Only request raw logs when the diagnosis lacks evidence.
```

## Development

```bash
bun install          # Install dependencies
bun test             # Run tests (94 tests)
bun run typecheck    # TypeScript check
bun run lint         # Biome lint
bun src/cli/index.ts # Run CLI directly
```

## License

MIT
