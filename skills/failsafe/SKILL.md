---
name: failsafe
description: Debug failures with Failsafe — a CLI that compresses noisy test output, stack traces, and build errors into compact structured JSON packets. Use when a command fails, tests fail, a build breaks, or you need to diagnose a runtime error. Replaces raw log reading with structured diagnosis.
when_to_use: When a test fails, a build breaks, a command returns a non-zero exit code, or you need to understand why something crashed. Also use when you're about to paste raw error output — run it through Failsafe first.
argument-hint: "[command-to-debug]"
allowed-tools: Bash(failsafe *) Bash(pytest *) Bash(npm test *) Bash(bun test *) Bash(jest *) Bash(vitest *)
---

# Failsafe: Agent-First Debugging

Failsafe compresses failure output into compact JSON packets so you spend fewer tokens on debugging loops.

## Core Workflow

When a command fails, follow this sequence instead of reading raw logs:

```
1. failsafe run "<failing-command>"     → compact failure packet
2. failsafe diagnose <id>              → root cause + evidence + source context
3. failsafe repro <id>                 → minimal single-test reproduction
4. [fix the code]
5. failsafe verify <id>                → confirm fix passes
6. failsafe resolve <id> --success     → record for learning
```

## Quick Start

If arguments were provided, run them through Failsafe:

```bash
failsafe run "$ARGUMENTS"
```

Then diagnose the result:

```bash
failsafe diagnose last
```

## Commands Reference

### Capture and diagnose

| Command | Purpose |
|---------|---------|
| `failsafe run "<cmd>"` | Execute command, capture output, return compact JSON |
| `failsafe diagnose <id\|last>` | Root-cause hypothesis with evidence and confidence |
| `failsafe repro <id\|last>` | Extract minimal reproduction (single test selector) |
| `failsafe verify <id>` | Re-run repro + original to confirm fix |
| `failsafe explain <id>` | Combine all evidence into synthesis |

### Debug stepping (experimental, Python/debugpy only)

Debug sessions are in-memory within a single process invocation. Node.js DAP support is planned.

| Command | Purpose |
|---------|---------|
| `failsafe debug <id> --break primary` | Launch debugger at failure point |
| `failsafe step --session <id> --over` | Step over, return state deltas |
| `failsafe inspect vars --session <id>` | Read local variables |
| `failsafe inspect expr --session <id> "<expr>"` | Evaluate expression |
| `failsafe inspect stack --session <id>` | View call stack |

### Knowledge base

| Command | Purpose |
|---------|---------|
| `failsafe resolve <id> --success --fix-summary "..."` | Record fix outcome |
| `failsafe rules list` | List all rules (declared + learned + builtin) |
| `failsafe rules validate` | Validate .failsafe/rules.yaml |
| `failsafe history --similar <id>` | Find past similar failures |

## Rules of Engagement

1. **Always use `failsafe run` instead of running test commands directly** when debugging. The compact packet saves tokens.
2. **Use `failsafe diagnose` before opening broad source files.** The diagnosis includes source slices at failure locations.
3. **Use `failsafe repro` before debug stepping.** Narrowing to one test makes debugging faster.
4. **Use `failsafe verify` after patching.** Don't just re-run manually.
5. **Use `failsafe resolve --success` after confirming a fix.** This builds the knowledge base for future failures.
6. **Only request raw logs when the structured diagnosis says evidence is insufficient.** Use `failsafe run --raw` in that case.

## Output Format

Failsafe returns JSON by default. Key fields:

- `failure_id` — unique ID to reference in subsequent commands
- `summary` — one-line description of what failed
- `primary_location` — `{file, line, symbol}` of the failure
- `test_summary` — `{total, passed, failed, skipped}` counts
- `token_budget` — compression ratio and tokens saved
- `next` — suggested follow-up commands
- `rule_source` — which rule tier matched: `declared`, `learned`, or `builtin`

## Declared Rules

Teams can add project-specific rules in `.failsafe/rules.yaml`. These take priority over learned and builtin rules. For details on the rule format, see [rules-reference.md](rules-reference.md).

## Supported Languages

For parser details and debug adapter support, see [language-support.md](language-support.md).
