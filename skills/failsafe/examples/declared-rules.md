# Example: Declared Rules Override

## Scenario

A team has a convention: division by zero should return 0, not crash. They add a declared rule so Failsafe provides the team-specific fix instead of the generic builtin diagnosis.

## Step 1: Create rules file

```yaml
# .failsafe/rules.yaml
version: "1"
rules:
  - id: "team-zero-division"
    pattern:
      error_contains: "ZeroDivisionError"
    diagnosis:
      category: "math_error"
      explanation: "Division by zero. Our convention is to return 0 for empty inputs."
      fix: "Add a guard: if divisor == 0 or len(values) == 0: return 0"
      enforcement: "auto-fix"
    confidence: 0.95
```

## Step 2: Validate

```bash
failsafe rules validate
```

```json
{ "valid": true, "rules_count": 1, "errors": [] }
```

## Step 3: Run and diagnose

```bash
failsafe run "pytest tests/test_calc.py::test_divide_by_zero -x"
failsafe diagnose last
```

```json
{
  "summary": "Division by zero. Our convention is to return 0 for empty inputs.",
  "root_cause": {
    "category": "math_error",
    "explanation": "Division by zero. Our convention is to return 0 for empty inputs.",
    "confidence": 0.95
  },
  "rule_source": "declared",
  "rule_id": "team-zero-division",
  "enforcement": "auto-fix"
}
```

The declared rule takes priority over the builtin `assertion_mismatch` template. The agent gets the team's specific fix instructions and `enforcement: "auto-fix"` signals it can apply the fix automatically.
