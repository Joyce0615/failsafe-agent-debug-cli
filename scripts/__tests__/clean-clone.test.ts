/**
 * Clean-clone quality gate (item 1 — "Restore a clean-clone quality gate.
 * Pin typecheck/lint/unit/E2E/build tooling and report stable counts without
 * generated-tree drift").
 *
 * Two concrete gaps found by auditing the actual repo state (not assumed):
 *
 * 1. `@types/bun` was declared as `"latest"` in package.json. Every other
 *    tool this repo's quality gate depends on (biome, typescript, the DAP
 *    types) is pinned to a concrete version or caret range; `"latest"`
 *    re-resolves to whatever exists on the registry *at install time*, so a
 *    machine that runs `bun install` without `--frozen-lockfile` (a fresh
 *    clone commonly does not pass that flag unless told to) can silently
 *    pick up a newer `@types/bun` than the one the lockfile — and therefore
 *    every other contributor and CI run — actually used, and `bun run
 *    typecheck` can start failing for a reason with nothing to do with the
 *    source change that triggered it. This is exactly "stale declarations"
 *    (a declared range that no longer reflects what's actually pinned/used)
 *    producing tooling drift on a clean clone.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function readPackageJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
}

function unpinnedRanges(pkg: Record<string, unknown>): string[] {
  const offenders: string[] = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (range === "latest" || range === "*") {
        offenders.push(`${section}.${name} = ${range}`);
      }
    }
  }
  return offenders;
}

describe("clean-clone tooling pins", () => {
  test("root package.json declares no 'latest' or unbounded dependency range", () => {
    const pkg = readPackageJson("package.json");
    const offenders = unpinnedRanges(pkg);
    expect(offenders).toEqual([]);
  });

});
