# Changelog

All notable changes to Failsafe are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-15

First tagged baseline. Failsafe is an agent-first debugging CLI (`failsafe`) and
MCP server (`failsafe-mcp`) that runs a command, captures the failure, and
compresses noisy output into compact structured JSON packets so a coding agent
spends fewer tokens per `failure → diagnose → repro → verify` loop.

### Added

- **Capture & parsing** — `failsafe run <cmd>` captures stdout/stderr to
  `.failsafe/runs/<id>/` and returns a compact packet (summary, primary
  location, test summary, `next`, `token_budget`). 14 language parsers (pytest,
  jest, vitest, mocha, tsc, eslint, biome, go, rust, java, ruby, cpp,
  python-traceback, js-stack) with multi-language primary-location ranking.
- **Diagnosis** — `failsafe diagnose <id|last>` root-cause hypotheses with
  evidence, confidence, minimal source context, a signature-hash cache, and
  flaky downgrade.
- **Repro & verify** — `failsafe repro <id>` extracts a minimal single-test
  selector; `failsafe verify <id>` re-runs the repro + original command to
  confirm a fix.
- **Tiered rules** — declared (`.failsafe/rules.yaml`) → learned (KB,
  auto-promoted) → built-in templates, with conflict-aware precedence and
  declared-rule hot-reload. `failsafe apply <id>` applies a declared rule's
  validated `fix_patch`.
- **Knowledge base** — `failsafe resolve`, `failsafe kb export/import/
  export-dataset`, `failsafe rules …`, plus an offline diagnosis-classifier
  eval harness (`kb classify-eval`).
- **Interactive debug (launch guidance)** — `failsafe debug <id>` emits a
  ready-to-run command + breakpoint. Python via `debugpy` and Node.js via the
  built-in V8 inspector (`node --inspect-brk`); other runtimes return a
  structured `unsupported_runtime` packet.
- **Security** — secret redaction (17 patterns incl. DB connection-string
  credentials) + policy enforcement applied before any output/storage, audited
  end-to-end across packets, on-disk logs, diagnosis, and OTel spans.
- **MCP server** — `failsafe-mcp` (stdio) exposes `failsafe_analyze`/`_diagnose`/
  `_repro`/`_verify` tools plus two resources and a prompt, sharing
  `src/core/operations.ts` with the CLI so contracts cannot diverge.
- **Output & telemetry** — token-budgeted JSON by default (`--format text`,
  `--max-bytes`, `--quiet`); opt-in OpenTelemetry OTLP spans.
- **CI plugin** — `failsafe ci` renders GitHub Actions annotations; composite
  action in `ci/action.yml`.
- **Tooling** — SQLite failure history, `failsafe doctor`/`config`/`init`,
  latency benchmark harness, cross-platform path normalization, npm publish
  build (`scripts/build.ts`), and `clean`/`package` Daily-Routine scripts.

[0.1.0]: https://github.com/anthropics/failsafe/releases/tag/v0.1.0
