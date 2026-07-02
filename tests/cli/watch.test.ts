/**
 * `failsafe watch` core tests.
 *
 * Drives the testable `runWatchCycle` against a real temp workspace + store,
 * asserting the compact per-cycle packet shape (passing, failing-with-diagnosis,
 * and the needs_shell rejection branch). A separate `watchLoop` test confirms
 * the debounced fs-watch re-runs on a file change. `runWatchCycle` runs the
 * command in `process.cwd()`, so each test pins cwd to its temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { type WatchPacket, runWatchCycle, watchLoop } from "../../src/cli/watch.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { DEFAULT_CONFIG, type FailsafeConfig } from "../../src/types/config.js";

let workDir: string;
let store: FailsafeStore;
let config: FailsafeConfig;
let originalCwd: string;

beforeEach(() => {
	originalCwd = process.cwd();
	workDir = mkdtempSync(join(tmpdir(), "failsafe-watch-"));
	config = { ...DEFAULT_CONFIG, storage_dir: join(workDir, ".failsafe") };
	store = new FailsafeStore(config, workDir);
	process.chdir(workDir);
	writeFileSync(join(workDir, "pass.js"), "process.exit(0);\n");
	writeFileSync(join(workDir, "fail.js"), 'throw new Error("boom");\n');
});

afterEach(() => {
	process.chdir(originalCwd);
	store.close();
	rmSync(workDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runWatchCycle", () => {
	test("a passing run emits a compact packet with no diagnosis", async () => {
		const packet = await runWatchCycle("node pass.js", config, store, 5);

		expect(packet.event).toBe("result");
		expect(packet.cycle).toBe(5);
		expect(packet.status).toBe("passed");
		expect(packet.exit_code).toBe(0);
		expect(packet.failure_id).toBeDefined();
		// No root-cause packet is produced for a passing edit.
		expect(packet.diagnosis).toBeUndefined();
		expect(packet.error).toBeUndefined();
	});

	test("a failing run carries a diagnosis and next actions", async () => {
		const packet = await runWatchCycle("node fail.js", config, store, 1);

		expect(packet.cycle).toBe(1);
		expect(packet.status).toBe("failed");
		expect(packet.exit_code).not.toBe(0);
		expect(packet.failure_id).toBeDefined();
		expect(packet.diagnosis).toBeDefined();
		expect(packet.diagnosis?.severity).toBeDefined();
		expect(Array.isArray(packet.next)).toBe(true);
	});

	test("a command needing a shell is rejected (status error, no run)", async () => {
		const packet = await runWatchCycle("node pass.js > out.txt", config, store, 2);

		expect(packet.status).toBe("error");
		expect(packet.error).toBe(true);
		expect(packet.exit_code).toBe(ExitCode.ERROR);
		expect(packet.failure_id).toBeUndefined();
	});
});

describe("watchLoop", () => {
	test("runs an initial cycle and re-runs on a file change", async () => {
		const packets: WatchPacket[] = [];
		const watcher = watchLoop("node pass.js", config, store, {
			cwd: workDir,
			debounceMs: 50,
			onCycle: (p) => packets.push(p),
		});

		try {
			// Wait for the initial cycle to land.
			for (let i = 0; i < 40 && packets.length < 1; i++) await sleep(50);
			expect(packets.length).toBeGreaterThanOrEqual(1);
			expect(packets[0].cycle).toBe(1);

			// A change to a watched file triggers another (debounced) cycle.
			const before = packets.length;
			writeFileSync(join(workDir, "trigger.txt"), `${Date.now()}`);
			for (let i = 0; i < 40 && packets.length <= before; i++) await sleep(50);
			expect(packets.length).toBeGreaterThan(before);
			// Cycle counter is monotonic across runs.
			expect(packets[packets.length - 1].cycle).toBeGreaterThan(packets[0].cycle);
		} finally {
			watcher.close();
			// Let any in-flight cycle settle before afterEach closes the store.
			await watcher.drain();
		}
	});
});
