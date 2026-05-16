# Declared Rules Reference

Teams write project-specific rules in `.failsafe/rules.yaml`. Declared rules have the highest priority — they override learned and builtin rules.

## File Format

```yaml
version: "1"
rules:
  - id: "rule-id"          # Unique identifier
    pattern:                # Matching criteria (all must match)
      error_type: "..."     # Exact match on error type
      error_contains: "..." # Substring match on error message (string or list)
      message_regex: "..."  # Regex match on error message
      file_matches: "..."   # Regex match on file path
    diagnosis:              # What to tell the agent
      category: "..."       # Root cause category
      explanation: "..."    # Why this happened
      fix: "..."            # What to do
      fix_commands:         # Shell commands to run
        - "command1"
        - "command2"
      enforcement: "suggest" # "auto-fix", "suggest", or "block"
    confidence: 0.95        # 0.0 to 1.0
```

## Matching Criteria

All specified criteria must match (AND logic). At least one error in the failure must satisfy all criteria.

| Criterion | Type | Description |
|-----------|------|-------------|
| `error_type` | string | Exact match on ParsedError.error_type |
| `error_contains` | string or list | Error message includes substring(s) |
| `message_regex` | string | Regex with optional named groups |
| `file_matches` | string | Regex against file path |

## Enforcement Levels

| Level | Behavior |
|-------|----------|
| `"suggest"` | Include in diagnosis, let agent decide (default) |
| `"auto-fix"` | Apply fix automatically, re-run |
| `"block"` | Halt execution, require human intervention |

## Example Rules

### Team convention override

```yaml
- id: "team-zero-division"
  pattern:
    error_contains: "ZeroDivisionError"
  diagnosis:
    category: "math_error"
    explanation: "Division by zero. Our convention: return 0 for empty inputs."
    fix: "Add guard: if divisor == 0: return 0"
    enforcement: "auto-fix"
  confidence: 0.95
```

### Framework-specific rule

```yaml
- id: "team-db-migration"
  pattern:
    error_contains: "relation"
    message_regex: "relation \"(?P<table>\\w+)\" does not exist"
  diagnosis:
    category: "missing_migration"
    explanation: "Table missing. Migration not applied."
    fix: "Run: python manage.py migrate"
    fix_commands: ["python manage.py migrate"]
    enforcement: "auto-fix"
  confidence: 0.95
```

### File-scoped rule

```yaml
- id: "team-webhook-auth"
  pattern:
    error_contains: "401"
    file_matches: ".*webhook.*"
  diagnosis:
    category: "auth_error"
    explanation: "Webhooks use signature verification, not bearer tokens."
    fix: "Check X-Signature header instead of Authorization header."
    enforcement: "suggest"
  confidence: 0.88
```

## Validation

```bash
failsafe rules validate
```

Returns `{ "valid": true, "rules_count": N, "errors": [] }` or a list of errors with rule IDs.

## Rule Priority Order

```
1. Declared rules (.failsafe/rules.yaml)     — highest
2. Learned rules (knowledge base)             — from past resolutions
3. Built-in rules (12 templates)              — shipped with Failsafe
4. Fallback                                   — generic "unknown"
```
