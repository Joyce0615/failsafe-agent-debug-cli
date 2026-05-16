# End-to-End Demo: Real Pytest Project

This demo runs Failsafe against a Python project with 3 source files, 3 test files, 18 tests, and 6 deliberate bugs across 4 error types.

## Test Project

```
tests/e2e/pytest_project/
  src/
    models.py         # User, Account classes
    auth.py           # OAuth login, user validation
    permissions.py    # Role-based access control
  tests/
    conftest.py       # Shared fixtures (admin_user, viewer_user, no_email_user, test_account)
    test_auth.py      # 6 tests (2 bugs: KeyError on unknown provider, NoneType on missing email)
    test_models.py    # 6 tests (2 bugs: NoneType on email.lower(), list comprehension crash)
    test_permissions.py  # 6 tests (2 bugs: assertion mismatch on role, NoneType on missing member)
```

Bug types:
- **KeyError**: `PROVIDER_FIELD_MAP[provider]` when provider is `"gitlab"` (not in dict)
- **AttributeError (NoneType)**: `self.email.lower()` when email is `None` (3 occurrences across call chain)
- **AssertionError**: `can_edit(user)` returns `False` for `"superadmin"` role not in hierarchy
- **AttributeError (None member)**: `member.role` when `find_member()` returns `None`

## Step 1: Run the full test suite

```
$ failsafe run "pytest tests/e2e/pytest_project/tests/ -v"
```

```json
{
  "schema_version": "0.1",
  "command": "pytest tests/e2e/pytest_project/tests/ -v",
  "status": "failed",
  "exit_code": 1,
  "failure_id": "fail_iEOgRTzv6XwK",
  "failure_type": "test_failure",
  "summary": "Test failed: TestCreateUserFromOAuth::test_gitlab_login",
  "duration_ms": 518,
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
  "next": [
    { "command": "failsafe diagnose fail_iEOgRTzv6XwK", "reason": "Build a root-cause packet" },
    { "command": "failsafe repro fail_iEOgRTzv6XwK", "reason": "Create a minimal reproduction" },
    { "command": "failsafe debug fail_iEOgRTzv6XwK --break primary", "reason": "Inspect runtime state at failure line" }
  ],
  "token_budget": {
    "raw_output_bytes": 9231,
    "returned_bytes": 701,
    "compression_ratio": 13.2,
    "estimated_raw_tokens": 2308,
    "estimated_returned_tokens": 176,
    "estimated_tokens_saved": 2132
  }
}
```

9231 bytes of raw pytest output compressed to 701 bytes — **13.2x compression ratio, 2132 tokens saved**.

## Step 2: Diagnose

```
$ failsafe diagnose fail_iEOgRTzv6XwK
```

