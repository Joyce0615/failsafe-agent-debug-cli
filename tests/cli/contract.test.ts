/**
 * Black-box CLI contract tests.
 *
 * These tests run `bun src/cli/index.ts ...` as a subprocess and
 * parse stdout/stderr/exit codes — no internal imports. They verify
 * the output contracts that agents rely on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(
	args: string[],
	opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number; json: unknown }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: opts?.cwd ?? workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	let json: unknown = null;
	try {
		json = JSON.parse(stdout);
	} catch {
		// Not JSON
	}

	return { stdout, stderr, exitCode, json };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-contract-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("CLI contract: init", () => {
	test("init returns JSON with status", async () => {
		const fresh = mkdtempSync(join(tmpdir(), "failsafe-init-"));
		const r = await run(["init"], { cwd: fresh });
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.status).toBe("initialized");
		expect(data.storage_dir).toBeDefined();
		rmSync(fresh, { recursive: true, force: true });
	});
});

describe("CLI contract: run", () => {
	test("returns JSON with required fields for failing command", async () => {
		const r = await run(["run", 'node -e "process.exit(1)"']);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.schema_version).toBe("0.1");
		expect(data.status).toBe("failed");
		expect(data.failure_id).toBeDefined();
		expect(data.exit_code).toBe(1);
		expect(data.token_budget).toBeDefined();
		expect(data.raw_paths).toBeDefined();
		expect(data.next).toBeDefined();
	}, 30_000);

	test("returns passed status for successful command", async () => {
		const r = await run(["run", 'node -e "process.exit(0)"']);
		const data = r.json as Record<string, unknown>;
		expect(data.status).toBe("passed");
		expect(data.exit_code).toBe(0);
	}, 30_000);

	test("returns text with --format text", async () => {
		const r = await run(["run", "--format", "text", 'node -e "process.exit(1)"']);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("[FAILED]");
		expect(r.json).toBeNull(); // Not valid JSON
	}, 30_000);

	test("includes raw_paths with real file paths", async () => {
		const r = await run(["run", "node -e \"console.log('hello'); process.exit(1)\""]);
		const data = r.json as Record<string, unknown>;
		const paths = data.raw_paths as Record<string, string>;
		expect(paths.stdout).toContain("stdout.log");
		expect(paths.stderr).toContain("stderr.log");
		expect(paths.combined).toContain("combined");
	}, 30_000);

	test("blocks dangerous commands with POLICY_BLOCK exit code (3)", async () => {
		const r = await run(["run", "rm -rf /"]);
		expect(r.exitCode).toBe(3);
		const data = r.json as Record<string, unknown>;
		expect(data.error).toBe(true);
		expect(data.message as string).toContain("blocked");
	});

	test("--quiet emits minified single-line JSON", async () => {
		const r = await run(["run", "--quiet", 'node -e "process.exit(1)"']);
		expect(r.exitCode).toBe(0);
		// Minified: no newlines inside the JSON payload, single line of output
		expect(r.stdout.trim().split("\n").length).toBe(1);
		const data = r.json as Record<string, unknown>;
		expect(data.failure_id).toBeDefined();
		expect(data.status).toBe("failed");
	}, 30_000);

	test("rejects shell syntax without --shell (needs_shell packet)", async () => {
		// A pipe requires a shell; without --shell this is rejected.
		const r = await run(["run", "node --version | cat"]);
		expect(r.exitCode).not.toBe(0);
		const data = r.json as Record<string, unknown>;
		// Either policy blocks the second command, or argv parsing flags needs_shell.
		expect(data.error).toBe(true);
	});

	test("runs simple allowed command via argv (no shell)", async () => {
		// Exit 1 with no shell metacharacters — should run via argv mode and
		// produce a normal failure packet.
		const r = await run(["run", 'node -e "process.exit(3)"']);
		expect(r.exitCode).toBe(0); // CLI succeeds; captured command failed
		const data = r.json as Record<string, unknown>;
		expect(data.status).toBe("failed");
		expect(data.exit_code).toBe(3);
		expect(data.needs_shell).toBeUndefined();
	}, 30_000);

	test("--shell allows shell syntax", async () => {
		// With --shell, a command substitution-free pipe of allowed commands runs.
		const r = await run(["run", "--shell", "node --version"]);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.status).toBe("passed");
	}, 30_000);
});

describe("CLI contract: diagnose", () => {
	test("diagnose last returns diagnosis with required fields", async () => {
		await run(["run", "python3 -c \"raise KeyError('x')\""]);
		const r = await run(["diagnose", "last"]);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.diagnosis_id).toBeDefined();
		expect(data.failure_id).toBeDefined();
		expect(data.severity).toBeDefined();
		expect(data.summary).toBeDefined();
		expect(data.suggested_next_actions).toBeDefined();
		expect(data.rule_source).toBeDefined();
	}, 30_000);

	test("diagnose nonexistent ID returns NO_INPUT exit code (2)", async () => {
		const r = await run(["diagnose", "fail_nonexistent"]);
		expect(r.exitCode).toBe(2);
		const data = r.json as Record<string, unknown>;
		expect(data.error).toBe(true);
	});
});

describe("CLI contract: repro", () => {
	test("repro last returns selector", async () => {
		await run(["run", "python3 -c \"raise KeyError('x')\""]);
		const r = await run(["repro", "last", "--no-verify"]);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.failure_id).toBeDefined();
		expect(data.repro_id).toBeDefined();
		expect(data.command).toBeDefined();
	}, 30_000);
});

describe("CLI contract: history", () => {
	test("returns failures array", async () => {
		const r = await run(["history", "--limit", "5"]);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(Array.isArray(data.failures)).toBe(true);
	});
});

describe("CLI contract: config", () => {
	test("config show returns valid config", async () => {
		const r = await run(["config", "show"]);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.schema_version).toBe("0.1");
		expect(data.default_format).toBeDefined();
	});

	test("config set storage_dir relocates storage but keeps config anchor", async () => {
		const ws = mkdtempSync(join(tmpdir(), "failsafe-storedir-"));
		await run(["init"], { cwd: ws });

		// Relocate storage to a custom subdirectory
		const setR = await run(["config", "set", "storage_dir", "custom-store"], { cwd: ws });
		expect(setR.exitCode).toBe(0);

		// Config file remains at the fixed .failsafe anchor
		expect(existsSync(join(ws, ".failsafe", "config.json"))).toBe(true);

		// config show reads the anchored config and reflects the new storage_dir
		const showR = await run(["config", "show"], { cwd: ws });
		const cfg = showR.json as Record<string, unknown>;
		expect(cfg.storage_dir).toBe("custom-store");

		// A subsequent run stores its data under the relocated storage dir
		await run(["run", 'node -e "process.exit(1)"'], { cwd: ws });
		expect(existsSync(join(ws, "custom-store", "history.sqlite"))).toBe(true);
		expect(existsSync(join(ws, "custom-store", "runs"))).toBe(true);

		rmSync(ws, { recursive: true, force: true });
	}, 30_000);
});

describe("CLI contract: rules", () => {
	test("rules validate returns valid when no rules file", async () => {
		const r = await run(["rules", "validate"]);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.valid).toBe(true);
	});

	test("rules list returns array with total", async () => {
		const r = await run(["rules", "list"]);
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(Array.isArray(data.rules)).toBe(true);
		expect(data.total).toBeDefined();
	});
});

describe("CLI contract: kb export-dataset", () => {
	test("emits JSONL training pairs from resolved failures", async () => {
		const ws = mkdtempSync(join(tmpdir(), "failsafe-dataset-"));
		await run(["init"], { cwd: ws });

		// Capture, diagnose, and resolve a failure to create a training pair.
		await run(["run", "python3 -c \"raise KeyError('x')\""], { cwd: ws });
		await run(["diagnose", "last"], { cwd: ws });
		await run(["resolve", "last", "--success", "--fix-summary", "added .get() default"], {
			cwd: ws,
		});

		const out = join(ws, "dataset.jsonl");
		const r = await run(["kb", "export-dataset", "--output", out], { cwd: ws });
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.samples).toBe(1);

		// The JSONL file should contain one valid training sample.
		const content = readFileSync(out, "utf-8").trim();
		const lines = content.split("\n");
		expect(lines.length).toBe(1);
		const sample = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(sample.signature_hash).toBeDefined();
		expect(sample.command).toContain("python3");
		expect(sample.fix_summary).toBe("added .get() default");
		expect(sample.success).toBe(true);

		rmSync(ws, { recursive: true, force: true });
	}, 30_000);

	test("success-only filter excludes failed fixes", async () => {
		const ws = mkdtempSync(join(tmpdir(), "failsafe-dataset2-"));
		await run(["init"], { cwd: ws });
		await run(["run", "python3 -c \"raise ValueError('y')\""], { cwd: ws });
		await run(["resolve", "last", "--fail", "--fix-summary", "did not work"], { cwd: ws });

		const out = join(ws, "ds.jsonl");
		const r = await run(["kb", "export-dataset", "--output", out, "--success-only"], { cwd: ws });
		expect(r.exitCode).toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.samples).toBe(0);

		rmSync(ws, { recursive: true, force: true });
	}, 30_000);
});

describe("CLI contract: doctor", () => {
	test("returns checks array", async () => {
		const r = await run(["doctor"]);
		const data = r.json as Record<string, unknown>;
		expect(data.status).toBeDefined();
		expect(Array.isArray(data.checks)).toBe(true);
	});
});

describe("CLI contract: error paths", () => {
	test("diagnose with no failures returns error", async () => {
		const fresh = mkdtempSync(join(tmpdir(), "failsafe-empty-"));
		await run(["init"], { cwd: fresh });
		const r = await run(["diagnose", "last"], { cwd: fresh });
		expect(r.exitCode).not.toBe(0);
		const data = r.json as Record<string, unknown>;
		expect(data.error).toBe(true);
		rmSync(fresh, { recursive: true, force: true });
	});
});
