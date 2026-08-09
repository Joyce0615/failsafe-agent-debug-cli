/**
 * Smoke tests for the `clean` + `package` Daily-Routine scripts (item 2).
 *
 * Both run against a throwaway fake tree so the real working copy is never
 * mutated: `clean` must strip `.failsafe/`, `runs/`, and fixture `node_modules/`
 * while leaving source, and the `package` tarball must contain none of the
 * excluded paths but keep source files.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean } from "../../scripts/clean.js";
import { packageRepo } from "../../scripts/package.js";

/** Build a fake repo tree seeded with both source and generated artifacts. */
function seedFakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "failsafe-clean-"));
	// Source that must survive.
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
	writeFileSync(join(root, "package.json"), '{"name":"fake"}\n');
	// Artifacts that must be removed / excluded.
	mkdirSync(join(root, ".failsafe", "runs", "run_1"), { recursive: true });
	writeFileSync(join(root, ".failsafe", "runs", "run_1", "stderr.log"), "boom\n");
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "dist", "index.js"), "//built\n");
	mkdirSync(join(root, "runs"), { recursive: true });
	mkdirSync(join(root, ".pytest_cache"), { recursive: true });
	mkdirSync(join(root, "tests", "e2e", "node_project", "node_modules", "left-pad"), {
		recursive: true,
	});
	writeFileSync(join(root, "tests", "e2e", "node_project", "package.json"), "{}\n");
	writeFileSync(join(root, "debug.log"), "log\n");
	// Benchmark corpora + sweep results (item 39): never cleaned into a release.
	mkdirSync(join(root, "bench-data"), { recursive: true });
	writeFileSync(join(root, "bench-data", "swe-bench.json"), "[]\n");
	mkdirSync(join(root, "bench-results"), { recursive: true });
	writeFileSync(join(root, "bench-results", "run.jsonl"), "{}\n");
	writeFileSync(join(root, "sweep.bench.jsonl"), "{}\n");
	return root;
}

describe("clean script", () => {
	test("removes artifacts and fixture node_modules but keeps source", () => {
		const root = seedFakeRepo();
		try {
			const removed = clean(root);

			// Artifacts gone.
			expect(existsSync(join(root, ".failsafe"))).toBe(false);
			expect(existsSync(join(root, "runs"))).toBe(false);
			expect(existsSync(join(root, "dist"))).toBe(false);
			expect(existsSync(join(root, ".pytest_cache"))).toBe(false);
			expect(existsSync(join(root, "tests", "e2e", "node_project", "node_modules"))).toBe(false);
			expect(existsSync(join(root, "debug.log"))).toBe(false);
			expect(existsSync(join(root, "bench-data"))).toBe(false);
			expect(existsSync(join(root, "bench-results"))).toBe(false);

			// Source + fixture manifest preserved.
			expect(existsSync(join(root, "src", "index.ts"))).toBe(true);
			expect(existsSync(join(root, "tests", "e2e", "node_project", "package.json"))).toBe(true);

			expect(removed).toContain(".failsafe");
			expect(removed).toContain(join("tests", "e2e", "node_project", "node_modules"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("is a no-op on an already-clean tree", () => {
		const root = mkdtempSync(join(tmpdir(), "failsafe-clean-empty-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			expect(clean(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("package script", () => {
	test("produces a tarball with source but none of the excluded paths", async () => {
		const root = seedFakeRepo();
		const outDir = mkdtempSync(join(tmpdir(), "failsafe-pkg-"));
		const outFile = join(outDir, "fake.tar.gz");
		try {
			const { outFile: written } = await packageRepo({ root, outFile });
			expect(written).toBe(outFile);
			expect(existsSync(outFile)).toBe(true);

			const proc = Bun.spawn(["tar", "-tzf", outFile], { stdout: "pipe", stderr: "pipe" });
			await proc.exited;
			const listing = await new Response(proc.stdout).text();
			const entries = listing.split("\n").filter(Boolean);

			// Source is present.
			expect(entries.some((e) => e.endsWith("src/index.ts"))).toBe(true);

			// Excluded paths are absent.
			expect(entries.some((e) => e.includes("node_modules"))).toBe(false);
			expect(entries.some((e) => e.includes("/dist/"))).toBe(false);
			expect(entries.some((e) => e.includes("/.failsafe/"))).toBe(false);
			expect(entries.some((e) => e.includes("/.pytest_cache/"))).toBe(false);
			expect(entries.some((e) => e.endsWith(".log"))).toBe(false);
			// Benchmark data/results never ship (item 39).
			expect(entries.some((e) => e.includes("bench-data"))).toBe(false);
			expect(entries.some((e) => e.includes("bench-results"))).toBe(false);
			expect(entries.some((e) => e.endsWith(".bench.jsonl"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
