# Example: Full pytest Debugging Workflow

## Scenario

A Python project with 18 tests. 6 are failing with KeyError, AttributeError, AssertionError, and ZeroDivisionError.

## Step 1: Capture

```bash
failsafe run "pytest tests/ -v"
```

Output (701 bytes from 9231 bytes raw — 13.2x compression):

```json
{
  "status": "failed",
  "failure_id": "fail_iEOgRTzv6XwK",
  "failure_type": "test_failure",
  "summary": "Test failed: TestCreateUserFromOAuth::test_gitlab_login",
  "test_summary": { "total": 18, "passed": 12, "failed": 6, "skipped": 0 },
  "token_budget": { "raw_output_bytes": 9231, "returned_bytes": 701, "compression_ratio": 13.2 }
}
```

## Step 2: Diagnose

```bash
failsafe diagnose fail_iEOgRTzv6XwK
```

Returns root cause, evidence, source context for all 6 failing tests, and suggested next actions.

## Step 3: Minimal reproduction

```bash
failsafe repro fail_iEOgRTzv6XwK --no-verify
```

```json
{
  "command": "pytest TestCreateUserFromOAuth::test_gitlab_login -x",
  "reduction": { "original_tests": 18, "repro_tests": 1 }
}
```

## Step 4: Fix the code, then verify

```bash
failsafe verify fail_iEOgRTzv6XwK
```

## Step 5: Record the fix

```bash
failsafe resolve fail_iEOgRTzv6XwK --success \
  --fix-summary "Added gitlab to PROVIDER_FIELD_MAP" \
  --files-changed src/auth.py
```
