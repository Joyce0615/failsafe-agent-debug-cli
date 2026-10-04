# Capture Threat Model

What the capture pipeline protects against, what it does not, and where the
boundary sits. The out-of-scope list is the important half: a threat model that
lists only what a system defends against reads as a claim that nothing else
matters.

## Trust boundaries

```
  command output ──▶ parsers ──▶ redaction ──▶ capture policy ──▶ storage
        │                            │              │                │
        │                            │              │                └─▶ exchange bundle
        │                            │              └─▶ telemetry exporter
        │                            └─▶ data-class policy
        └─▶ the process being debugged is NOT trusted
```

The process under test is untrusted input. Everything it writes to stdout or
stderr is attacker-controlled if the input to that process is.

## In scope

| Threat | Control | Where |
|---|---|---|
| Credentials in command output reaching storage or a span | Pattern-based redaction before any sink | `src/security/redaction.ts` |
| Content reaching a telemetry exporter's buffer | Capture policy evaluated *before* `setAttribute`; single-writer invariant enforced by a source-level test | `src/telemetry/capture-policy.ts`, `src/telemetry/otel.ts` |
| Stack traces and exception messages leaking through span events | Exception events pass the same gate; `exception.message` and `exception.stacktrace` are classified as content and dropped in the default mode | `src/telemetry/genai-schema.ts` |
| PII persisting in a form that identifies a person | Per-class policy: salted pseudonyms, with the `hash` action downgrading to `drop` when no usable salt exists | `src/security/data-classes.ts` |
| Attribute cardinality exploding a metrics backend | Per-key ceilings plus a *product* estimate across keys | `src/telemetry/cardinality.ts` |
| A reproducer or proposed fix reaching the network or the filesystem | Sandbox profiles with network denied by default and an allowlist environment | `src/security/sandbox.ts` |
| A shared diagnostic bundle carrying more than intended | Per-section encryption, signed manifest over *every* section, consent checked at import | `src/exchange/encryption.ts`, `src/exchange/bundle.ts` |
| A consequential remediation running unreviewed | Action-bound, expiring, non-self approvals with a mandatory dry run for irreversible actions | `src/remediation/approval.ts` |
| Cross-tenant data exposure through a forgotten predicate | Unscoped queries are rejected, never defaulted to all tenants | `src/storage/governance.ts` |

## Explicitly out of scope

These are real threats that this pipeline does not address. Each is listed
because a reader who assumes otherwise will be wrong in a specific way.

1. **Secrets with no recognizable shape.** Redaction is pattern-based. A
   credential that is an ordinary-looking string — a 12-character password, an
   internal hostname, a customer name — is not detected and will be captured in
   `redacted-content` mode. The `metadata` default exists because of this.

2. **PII with no reliable pattern.** Personal names, free-text addresses,
   account identifiers, and health or financial narrative cannot be detected.
   `UNDETECTABLE_PII` enumerates them and every audit repeats the list, because
   the most dangerous output a redaction tool produces is a confident zero.

3. **A malicious process attacking the parser.** Parsers are fuzzed
   (`src/testing/fuzz.ts`) for crashes and invariant violations, not for
   resource exhaustion. A process emitting gigabytes of adversarial output will
   be truncated by the byte ceiling but is not otherwise contained.

4. **Key management.** Encryption, signing, and approval all take keys as
   arguments. Distribution, rotation, revocation, and storage are the caller's
   problem, and they are where schemes of this kind actually fail.

5. **A compromised host.** Everything here runs in one process on one machine.
   An attacker with code execution on that machine reads the plaintext before
   any control applies.

6. **Enforcement the platform cannot provide.** Sandbox limits that the OS
   cannot apply are *reported as unenforceable* rather than silently assumed;
   see `assessReadiness`. On a machine without cgroups, the memory and disk
   ceilings are documentation.

7. **Correctness of a diagnosis.** Nothing in this pipeline prevents a wrong
   conclusion. Item 61 requires citations and item 60 requires contradictory
   evidence to be shown; neither makes the conclusion true.

## Defaults and why

| Setting | Default | Reason |
|---|---|---|
| Telemetry capture mode | `metadata` | Deny-by-default: a new attribute is withheld until explicitly classified |
| Sandbox network | `none` | A reproducer whose outcome depended on a remote service is not evidence about local code |
| PII action | `hash`, downgrading to `drop` | An unsalted digest is reversible with a word list and offers the appearance of protection |
| Prompt capture | `drop` | Arbitrary user text with no content signature |
| Approval threshold | `moderate` | Anything with a blast radius requires review; anything irreversible is `severe` |