```json
{
  "schema_version": "0.1",
  "diagnosis_id": "diag_oDu288niyQh0",
  "failure_id": "fail_iEOgRTzv6XwK",
  "failure_type": "test_failure",
  "severity": "error",
  "summary": "Assertion failed in TestCreateUserFromOAuth::test_gitlab_login",
  "root_cause": {
    "category": "assertion_mismatch",
    "explanation": "Test assertion failed at tests/e2e/pytest_project/tests/test_auth.py:1. The actual value does not match the expected value.",
    "confidence": 0.75
  },
  "evidence": [
    { "kind": "error_message", "value": "Test failed: TestCreateUserFromOAuth::test_gitlab_login" },
    { "kind": "test_input", "location": "tests/e2e/pytest_project/tests/test_auth.py", "value": "Test: TestCreateUserFromOAuth::test_gitlab_login" }
  ],
  "uncertainty": [
    "Need to inspect why the actual value differs from expected",
    "Check if the test expectations are correct or if the code behavior changed"
  ],
  "minimal_context": [
    {
      "file": "tests/e2e/pytest_project/tests/test_auth.py",
      "start_line": 22, "end_line": 27,
      "text": "22:     def test_gitlab_login(self):\n23:         \"\"\"BUG: GitLab is not in PROVIDER_FIELD_MAP → KeyError.\"\"\"\n24:         payload = {\"id\": 99, \"username\": \"charlie\", \"email\": \"charlie@gitlab.com\"}\n25:         user = create_user_from_oauth(\"gitlab\", payload)\n26:         assert user.user_id == \"99\""
    },
    {
      "file": "tests/e2e/pytest_project/tests/test_auth.py",
      "start_line": 42, "end_line": 46,
      "text": "42:     def test_validates_user_without_email(self, no_email_user):\n43:         \"\"\"BUG: validate_user calls normalized_email() which crashes on None email.\"\"\"\n44:         result = validate_user(no_email_user)\n45:         assert result[\"valid\"] is True"
    },
    {
      "file": "tests/e2e/pytest_project/tests/test_models.py",
      "start_line": 15, "end_line": 21,
      "text": "15:     def test_normalized_email_none(self):\n16:         \"\"\"BUG: normalized_email crashes when email is None.\"\"\"\n17:         user = User(user_id=\"u1\", name=\"Alice\", email=None)\n18:         result = user.normalized_email()\n19:         assert result is None"
    },
    {
      "file": "tests/e2e/pytest_project/tests/test_models.py",
      "start_line": 32, "end_line": 37,
      "text": "32:     def test_member_emails(self, test_account):\n33:         \"\"\"BUG: member_emails crashes because one member has email=None.\"\"\"\n34:         emails = test_account.member_emails()\n35:         assert len(emails) == 3\n36:         assert \"alice@example.com\" in emails"
    },
    {
      "file": "tests/e2e/pytest_project/tests/test_permissions.py",
      "start_line": 18, "end_line": 25,
      "text": "18:     def test_unknown_role(self):\n19:         \"\"\"Edge case: role not in hierarchy should not be able to edit.\"\"\"\n20:         from src.models import User\n21:         user = User(user_id=\"u5\", name=\"Eve\", role=\"superadmin\")\n22:         # BUG: 'superadmin' gets level 0 but the test expects it should edit\n23:         assert can_edit(user) is True"
    },
    {
      "file": "tests/e2e/pytest_project/tests/test_permissions.py",
      "start_line": 32, "end_line": 36,
      "text": "32:     def test_unknown_member(self, test_account):\n33:         \"\"\"BUG: find_member returns None → AttributeError on .role.\"\"\"\n34:         perms = get_account_permissions(test_account, \"nonexistent\")\n35:         assert perms[\"role\"] is None"
    }
  ],
  "suggested_next_actions": [
    { "command": "failsafe repro fail_iEOgRTzv6XwK", "reason": "Create a minimal reproduction with just the failing test" },
    { "command": "failsafe debug fail_iEOgRTzv6XwK --break primary", "reason": "Inspect runtime state at the failure location" },
    { "command": "failsafe history --similar fail_iEOgRTzv6XwK", "reason": "Check if this failure has been seen and resolved before" }
  ],
  "rule_source": "builtin",
  "rule_id": "assertion_mismatch",
  "token_budget": {
    "raw_output_bytes": 9231,
    "returned_bytes": 3971,
    "compression_ratio": 2.3,
    "estimated_raw_tokens": 2308,
    "estimated_returned_tokens": 993,
    "estimated_tokens_saved": 1315
  }
}
```

The diagnosis extracts source context for all 6 failing test functions across 3 files, identifies the rule that matched (`builtin:assertion_mismatch`), and suggests next actions.

## Step 3: Create minimal reproduction

```
$ failsafe repro fail_iEOgRTzv6XwK --no-verify
```

```json
{
  "failure_id": "fail_iEOgRTzv6XwK",
  "repro_id": "repro_lzsX9GoEw7no",
  "status": "created",
  "kind": "test_selector",
  "command": "pytest TestCreateUserFromOAuth::test_gitlab_login -x",
  "confidence": 0.95,
  "reduction": {
    "original_tests": 18,
    "repro_tests": 1
  },
  "next": [
    { "command": "failsafe debug fail_iEOgRTzv6XwK --break primary", "reason": "Debug only the minimal failing path" }
  ]
}
```

