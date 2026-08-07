/**
 * `failsafe verify --flaky-check N` end-to-end (item 33).
 *
 * Runs a real command that alternates pass/fail on disk and asserts the rerun
 * evidence is captured, persisted, and authoritative over the history
 * heuristic — plus the deterministic-failure branch that REFUTES flakiness.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCommand, verifyFailure } from "../../src/core/operations.js";
import { checkFlaky } from "../../src/rules/flaky.js";
import { computeSignatureHash } from "../../src/rules/learned.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

let dir: string;
let store: FailsafeStore;
const config = DEFAULT_CONFIG;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "failsafe-flakycheck-"));
	store = new FailsafeStore(config, dir);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function signatureOf(failureId: string): string {
	const failure = store.getFailure(failureId);
	if (!failure) throw new Error("failure not stored");
	return computeSignatureHash(
		failure.parsed.flatMap((p) => p.errors),
		failure.primary_location,
	);
}

describe("verify --flaky-check", () => {
	test("a genuinely alternating command is confirmed flaky by reruns", async () => {
		// Flips a counter file each run: fail, pass, fail, pass...
		const counter = join(dir, "counter.txt");
		writeFileSync(counter, "0");
		const script = join(dir, "alternating.js");
		writeFileSync(
			script,
			`const fs = require("fs");
const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
if (n % 2 === 1) { console.error("Error: transient failure " + n); process.exit(1); }
`,
		);

		const run = await analyzeCommand(`node ${script}`, config, store);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		const id = run.data.failure_id as string;
		const hash = signatureOf(id);

		// No rerun evidence yet, and no prior fix -> heuristic says not flaky.
		expect(checkFlaky(store, hash, 3)).toBe(false);

		const verify = await verifyFailure(id, store, config, { flakyCheckRuns: 4 });
		expect(verify.ok).toBe(true);
		if (!verify.ok) return;

		const check = verify.data.flaky_check as Record<string, unknown>;
		expect(check.verdict).toBe("flaky");
		expect(check.confirmed_flaky).toBe(true);
		expect(check.runs).toBe(4);
		expect(check.passed as number).toBeGreaterThan(0);
		expect(check.failed as number).toBeGreaterThan(0);

		// Evidence is persisted and now drives checkFlaky.
		const record = store.getFlakySignature(hash);
		expect(record?.rerun_confirmed).toBe(true);
		expect(record?.rerun_total).toBe(4);
		expect(checkFlaky(store, hash, 3)).toBe(true);
	}, 60_000);

	test("a consistently failing command is refuted regardless of recurrence", async () => {
		const run = await analyzeCommand(
			"node -e \"console.error('Error: always'); process.exit(1)\"",
			config,
			store,
		);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		const id = run.data.failure_id as string;
		const hash = signatureOf(id);

		const verify = await verifyFailure(id, store, config, { flakyCheckRuns: 3 });
		expect(verify.ok).toBe(true);
		if (!verify.ok) return;

		const check = verify.data.flaky_check as Record<string, unknown>;
		expect(check.verdict).toBe("deterministic_failure");
		expect(check.confirmed_flaky).toBe(false);
		expect(check.failed).toBe(3);

		// Even though the signature keeps recurring, the rerun evidence refutes
		// flakiness, so the diagnosis is not confidence-capped.
		const record = store.getFlakySignature(hash);
		expect(record?.rerun_confirmed).toBe(false);
		expect(checkFlaky(store, hash, 1)).toBe(false);
	}, 60_000);

	test("the check is opt-in and absent by default", async () => {
		const run = await analyzeCommand('node -e "process.exit(1)"', config, store);
		if (!run.ok) throw new Error("setup failed");
		const verify = await verifyFailure(run.data.failure_id as string, store, config);
		expect(verify.ok).toBe(true);
		if (verify.ok) expect(verify.data.flaky_check).toBeUndefined();
	}, 30_000);
});
