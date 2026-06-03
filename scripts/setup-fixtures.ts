#!/usr/bin/env bun
/**
 * Set up e2e fixture projects so `bun run test:e2e` works on a fresh checkout.
 *
 * Fixture `node_modules/` are gitignored (not committed), so the Node fixture
 * needs its dependencies installed before the Jest-based e2e tests can run.
 * The committed `bun.lock` pins versions for reproducible installs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const NODE_FIXTURE = join(ROOT, "tests/e2e/node_project");

async function installNodeFixture(): Promise<void> {
	const jestBin = join(NODE_FIXTURE, "node_modules/.bin/jest");
	if (existsSync(jestBin)) {
		console.log("[setup-fixtures] Node fixture already installed.");
		return;
	}

	console.log("[setup-fixtures] Installing Node fixture dependencies (bun install)...");
	const proc = Bun.spawn(["bun", "install"], {
		cwd: NODE_FIXTURE,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) {
		console.error("[setup-fixtures] Node fixture install failed.");
		process.exit(code);
	}
	console.log("[setup-fixtures] Node fixture ready.");
}

await installNodeFixture();
console.log("[setup-fixtures] Done.");
