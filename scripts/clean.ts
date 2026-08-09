#!/usr/bin/env bun
/**
 * Remove generated/runtime artifacts from the tree so a release tarball (and a
 * fresh checkout) stays free of run data, caches, and installed fixtures.
 *
 * Removes, relative to the given root (default: repo root):
 *   - `.failsafe/`          (default storage dir: runs, history.sqlite, logs)
 *   - `runs/`               (a stray top-level runs dir, if any)
 *   - `dist/`               (build output)
 *   - `.pytest_cache/`      (stray Python test cache)
 *   - `bench-data/`, `bench-results/`  (benchmark corpora + sweep results)
 *   - `tests/e2e/<x>/node_modules/`  (installed e2e fixtures — gitignored)
 *   - top-level `*.log` files
 *
 * Usage:
 *   bun scripts/clean.ts [root]
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/** Remove the artifact set under `root`. Returns the paths actually removed. */
export function clean(root: string = REPO_ROOT): string[] {
	const removed: string[] = [];

	const removePath = (rel: string): void => {
		const abs = join(root, rel);
		if (existsSync(abs)) {
			rmSync(abs, { recursive: true, force: true });
			removed.push(rel);
		}
	};

	for (const rel of [".failsafe", "runs", "dist", ".pytest_cache", "bench-data", "bench-results"]) {
		removePath(rel);
	}

	// Installed e2e fixtures: tests/e2e/<project>/node_modules
	const e2eDir = join(root, "tests", "e2e");
	if (existsSync(e2eDir)) {
		for (const entry of readdirSync(e2eDir)) {
			const projectNodeModules = join("tests", "e2e", entry, "node_modules");
			if (existsSync(join(root, projectNodeModules))) {
				removePath(projectNodeModules);
			}
		}
	}

	// Top-level *.log files.
	for (const entry of readdirSync(root)) {
		if (entry.endsWith(".log") && statSync(join(root, entry)).isFile()) {
			removePath(entry);
		}
	}

	return removed;
}

if (import.meta.main) {
	const root = process.argv[2] ?? REPO_ROOT;
	const removed = clean(root);
	if (removed.length === 0) {
		console.log("clean: nothing to remove; tree is already clean.");
	} else {
		console.log(`clean: removed ${removed.length} path(s):`);
		for (const r of removed) console.log(`  ${r}`);
	}
}
