/**
 * `failsafe mcp-subscription diagnose` CLI tests (item 52 — diagnose MCP
 * subscription loss and cross-talk).
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
	workDir = mkdtempSync(join(tmpdir(), "failsafe-mcp-subscription-"));
	await run(["init"]);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("mcp-subscription diagnose", () => {
	test("reports cross_talk as the first violation", async () => {
		const eventsFile = join(workDir, "events-crosstalk.json");
		writeFileSync(
			eventsFile,
			JSON.stringify([
				{ sequence: 1, subscription_id: "s1", owner_id: "client-a", kind: "subscribe_requested" },
				{ sequence: 2, subscription_id: "s1", owner_id: "client-a", kind: "subscribe_acked" },
				{
					sequence: 3,
					subscription_id: "s1",
					owner_id: "client-b",
					kind: "update_delivered",
					payload: "v1",
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"mcp-subscription",
			"diagnose",
			"--events",
			eventsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.first_violation.kind).toBe("cross_talk");
	});

	test("reports no findings and no uncertainty for a clean subscription", async () => {
		const eventsFile = join(workDir, "events-clean.json");
		writeFileSync(
			eventsFile,
			JSON.stringify([
				{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
				{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
				{
					sequence: 3,
					subscription_id: "s1",
					owner_id: "c1",
					kind: "update_delivered",
					update_sequence: 1,
					payload: "v1",
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"mcp-subscription",
			"diagnose",
			"--events",
			eventsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.findings).toEqual([]);
		expect(json.transport_uncertain_subscriptions).toEqual([]);
		expect(json.first_violation).toBeNull();
	});

	test("reports transport_uncertain_subscriptions when updates carry no update_sequence", async () => {
		const eventsFile = join(workDir, "events-uncertain.json");
		writeFileSync(
			eventsFile,
			JSON.stringify([
				{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
				{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
				{
					sequence: 3,
					subscription_id: "s1",
					owner_id: "c1",
					kind: "update_delivered",
					payload: "v1",
				},
			]),
		);
		const { exitCode, stdout } = await run([
			"mcp-subscription",
			"diagnose",
			"--events",
			eventsFile,
		]);
		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout);
		expect(json.transport_uncertain_subscriptions).toEqual(["s1"]);
	});

	test("--render emits the Markdown rendering instead of JSON", async () => {
		const eventsFile = join(workDir, "events-render.json");
		writeFileSync(
			eventsFile,
			JSON.stringify([
				{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
				{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "connection_closed" },
			]),
		);
		const { exitCode, stdout } = await run([
			"mcp-subscription",
			"diagnose",
			"--events",
			eventsFile,
			"--render",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("MCP Subscription Loss & Cross-Talk Report");
	});

	test("errors with a non-zero exit code when the events file is missing", async () => {
		const { exitCode, stdout } = await run([
			"mcp-subscription",
			"diagnose",
			"--events",
			join(workDir, "does-not-exist.json"),
		]);
		expect(exitCode).not.toBe(0);
		expect(JSON.parse(stdout).error).toBe(true);
	});
});
