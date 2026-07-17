import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	analyzeCommand,
	diagnoseFailure,
	explainFailure,
	reproFailure,
	verifyFailure,
} from "../../src/core/operations.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");

let store: FailsafeStore;
let tempDir: string;
const config = DEFAULT_CONFIG;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "failsafe-core-"));
	const cfg = { ...DEFAULT_CONFIG, storage_dir: join(tempDir, ".failsafe") };
	store = new FailsafeStore(cfg, tempDir);
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("analyzeCommand", () => {
	test("captures a failing command and returns a packet", async () => {
		const r = await analyzeCommand('node -e "process.exit(1)"', config, store);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.data.status).toBe("failed");
			expect(r.data.exit_code).toBe(1);
			expect(r.data.failure_id).toBeDefined();
			expect(r.data.token_budget).toBeDefined();
			expect(r.data.raw_paths).toBeDefined();
		}
	}, 30_000);

	test("blocks dangerous commands with POLICY_BLOCK", async () => {
		const r = await analyzeCommand("rm -rf /", config, store);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.exit_code).toBe(3);
			expect(r.error.message).toContain("blocked");
		}
	});

	test("rejects shell syntax without shell mode", async () => {
		const r = await analyzeCommand("node --version | cat", config, store);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			// Either policy blocks 'cat' or argv parsing flags needs_shell
			expect(r.error.error).toBe(true);
		}
	});

	test("redacts secrets in captured output BEFORE writing to disk", async () => {
		const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
		// Build the secret at runtime so the contiguous secret appears only in
		// the captured OUTPUT, not in the command string echoed back (the
		// redaction guarantee covers captured stdout/stderr, not user input).
		const r = await analyzeCommand(
			`node -e "console.error('token=' + 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'); process.exit(1)"`,
			config,
			store,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const id = r.data.failure_id as string;

		// The raw stderr persisted to disk must already be redacted.
		const onDiskStderr = store.getRawOutput(id, "stderr") ?? "";
		expect(onDiskStderr).not.toContain(secret);
		expect(onDiskStderr).toContain("[REDACTED]");
	}, 30_000);

	test("passed command yields passed status", async () => {
		const r = await analyzeCommand('node -e "process.exit(0)"', config, store);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.data.status).toBe("passed");
	}, 30_000);
});

describe("diagnoseFailure", () => {
	test("diagnoses a captured failure by id", async () => {
		const run = await analyzeCommand("python3 -c \"raise KeyError('x')\"", config, store);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		const id = run.data.failure_id as string;

		const diag = await diagnoseFailure(id, store, config);
		expect(diag.ok).toBe(true);
		if (diag.ok) {
			expect(diag.data.failure_id).toBe(id);
			expect(diag.data.diagnosis_id).toBeDefined();
			expect(diag.data.severity).toBeDefined();
		}
	}, 30_000);

	test("returns NO_INPUT for unknown id", async () => {
		const diag = await diagnoseFailure("fail_unknown", store, config);
		expect(diag.ok).toBe(false);
		if (!diag.ok) expect(diag.error.exit_code).toBe(2);
	});

	test("'last' with empty history returns NO_INPUT", async () => {
		const diag = await diagnoseFailure("last", store, config);
		expect(diag.ok).toBe(false);
		if (!diag.ok) expect(diag.error.exit_code).toBe(2);
	});
});

describe("reproFailure", () => {
	test("returns a repro packet for a captured failure", async () => {
		const run = await analyzeCommand("python3 -c \"raise KeyError('x')\"", config, store);
		if (!run.ok) throw new Error("setup failed");
		const id = run.data.failure_id as string;

		const repro = await reproFailure(id, store, { verify: false });
		expect(repro.ok).toBe(true);
		if (repro.ok) {
			expect(repro.data.failure_id).toBe(id);
			expect(repro.data.repro_id).toBeDefined();
			expect(repro.data.command).toBeDefined();
		}
	}, 30_000);
});

describe("verifyFailure", () => {
	test("re-runs the original command and reports checks", async () => {
		const run = await analyzeCommand('node -e "process.exit(1)"', config, store);
		if (!run.ok) throw new Error("setup failed");
		const id = run.data.failure_id as string;

		const verify = await verifyFailure(id, store, config);
		expect(verify.ok).toBe(true);
		if (verify.ok) {
			expect(verify.data.failure_id).toBe(id);
			expect(Array.isArray(verify.data.checks)).toBe(true);
			// The original command still exits 1, so verification fails
			expect(verify.data.status).toBe("failed");
		}
	}, 30_000);
});

describe("explainFailure", () => {
	test("NO_INPUT for unknown id and empty 'last'", () => {
		expect(explainFailure("fail_unknown", store).ok).toBe(false);
		const last = explainFailure("last", store);
		expect(last.ok).toBe(false);
		if (!last.ok) expect(last.error.exit_code).toBe(2);
	});

	test("combined-evidence packet is byte-identical via the CLI and the core function", async () => {
		// Seed failure + diagnosis + repro so explain has evidence and fix_options.
		const run = await analyzeCommand("python3 -c \"raise KeyError('user_id')\"", config, store);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		const id = run.data.failure_id as string;
		await diagnoseFailure(id, store, config);
		await reproFailure(id, store, { verify: false });

		const core = explainFailure(id, store);
		expect(core.ok).toBe(true);
		if (!core.ok) return;

		// Structural checks on the combined-evidence shape.
		expect(core.data.summary).toBeDefined();
		expect(Array.isArray(core.data.evidence)).toBe(true);
		const fixOptions = core.data.fix_options as Array<{ title: string }>;
		expect(fixOptions.length).toBeGreaterThan(0);
		expect(core.data.recommended_fix).toBe(fixOptions[0].title);
		expect(core.data.verify).toEqual({ command: `failsafe verify ${id}` });

		// The CLI reads the SAME storage (cwd=tempDir, default storage_dir=.failsafe)
		// and must emit exactly the core packet — proving explain routes through core.
		const proc = Bun.spawn(["bun", CLI, "explain", id, "--format", "json"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(JSON.parse(out)).toEqual(core.data);
	}, 30_000);
});
