#!/usr/bin/env bun
/**
 * Produce a release tarball of the repo, excluding dependencies, build output,
 * version control, run/storage data, and caches so the archive is reproducible
 * and free of generated artifacts.
 *
 * Excludes: any `node_modules/`, `.git/`, `dist/`, `.failsafe/`, `.pytest_cache/`,
 * and stray `*.tar.gz` / `*.log` files.
 *
 * Usage:
 *   bun scripts/package.ts [outFile]          # default: ~/GitHub/failsafe.tar.gz
 */
import { basename, dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function defaultOutFile(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
	return join(home, "GitHub", "failsafe.tar.gz");
}

/**
 * Tar `root` into `outFile`, excluding generated artifacts. Returns the output
 * path and the list of tar excludes applied.
 */
export async function packageRepo(
	opts: { root?: string; outFile?: string } = {},
): Promise<{ outFile: string; excludes: string[] }> {
	const root = opts.root ?? REPO_ROOT;
	const outFile = opts.outFile ?? defaultOutFile();
	const parent = dirname(root);
	const base = basename(root);

	const excludes = [
		"*/node_modules",
		`${base}/.git`,
		`${base}/dist`,
		`${base}/.failsafe`,
		`${base}/.pytest_cache`,
		// Benchmark corpora and sweep results (item 39) are large, machine- and
		// dataset-specific, and must never ship in a release tar.
		`${base}/bench-data`,
		`${base}/bench-results`,
		"*.bench.jsonl",
		"*.tar.gz",
		"*.log",
	];

	const args = [
		"tar",
		...excludes.flatMap((e) => [`--exclude=${e}`]),
		"-czf",
		outFile,
		"-C",
		parent,
		base,
	];

	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	await proc.exited;
	if (proc.exitCode !== 0) {
		const err = await new Response(proc.stderr).text();
		throw new Error(`tar failed (exit ${proc.exitCode}): ${err}`);
	}

	return { outFile, excludes };
}

if (import.meta.main) {
	const outFile = process.argv[2];
	const { outFile: written } = await packageRepo(outFile ? { outFile } : {});
	console.log(`package: wrote ${written}`);
}