Reduced from 18 tests to 1 test selector.

## Step 4: Record the fix

```
$ failsafe resolve fail_iEOgRTzv6XwK --success \
    --fix-summary "Added gitlab to PROVIDER_FIELD_MAP" \
    --files-changed src/auth.py
```

```json
{
  "failure_id": "fail_iEOgRTzv6XwK",
  "signature_hash": "318e831d2621e2fb",
  "success": true,
  "fix_summary": "Added gitlab to PROVIDER_FIELD_MAP",
  "files_changed": ["src/auth.py"],
  "is_flaky": false
}
```

## Step 5: View learned rules

```
$ failsafe rules list
```

```json
{
  "rules": [
    {
      "rule_id": "lrule_Wvu5xpJBbW8M",
      "source": "learned",
      "category": "unknown",
      "confidence": 1,
      "lifecycle": "active",
      "occurrence_count": 1,
      "success_count": 1,
      "explanation": "Test failed: TestCreateUserFromOAuth::test_gitlab_login"
    },
    { "rule_id": "null_reference", "source": "builtin", "category": "null_reference" },
    { "rule_id": "key_error", "source": "builtin", "category": "key_error" },
    { "rule_id": "attribute_error", "source": "builtin", "category": "attribute_error" },
    { "rule_id": "import_error", "source": "builtin", "category": "import_error" },
    { "rule_id": "assertion_mismatch", "source": "builtin", "category": "assertion_mismatch" },
    { "rule_id": "type_error", "source": "builtin", "category": "type_error" },
    { "rule_id": "syntax_error", "source": "builtin", "category": "syntax_error" },
    { "rule_id": "index_error", "source": "builtin", "category": "index_error" },
    { "rule_id": "lint_violation", "source": "builtin", "category": "lint_violation" },
    { "rule_id": "timeout", "source": "builtin", "category": "timeout" },
    { "rule_id": "permission_error", "source": "builtin", "category": "permission_error" },
    { "rule_id": "connection_error", "source": "builtin", "category": "connection_error" }
  ],
  "total": 13
}
```

The resolved failure created a learned rule (confidence 1.0) alongside the 12 builtin templates.

## Step 6: Full evidence synthesis

```
$ failsafe explain fail_iEOgRTzv6XwK
```

```json
{
  "failure_id": "fail_iEOgRTzv6XwK",
  "summary": "Assertion failed in TestCreateUserFromOAuth::test_gitlab_login",
  "evidence": [
    "Test failed: TestCreateUserFromOAuth::test_gitlab_login",
    "tests/e2e/pytest_project/tests/test_auth.py: Test: TestCreateUserFromOAuth::test_gitlab_login"
  ],
  "fix_options": [
    {
      "title": "Fix the code to produce expected output",
      "risk": "medium",
      "files": ["tests/e2e/pytest_project/tests/test_auth.py"],
      "rationale": "Code behavior doesn't match test expectations"
    },
    {
      "title": "Update test expectations",
      "risk": "medium",
      "files": ["tests/e2e/pytest_project/tests/test_auth.py"],
      "rationale": "Test expectations may be outdated"
    }
  ],
  "recommended_fix": "Fix the code to produce expected output",
  "verify": { "command": "failsafe verify fail_iEOgRTzv6XwK" }
}
```

## Token Savings Summary

| Step | Raw bytes | Returned bytes | Compression | Tokens saved |
|------|-----------|----------------|-------------|--------------|
| run | 9231 | 701 | 13.2x | 2132 |
| diagnose | 9231 | 3971 | 2.3x | 1315 |

Without Failsafe, the agent would consume ~2300 tokens of raw pytest output. With Failsafe, it gets a structured 176-token packet from `run` and can progressively request more detail via `diagnose` (993 tokens with source context).
