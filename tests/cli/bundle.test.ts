/**
 * `failsafe bundle` lineage tests (item 4 — "Correlate logs, traces, tools,
 * subprocesses, and file diffs. Stable IDs and lineage must survive
 * export/import.").
 *
 * `bundle export`'s whole point is that the SAME recurring bug — exported from
 * two different runs, possibly two different workspaces — is recognizable as
 * the same bug on import: `bundleFingerprint` dedupes by `failure.signature_hash`
 * (plus category/repair summary), and `importBundles`' corroboration count is
 * keyed on that exact fingerprint. That promise only holds if `signature_hash`
 * is actually the *stable* signature every other command in this CLI computes
 * via `computeSignatureHash` (same error shape -> same hash, independent of
 * which run produced it) — see `resolve.ts`, `kb.ts`, `rules.ts`, all of which
 * use `computeSignatureHash`.
 *
 * `bundle export` instead sets `failure.signature_hash` to the raw
 * `failure.failure_id` — the random per-run nanoid minted by `failureId()`
 * (`utils/id.ts`), unique on every single `failsafe run` even when the
 * underlying bug is identical. Two bundles from two runs of the literal same
 * failing command get two different `signature_hash` values, two different
 * `bundleFingerprint`s, and therefore: no dedup, no corroboration credit, and
 * no way for an importer to recognize "I've seen this exact bug before" —
 * exactly the lineage-survives-export/import guarantee this item requires.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;
let consentFile: string;

async function run(
	args: string[],
	env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; json: Record<string, unknown> }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(stdout);
	} catch {}
	return { exitCode, json };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-bundle-lineage-"));
	consentFile = join(workDir, "consent.json");
	writeFileSync(
		consentFile,
		JSON.stringify({
			granted: true,
			scope: ["failure"],
			grantor: "team-a",
			granted_at: "2026-01-01T00:00:00.000Z",
		}),
	);
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

const SAME_BUG_COMMAND = "node -e \"throw new Error('boom one')\"";
const BUNDLE_ENV = { FAILSAFE_BUNDLE_KEY: "test-signing-key" };

describe("failsafe bundle export — stable lineage across runs", () => {
	test("the same recurring bug exported from two separate runs gets the same signature_hash", async () => {
		const first = await run(["run", SAME_BUG_COMMAND]);
		const second = await run(["run", SAME_BUG_COMMAND]);
		const firstId = first.json.failure_id as string;
		const secondId = second.json.failure_id as string;
		expect(firstId).toBeDefined();
		expect(secondId).toBeDefined();
		// Sanity: these are genuinely two distinct failure records (not a cache
		// hit), so a matching signature_hash below is lineage, not an accident.
		expect(firstId).not.toBe(secondId);

		const firstBundle = await run(
			["bundle", "export", firstId, "--consent", consentFile],
			BUNDLE_ENV,
		);
		const secondBundle = await run(
			["bundle", "export", secondId, "--consent", consentFile],
			BUNDLE_ENV,
		);

		const firstHash = (firstBundle.json.failure as Record<string, unknown>)?.signature_hash;
		const secondHash = (secondBundle.json.failure as Record<string, unknown>)?.signature_hash;

		// The real bug: today these come out as `firstId`/`secondId` themselves
		// (the random per-run failure id), so this assertion fails before the
		// fix and passes after it.
		expect(firstHash).toBe(secondHash);
		// And neither should just be the random failure id in disguise.
		expect(firstHash).not.toBe(firstId);
		expect(secondHash).not.toBe(secondId);
	}, 30_000);

	test("two unrelated bugs still get two different signature_hash values", async () => {
		const a = await run(["run", "node -e \"throw new Error('bug A')\""]);
		const b = await run(["run", "node -e \"throw new TypeError('bug B')\""]);

		const bundleA = await run(
			["bundle", "export", a.json.failure_id as string, "--consent", consentFile],
			BUNDLE_ENV,
		);
		const bundleB = await run(
			["bundle", "export", b.json.failure_id as string, "--consent", consentFile],
			BUNDLE_ENV,
		);

		const hashA = (bundleA.json.failure as Record<string, unknown>)?.signature_hash;
		const hashB = (bundleB.json.failure as Record<string, unknown>)?.signature_hash;
		expect(hashA).not.toBe(hashB);
	}, 30_000);
});
