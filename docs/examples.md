# Failsafe Examples

## Table of Contents

- [Example 1: Python/pytest — Multi-file project](#example-1-pythonpytest--multi-file-project)
- [Example 2: Node.js/Jest — TypeError and null access](#example-2-nodejsjest--typeerror-and-null-access)
- [Example 3: Declared rules override](#example-3-declared-rules-override)
- [Example 4: Debug stepping (DAP)](#example-4-debug-stepping-dap)
- [Example 5: Unsupported runtimes](#example-5-unsupported-runtimes)
- [Language support matrix](#language-support-matrix)

---

## Example 1: Python/pytest — Multi-file project

**Project**: `tests/e2e/pytest_project/` — 3 source files, 18 tests, 6 bugs (KeyError, AttributeError, AssertionError, ZeroDivisionError).

### Run the full test suite

```
$ failsafe run "pytest tests/e2e/pytest_project/tests/ -v"
```

```json
{
  "status": "failed",
  "failure_id": "fail_iEOgRTzv6XwK",
  "failure_type": "test_failure",
  "summary": "Test failed: TestCreateUserFromOAuth::test_gitlab_login",
  "primary_location": {
    "file": "tests/e2e/pytest_project/tests/test_auth.py",
    "line": 1
  },
  "test_summary": {
    "total": 18,
    "passed": 12,
    "failed": 6,
    "skipped": 0
  },
  "token_budget": {
    "raw_output_bytes": 9231,
    "returned_bytes": 701,
    "compression_ratio": 13.2,
    "estimated_tokens_saved": 2132
  }
}
```

**9231 bytes → 701 bytes (13.2x compression, 2132 tokens saved)**

### Diagnose

```
$ failsafe diagnose fail_iEOgRTzv6XwK
```

The diagnosis identifies the root cause (`key_error` or `assertion_mismatch` template), extracts source context for all 6 failing test functions across 3 files, and suggests next actions.

```json
{
  "root_cause": {
    "category": "assertion_mismatch",
    "explanation": "Test assertion failed at test_auth.py:1",
    "confidence": 0.75
  },
  "minimal_context": [
    {
      "file": "tests/test_auth.py", "start_line": 22, "end_line": 27,
      "text": "22:     def test_gitlab_login(self):\n23:         \"\"\"BUG: GitLab is not in PROVIDER_FIELD_MAP → KeyError.\"\"\"\n24:         payload = {\"id\": 99, ...}\n25:         user = create_user_from_oauth(\"gitlab\", payload)"
    }
  ],
  "rule_source": "builtin",
  "rule_id": "assertion_mismatch"
}
```

### Create minimal reproduction

```
$ failsafe repro fail_iEOgRTzv6XwK --no-verify
```

```json
{
  "command": "pytest TestCreateUserFromOAuth::test_gitlab_login -x",
  "confidence": 0.95,
  "reduction": { "original_tests": 18, "repro_tests": 1 }
}
```

**18 tests → 1 test selector.**

### Record the fix

```
$ failsafe resolve fail_iEOgRTzv6XwK --success \
    --fix-summary "Added gitlab to PROVIDER_FIELD_MAP" \
    --files-changed src/auth.py
```

```json
{
  "signature_hash": "318e831d2621e2fb",
  "success": true,
  "is_flaky": false
}
```

---

## Example 2: Node.js/Jest — TypeError and null access

**Project**: `tests/e2e/node_project/` — auth module with 7 Jest tests, 2 bugs (undefined property access).

### Run Jest

```
$ failsafe run "./node_modules/.bin/jest"
```

```json
{
  "status": "failed",
  "failure_id": "fail_vM-dqLBVE35s",
  "failure_type": "test_failure",
  "summary": "TypeError: Cannot read properties of undefined (reading 'toLowerCase')",
  "primary_location": {
    "file": "auth.js",
    "line": 7,
    "column": 38,
    "symbol": "toLowerCase"
  },
  "test_summary": { "total": 7, "passed": 5, "failed": 2, "skipped": 0 },
  "token_budget": {
    "raw_output_bytes": 1493,
    "returned_bytes": 696,
    "compression_ratio": 2.1
  }
}
```

### Diagnose

```
$ failsafe diagnose fail_vM-dqLBVE35s
```

```json
{
  "summary": "Null/undefined access: TypeError: Cannot read properties of undefined (reading 'toLowerCase')",
  "root_cause": {
    "category": "null_reference",
    "explanation": "Code accesses a property or method on a null/undefined value at auth.js:7",
    "confidence": 0.8
  },
  "evidence": [
    { "kind": "error_message", "value": "TypeError: Cannot read properties of undefined (reading 'toLowerCase')" },
    { "kind": "stack_frame", "location": "auth.js:7", "value": "TypeError: ..." },
    {
      "kind": "source_slice", "location": "auth.js:2-12",
      "value": "5: function validateUser(user) {\n6:   // Bug: crashes when user.email is undefined\n7:   const normalizedEmail = user.email.toLowerCase();\n8:   return { ...user, email: normalizedEmail };\n9: }"
    }
  ],
  "rule_source": "builtin",
  "rule_id": "null_reference"
}
```

Failsafe extracts the exact failing line (`auth.js:7`), the source context showing the bug, and both failing test bodies.

---

## Example 3: Declared rules override

Teams can write project-specific rules in `.failsafe/rules.yaml` that override the builtin templates.

### Create rules file

```yaml
# .failsafe/rules.yaml
version: "1"
rules:
  - id: "team-zero-division"
    pattern:
      error_contains: "ZeroDivisionError"
    diagnosis:
      category: "math_error"
      explanation: "Division by zero in calculator. Our convention is to return 0 for empty inputs."
      fix: "Add a guard: if divisor == 0 or len(values) == 0: return 0"
      enforcement: "auto-fix"
    confidence: 0.95

  - id: "team-missing-key"
    pattern:
      error_contains: "KeyError"
      file_matches: ".*buggy_calc.*"
    diagnosis:
      category: "data_validation"
      explanation: "Input dict missing required key. All data dicts must have 'name' and 'scores'."
      fix: "Validate required keys at function entry: assert 'scores' in data"
      enforcement: "suggest"
    confidence: 0.92
```

### Validate rules

```
$ failsafe rules validate
```

```json
{ "valid": true, "rules_count": 2, "errors": [] }
```

### Diagnose with declared rule

```
$ failsafe run "pytest tests/test_buggy_calc.py::test_divide_items_by_zero -x"
$ failsafe diagnose last
```

```json
{
  "summary": "Division by zero in calculator. Our convention is to return 0 for empty inputs.",
  "root_cause": {
    "category": "math_error",
    "explanation": "Division by zero in calculator. Our convention is to return 0 for empty inputs.",
    "confidence": 0.95
  },
  "rule_source": "declared",
  "rule_id": "team-zero-division",
  "enforcement": "auto-fix"
}
```

The declared rule takes priority over the builtin `assertion_mismatch` template. The diagnosis uses the team's custom category (`math_error`), explanation, fix instructions, and enforcement level (`auto-fix`).

### Rule priority order

```
1. Declared rules (.failsafe/rules.yaml)     — highest priority
2. Learned rules (knowledge base)             — from past resolutions
3. Built-in rules (12 templates)              — shipped with Failsafe
4. Fallback                                   — generic "unknown"
```

---

## Example 4: Debug stepping (DAP, experimental)

Failsafe supports experimental interactive debugging via the Debug Adapter Protocol. Only **Python** (debugpy) has a working adapter. Node.js is recognized but its DAP adapter (`@vscode/js-debug`) is not yet wired up. Debug sessions are in-memory within a single process invocation.

### Launch a debug session

```
$ failsafe debug fail_abc123 --break primary
```

```json
{
  "debug_session_id": "dbg_xyz789",
  "runtime": "python",
  "adapter": "debugpy",
  "status": "paused",
  "pause_reason": "breakpoint",
  "location": { "file": "src/auth.py", "line": 42, "symbol": "validateUser" },
  "source_context": "40: def validateUser(user):\n41:     email = user.email\n42:     normalized = email.lower()\n43:     return normalized",
  "next": [
    { "command": "failsafe inspect vars --session dbg_xyz789", "reason": "Read local variables" },
    { "command": "failsafe step --session dbg_xyz789 --over", "reason": "Advance and report changed state" }
  ]
}
```

### Inspect variables

```
$ failsafe inspect vars --session dbg_xyz789
```

```json
{
  "kind": "variables",
  "variables": [
    { "name": "user", "type": "User", "value": "{'id': '42', 'email': None}" },
    { "name": "email", "type": "NoneType", "value": "None" }
  ]
}
```

### Step and see state deltas

```
$ failsafe step --session dbg_xyz789 --over --count 3 --summary delta
```

```json
{
  "step": { "kind": "over", "count": 3 },
  "status": "paused",
  "location": { "file": "src/auth.py", "line": 45 },
  "state_delta": [
    { "name": "email", "before": "undefined", "after": "undefined", "note": "Still undefined after normalization branch" },
    { "name": "result", "before": "uninitialized", "after": "not reached" }
  ],
  "interpretation": "Advanced from line 42 to line 45. Changed: email (undefined -> undefined)"
}
```

### Evaluate an expression

```
$ failsafe inspect expr --session dbg_xyz789 "user.__dict__"
```

```json
{
  "kind": "expression",
  "expression": "user.__dict__",
  "value": "{'id': '42', 'name': 'ghost', 'email': None, 'role': 'member'}",
  "summary": "User object has email=None"
}
```

### Full debug workflow

```
failsafe run "pytest tests/"           → compact failure packet
failsafe repro <id>                    → single test selector
failsafe debug <id> --break primary    → pause at failure line
failsafe inspect vars --session <id>   → see local variables
failsafe step --session <id> --over    → advance, get state delta
failsafe inspect expr --session <id> "payload"  → evaluate expression
```

**Requirements**: `pip install debugpy` for Python. Node.js DAP debugging requires `@vscode/js-debug` (recognized but not yet available).

---

## Example 5: Unsupported runtimes

When Failsafe detects a runtime it can't debug, it returns a structured packet instead of a generic error.

### Go

```
$ failsafe debug fail_abc --break main.go:10 --runtime go
```

```json
{
  "error": true,
  "unsupported_runtime": true,
  "runtime": "go",
  "reason": "Runtime 'go' is recognized but debug stepping is not yet supported. Supported: python, node.",
  "future_debugger": "Delve",
  "install_hint": "go install github.com/go-delve/delve/cmd/dlv@latest",
  "next": [
    { "command": "failsafe diagnose fail_abc", "reason": "Get a root-cause diagnosis without debugging" },
    { "command": "failsafe repro fail_abc", "reason": "Create a minimal reproduction to debug manually" }
  ]
}
```

### Rust

```json
{
  "unsupported_runtime": true,
  "runtime": "rust",
  "future_debugger": "LLDB / CodeLLDB",
  "install_hint": "Install LLDB via your system package manager"
}
```

### Java

```json
{
  "unsupported_runtime": true,
  "runtime": "java",
  "future_debugger": "JDI",
  "install_hint": "Java Debug Interface (requires JDK)"
}
```

### .NET

```json
{
  "unsupported_runtime": true,
  "runtime": "dotnet",
  "future_debugger": "netcoredbg",
  "install_hint": "Install netcoredbg from Samsung/netcoredbg"
}
```

The agent gets the detected runtime, what debugger will be needed in the future, and fallback commands (`diagnose`, `repro`) that work without a debugger.

---

## Language Support Matrix

### Parsers (failure output parsing)

| Language | Framework | Parser | Detects | Extracts |
|----------|-----------|--------|---------|----------|
| Python | traceback | `python-traceback` | `Traceback (most recent call last):` | Stack frames, exception type, message |
| Python | pytest | `pytest` | `FAILURES`, short test summary | Test names, assertion diffs, test summary (pass/fail/skip) |
| JavaScript | stack trace | `js-stack` | `at func (file:line:col)` | Stack frames, error type, application vs library frames |
| JavaScript | Jest | `jest` | `FAIL`, `Tests:` summary | Test names, Expected/Received diffs, test summary |
| JavaScript | Vitest | `vitest` | `Test Files`, `FAIL` | Nested test paths, assertion diffs, test summary |
| TypeScript | tsc | `tsc` | `file(line,col): error TSxxxx:` | Error codes, file locations, total count |
| JavaScript | ESLint | `eslint` | `line:col  error  message  rule` | Rule names, locations, problem count |
| JavaScript | Biome | `biome` | `lint/category/rule` | Rule names, locations, error count |

### Debug adapters (DAP stepping)

| Runtime | Adapter | Status | Debugger | Install |
|---------|---------|--------|----------|---------|
| Python | debugpy | Supported (experimental) | debugpy | `pip install debugpy` |
| Node.js | — | Recognized, adapter not yet available | @vscode/js-debug | `npm install -g @vscode/js-debug` |
| Go | — | Planned | Delve | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| Rust | — | Planned | LLDB / CodeLLDB | System package manager |
| Java | — | Planned | JDI | JDK |
| .NET | — | Planned | netcoredbg | Samsung/netcoredbg |

### Diagnosis templates (builtin rules)

| Category | Matches | Example |
|----------|---------|---------|
| `null_reference` | TypeError on undefined/null, NoneType | `Cannot read properties of undefined` |
| `key_error` | KeyError, missing dict key | `KeyError: 'email'` |
| `attribute_error` | AttributeError, missing attribute | `'NoneType' object has no attribute 'lower'` |
| `import_error` | ModuleNotFoundError, Cannot find module | `No module named 'flask'` |
| `assertion_mismatch` | AssertionError, Expected/Received diffs | `assert 200 == 401` |
| `type_error` | TypeScript TS codes | `TS2322: Type 'number' is not assignable` |
| `syntax_error` | SyntaxError | `Unexpected token` |
| `index_error` | IndexError, RangeError | `list index out of range` |
| `lint_violation` | ESLint/Biome rule violations | `no-unused-vars` |
| `timeout` | Timeout, timed out | `Command exceeded timeout` |
| `permission_error` | PermissionError, EACCES | `Permission denied` |
| `connection_error` | ECONNREFUSED, ETIMEDOUT | `Connection refused` |

### Tiered rules

All parsers and templates work at the **builtin** tier. Teams can add **declared** rules in `.failsafe/rules.yaml` (YAML, any matching criteria) and Failsafe auto-generates **learned** rules from past resolutions in the knowledge base.
