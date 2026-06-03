# E2E Fixtures

End-to-end tests run Failsafe against two deliberately-broken fixture projects:

- `pytest_project/` — Python project with 6 bugs across 3 source files (KeyError, AttributeError, AssertionError, ZeroDivisionError). Requires `pytest` on PATH.
- `node_project/` — Node.js project with 2 bugs (undefined property access), tested via Jest. Requires its `node_modules` to be installed.

## Setup

The Node fixture's `node_modules/` is gitignored and not committed, so install it before running e2e tests:

```bash
bun run setup:fixtures
```

`bun run test:e2e` runs this automatically. The committed `tests/e2e/node_project/bun.lock` pins fixture dependency versions for reproducible installs.

The pytest fixture needs `pytest` available:

```bash
pip install pytest          # or: pip install --break-system-packages pytest
```

## Running

```bash
bun run test:e2e            # installs Node fixture, then runs e2e tests
```

If the Node fixture is not installed, the Jest-based e2e tests are skipped (not failed), so the suite still runs cleanly on a partial setup.

## Why these are not auto-discovered by `bun test`

- Fixture test files use the `.fixture-test.js` suffix so Bun's default test discovery (`*.test.ts`) ignores them — they are exercised only through Failsafe's `runCommand`, never run directly as the repo's own tests.
- `bun run test` targets `tests/` and includes the e2e harness (`failsafe-e2e.test.ts`), which calls Failsafe internals against the fixtures.
