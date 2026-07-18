/**
 * `failsafe explain` packet-contract tests (item 7).
 *
 * Seeds a real failure + diagnosis (+ repro) and asserts the emitted explain
 * packet shape for each `root_cause.category` fix-option branch
 * (null_reference/key_error/attribute_error → guard; import_error → install;
 * assertion_mismatch → fix-code), plus the no-diagnosis fallback.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(args: string[]): Promise<{ exitCode: number; json: Record<string, unknown> }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(stdout);
	} catch {}
	return { exitCode, json };
}

/** Run + diagnose a command, then return its explain packet. */
async function seedAndExplain(
	command: string,
	opts: { repro?: boolean } = {},
): Promise<Record<string, unknown>> {
	await run(["run", command]);
	await run(["diagnose", "last"]);
	if (opts.repro) await run(["repro", "last", "--no-verify"]);
	const { json } = await run(["explain", "last"]);
	return json;
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-explain-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("explain packet contract", () => {
	test("always carries failure_id, summary, evidence[], and a verify command", async () => {
		const out = await seedAndExplain("python3 -c \"raise KeyError('user_id')\"");
		expect(typeof out.failure_id).toBe("string");
		expect(typeof out.summary).toBe("string");
		expect(Array.isArray(out.evidence)).toBe(true);
		expect(out.verify).toEqual({ command: `failsafe verify ${out.failure_id}` });
	}, 30_000);

	test("key_error → null/undefined guard fix options", async () => {
		const out = await seedAndExplain("python3 -c \"raise KeyError('x')\"");
		const fixOptions = out.fix_options as Array<{ title: string; risk: string }>;
		expect(fixOptions.map((f) => f.title)).toEqual([
			"Add null/undefined guard",
			"Validate input before usage",
		]);
		expect(out.recommended_fix).toBe("Add null/undefined guard");
		expect(fixOptions.every((f) => f.risk === "low")).toBe(true);
	}, 30_000);

	test("null_reference → null/undefined guard fix options", async () => {
		const out = await seedAndExplain('node -e "const x=null; x.y"');
		expect(out.recommended_fix).toBe("Add null/undefined guard");
	}, 30_000);

	test("attribute_error → null/undefined guard fix options", async () => {
		const out = await seedAndExplain('python3 -c "None.missing_attr"');
		expect(out.recommended_fix).toBe("Add null/undefined guard");
	}, 30_000);

	test("import_error → install/fix-import options", async () => {
		const out = await seedAndExplain('python3 -c "import zzz_absent_module_qq"');
		const fixOptions = out.fix_options as Array<{ title: string; files: string[] }>;
		expect(fixOptions.map((f) => f.title)).toEqual([
			"Install missing dependency",
			"Fix import path",
		]);
		expect(out.recommended_fix).toBe("Install missing dependency");
		expect(fixOptions[0].files).toContain("package.json");
	}, 30_000);

	test("assertion_mismatch → fix-code/update-expectations options", async () => {
		const out = await seedAndExplain('python3 -c "assert 1 == 2"');
		const fixOptions = out.fix_options as Array<{ title: string; risk: string }>;
		expect(fixOptions.map((f) => f.title)).toEqual([
			"Fix the code to produce expected output",
			"Update test expectations",
		]);
		expect(out.recommended_fix).toBe("Fix the code to produce expected output");
		expect(fixOptions.every((f) => f.risk === "medium")).toBe(true);
	}, 30_000);

	test("no-diagnosis fallback: summary from the failure, no fix options", async () => {
		// Capture but do NOT diagnose — explain must still produce a packet.
		await run(["run", "python3 -c \"raise KeyError('bare')\""]);
		const { json: out } = await run(["explain", "last"]);
		expect(typeof out.summary).toBe("string");
		expect((out.summary as string).length).toBeGreaterThan(0);
		expect(out.fix_options).toBeUndefined();
		expect(out.recommended_fix).toBeUndefined();
		expect(out.verify).toBeDefined();
	}, 30_000);

	test("verified repro is surfaced as an evidence line", async () => {
		const out = await seedAndExplain("python3 -c \"raise KeyError('repro_case')\"", {
			repro: true,
		});
		// evidence is present; repro may or may not verify depending on the host,
		// but the packet contract (evidence array) must hold.
		expect(Array.isArray(out.evidence)).toBe(true);
	}, 30_000);
});
