/**
 * `failsafe ci` core tests.
 *
 * Drives the testable `runCiCheck` against a real temp workspace + store: a
 * passing run produces no annotations and an OK exit; a failing run fails the
 * CI job (exit ERROR) and renders one annotation from the diagnosis +
 * primary_location; a needs-shell command is a setup error. `renderAnnotation`
 * is covered directly for workflow-command escaping. `runCiCheck` runs the
 * command in `process.cwd()`, so each test pins cwd to its temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CiAnnotation, renderAnnotation, runCiCheck } from "../../src/cli/ci.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { DEFAULT_CONFIG, type FailsafeConfig } from "../../src/types/config.js";

let workDir: string;
let store: FailsafeStore;
let config: FailsafeConfig;
let originalCwd: string;

const CHECK_JS = ['throw new TypeError("greeting mismatch: boom");', ""].join("\n");

beforeEach(() => {
	originalCwd = process.cwd();
	// Resolve through realpath so the stack-trace paths (which macOS reports under
	// /private/var/...) match our relative-to base and produce repo-relative files.
	workDir = realpathSync(mkdtempSync(join(tmpdir(), "failsafe-ci-")));
	config = { ...DEFAULT_CONFIG, storage_dir: join(workDir, ".failsafe") };
	store = new FailsafeStore(config, workDir);
	process.chdir(workDir);
	writeFileSync(join(workDir, "pass.js"), "process.exit(0);\n");
	writeFileSync(join(workDir, "fail.js"), CHECK_JS);
});

afterEach(() => {
	process.chdir(originalCwd);
	store.close();
	rmSync(workDir, { recursive: true, force: true });
});

describe("runCiCheck", () => {
	test("a passing command exits OK with no annotations", async () => {
		const result = await runCiCheck("node pass.js", config, store);

		expect(result.status).toBe("passed");
		expect(result.exit_code).toBe(ExitCode.OK);
		expect(result.annotations).toEqual([]);
	});

	test("a failing command fails the job and annotates the primary location", async () => {
		const result = await runCiCheck("node fail.js", config, store, { relativeTo: workDir });

		expect(result.status).toBe("failed");
		expect(result.exit_code).toBe(ExitCode.ERROR);
		expect(result.annotations).toHaveLength(1);
		const a = result.annotations[0];
		expect(a.level).toBe("error");
		// The absolute primary-location path is made repo-relative.
		expect(a.file).toBe("fail.js");
		expect(a.line).toBeGreaterThan(0);
		expect(a.title).toContain("failsafe");
		expect(a.message.length).toBeGreaterThan(0);
	});

	test("a command needing a shell is a setup error (no run)", async () => {
		const result = await runCiCheck("node pass.js > out.txt", config, store);

		expect(result.status).toBe("error");
		expect(result.exit_code).toBe(ExitCode.ERROR);
		expect(result.annotations[0].level).toBe("error");
	});
});

describe("renderAnnotation", () => {
	test("renders a full workflow command with escaped properties", () => {
		const a: CiAnnotation = {
			level: "error",
			file: "src/a,b.ts",
			line: 12,
			col: 3,
			title: "failsafe: type_error",
			message: "bad\nthing",
		};
		const out = renderAnnotation(a);
		expect(out.startsWith("::error ")).toBe(true);
		expect(out).toContain("file=src/a%2Cb.ts");
		expect(out).toContain("line=12");
		expect(out).toContain("col=3");
		expect(out).toContain("title=failsafe%3A type_error");
		// Newlines in the message body are escaped.
		expect(out.endsWith("::bad%0Athing")).toBe(true);
	});

	test("renders a bare command when no properties are present", () => {
		const out = renderAnnotation({ level: "warning", message: "heads up" });
		expect(out).toBe("::warning::heads up");
	});
});
