#!/usr/bin/env bun
/**
 * Build the publishable Failsafe bundles.
 *
 * Failsafe runs on the Bun runtime (it uses `Bun.spawn`/`Bun.write` for capture
 * and storage), so this transpiles + bundles the two `bin` entrypoints into
 * `dist/` for the Bun target while keeping declared `dependencies` external
 * (they are installed from `package.json` at consume time). The shebang is
 * preserved so the published binaries stay directly executable.
 *
 *   bun scripts/build.ts        # produces dist/index.js, dist/server.js
 */
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUTDIR = join(ROOT, "dist");

const ENTRYPOINTS = [
	{ in: join(ROOT, "src/cli/index.ts"), out: join(OUTDIR, "index.js") },
	{ in: join(ROOT, "src/mcp/server.ts"), out: join(OUTDIR, "server.js") },
];

rmSync(OUTDIR, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ENTRYPOINTS.map((e) => e.in),
	outdir: OUTDIR,
	target: "bun",
	// Keep node_modules dependencies external — they ship via package.json.
	packages: "external",
	naming: "[name].js",
	// The entrypoints already carry a `#!/usr/bin/env bun` shebang, which Bun
	// preserves on line 1 of each bundle, so no banner is added here.
	sourcemap: "none",
	minify: false,
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	throw new Error("Build failed");
}

// Make the emitted binaries executable so `bin` entries work after install.
for (const e of ENTRYPOINTS) chmodSync(e.out, 0o755);

console.log(`Built ${result.outputs.length} bundle(s) into dist/:`);
for (const out of result.outputs) console.log(`  ${out.path}`);
