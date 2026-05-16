# Example: Node.js/Jest Debugging Workflow

## Scenario

A Node.js project with 7 Jest tests. 2 are failing with TypeError (undefined property access).

## Step 1: Capture

```bash
failsafe run "npx jest"
```

Output (696 bytes from 1493 bytes raw — 2.1x compression):

```json
{
  "status": "failed",
  "failure_id": "fail_vM-dqLBVE35s",
  "summary": "TypeError: Cannot read properties of undefined (reading 'toLowerCase')",
  "primary_location": { "file": "auth.js", "line": 7, "column": 38, "symbol": "toLowerCase" },
  "test_summary": { "total": 7, "passed": 5, "failed": 2 }
}
```

## Step 2: Diagnose

```bash
failsafe diagnose last
```

```json
{
  "summary": "Null/undefined access: TypeError: Cannot read properties of undefined",
  "root_cause": {
    "category": "null_reference",
    "explanation": "Code accesses a property or method on a null/undefined value at auth.js:7",
    "confidence": 0.8
  },
  "evidence": [
    { "kind": "source_slice", "location": "auth.js:2-12",
      "value": "7:   const normalizedEmail = user.email.toLowerCase();" }
  ],
  "rule_source": "builtin",
  "rule_id": "null_reference"
}
```

The diagnosis pinpoints the exact line and includes the source context.

## Step 3: Fix and verify

```bash
# After fixing auth.js to add null check
failsafe verify last
failsafe resolve last --success --fix-summary "Added optional chaining for user.email"
```
