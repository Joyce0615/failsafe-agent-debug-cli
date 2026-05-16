# Language Support

## Parsers (failure output parsing)

| Language | Framework | What it extracts |
|----------|-----------|-----------------|
| Python | traceback | Stack frames, exception type, message |
| Python | pytest | Test names, assertion diffs (expected/actual), test summary, collection errors |
| JavaScript | stack trace | Stack frames, error type, application vs library frame classification |
| JavaScript | Jest | Test names, Expected/Received diffs, test summary |
| JavaScript | Vitest | Nested test paths, assertion diffs, test summary |
| TypeScript | tsc | TS error codes, file:line locations, total error count |
| JavaScript | ESLint | Rule names, locations, problem count |
| JavaScript | Biome | Rule names, locations, error count |

## Debug Adapters (DAP stepping)

| Runtime | Status | Debugger | Install |
|---------|--------|----------|---------|
| Python | **Supported** | debugpy | `pip install debugpy` |
| Node.js | **Supported** | Built-in inspector | (no install needed) |
| Go | Recognized, not yet supported | Delve | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| Rust | Recognized, not yet supported | LLDB / CodeLLDB | System package manager |
| Java | Recognized, not yet supported | JDI | JDK |
| .NET | Recognized, not yet supported | netcoredbg | Samsung/netcoredbg |

When you attempt `failsafe debug` on an unsupported runtime, Failsafe returns a structured JSON packet with the detected runtime, what debugger will be needed, and fallback commands (`diagnose`, `repro`) that work without a debugger.

## Diagnosis Templates (12 builtin rules)

| Category | Matches |
|----------|---------|
| `null_reference` | TypeError on undefined/null, NoneType attribute access |
| `key_error` | KeyError, missing dict/object key |
| `attribute_error` | AttributeError, missing attribute on object |
| `import_error` | ModuleNotFoundError, Cannot find module |
| `assertion_mismatch` | AssertionError, Expected/Received diffs |
| `type_error` | TypeScript TS error codes |
| `syntax_error` | SyntaxError in any language |
| `index_error` | IndexError, RangeError |
| `lint_violation` | ESLint/Biome rule violations |
| `timeout` | Command/test timeout |
| `permission_error` | PermissionError, EACCES, EPERM |
| `connection_error` | ECONNREFUSED, ETIMEDOUT, fetch failures |
