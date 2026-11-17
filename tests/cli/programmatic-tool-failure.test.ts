/**
 * `failsafe programmatic-tool attribute|reduce` CLI tests (item 43 —
 * attribute programmatic tool-calling failures).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/index.ts");
let workDir: string;

async function run(args: string[]): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: workDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout };
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "failsafe-programmatic-tool-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("programmatic-tool attribute", () => {
	test("attributes a sandbox-denial evidence file to 'sandbox'", async () => {
		const file = join(workDir, "evidence.json");
		writeFileSync(
			file,
			JSON.stringify({
				sandbox_denial: { kind: "network", detail: "host not in allowlist" },
			}),
		);
		const { exitCode, stdout } = await run(["programmatic-tool", "attribute", "--evidence", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.primary_cause).toBe("sandbox");
		expect(json.findings).toHaveLength(1);
	});

	test("cancellation alongside pipeline evidence is downgraded to a caveat in the CLI output too", async () => {
		const file = join(workDir, "evidence-cancel.json");
		writeFileSync(
			file,
			JSON.stringify({
				tool_error: { tool_name: "search", message: "500" },
				cancelled: { reason: "operator aborted" },
			}),
		);
		const { exitCode, stdout } = await run(["programmatic-tool", "attribute", "--evidence", file]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.primary_cause).toBe("tool");
		expect(json.caveats.some((c: string) => c.includes("also cancelled"))).toBe(true);
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const file = join(workDir, "evidence-render.json");
		writeFileSync(file, JSON.stringify({}));
		const { exitCode, stdout } = await run([
			"programmatic-tool",
			"attribute",
			"--evidence",
			file,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("# Programmatic Tool-Calling Failure Attribution");
		expect(stdout).toContain("Primary cause: indeterminate");
	});

	test("errors with a non-zero exit code when the evidence file is missing", async () => {
		const { exitCode, stdout } = await run([
			"programmatic-tool",
			"attribute",
			"--evidence",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});

describe("programmatic-tool reduce", () => {
	test("rejects a candidate that expands capabilities and keeps the gating element", async () => {
		const elementsFile = join(workDir, "elements.json");
		const outcomesFile = join(workDir, "outcomes.json");
		writeFileSync(elementsFile, JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }]));
		writeFileSync(
			outcomesFile,
			JSON.stringify({
				baseline: {
					reproduces: true,
					cause_signature: "X",
					capabilities_used: [{ tool_name: "search" }],
				},
				by_missing_element: {
					// Missing "b" reveals a different path that calls "delete_all".
					b: {
						reproduces: true,
						cause_signature: "X",
						capabilities_used: [{ tool_name: "search" }, { tool_name: "delete_all" }],
					},
					// Missing "c" alone is a harmless, capability-preserving reduction.
					c: {
						reproduces: true,
						cause_signature: "X",
						capabilities_used: [{ tool_name: "search" }],
					},
				},
			}),
		);
		const { exitCode, stdout } = await run([
			"programmatic-tool",
			"reduce",
			"--elements",
			elementsFile,
			"--outcomes",
			outcomesFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(
			json.capability_expansion_rejections.some((r: { kind: string }) => r.kind === "expanded"),
		).toBe(true);
		expect(json.elements.some((e: { id: string }) => e.id === "b")).toBe(true);
	});

	test("errors with a non-zero exit code when the elements file is missing", async () => {
		const outcomesFile = join(workDir, "outcomes-only.json");
		writeFileSync(
			outcomesFile,
			JSON.stringify({ baseline: { reproduces: true }, by_missing_element: {} }),
		);
		const { exitCode, stdout } = await run([
			"programmatic-tool",
			"reduce",
			"--elements",
			join(workDir, "does-not-exist.json"),
			"--outcomes",
			outcomesFile,
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
