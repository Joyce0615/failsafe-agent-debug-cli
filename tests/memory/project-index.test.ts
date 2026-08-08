/**
 * Project-context external memory (item 36).
 *
 * A multi-module fixture with a deliberate same-named distractor: the owning
 * module must outrank it, the index must invalidate after an edit, retrieval
 * must obey its byte budget, and no secret-file content may ever be indexed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../../src/diagnosis/engine.js";
import {
	buildProjectIndex,
	extractImports,
	extractSymbols,
	refreshProjectIndex,
	retrieveContext,
} from "../../src/memory/project-index.js";
import {
	loadProjectIndex,
	queryFromFailure,
	retrieveForFailure,
	saveProjectIndex,
} from "../../src/memory/store.js";
import type { LearnedRule } from "../../src/rules/types.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import { FailsafeConfigSchema } from "../../src/types/config.js";
import type { FailureRecord } from "../../src/types/failure.js";

let root: string;

/**
 * Fixture layout:
 *   billing/service.py   <- the real owner of `charge_card`
 *   reporting/service.py <- same FILE NAME, different module (the distractor)
 *   tests/test_billing.py
 *   .env                 <- must never be indexed
 */
function writeFixture(): void {
	mkdirSync(join(root, "billing"), { recursive: true });
	mkdirSync(join(root, "reporting"), { recursive: true });
	mkdirSync(join(root, "tests"), { recursive: true });

	writeFileSync(
		join(root, "billing", "service.py"),
		[
			"from billing.gateway import Gateway",
			"",
			"class BillingService:",
			"    def charge_card(self, card):",
			"        return Gateway().charge(card)",
			"",
			"    def refund(self, tx):",
			"        return Gateway().refund(tx)",
		].join("\n"),
	);
	writeFileSync(
		join(root, "billing", "gateway.py"),
		["class Gateway:", "    def charge(self, card):", "        return card['token']"].join("\n"),
	);
	writeFileSync(
		join(root, "reporting", "service.py"),
		["class ReportingService:", "    def render(self):", "        return 'report'"].join("\n"),
	);
	writeFileSync(
		join(root, "tests", "test_billing.py"),
		[
			"from billing.service import BillingService",
			"",
			"def test_charge_card():",
			"    assert BillingService().charge_card({}) is not None",
		].join("\n"),
	);
	writeFileSync(join(root, ".env"), "AWS_SECRET_ACCESS_KEY=SUPERSECRETVALUE12345\n");
	writeFileSync(join(root, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\nSECRETKEYBODY\n");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "failsafe-memory-"));
	writeFixture();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("extractors", () => {
	test("symbols by language family", () => {
		expect(extractSymbols("def alpha():\n    pass\nclass Beta:\n    pass", "x.py")).toEqual([
			"alpha",
			"Beta",
		]);
		expect(extractSymbols("export function loadUser() {}\nexport class Repo {}", "x.ts")).toContain(
			"loadUser",
		);
		expect(extractSymbols("func Handle(w http.ResponseWriter) {}", "x.go")).toContain("Handle");
		expect(extractSymbols("pub fn parse_widget() {}", "x.rs")).toContain("parse_widget");
	});

	test("imports across syntaxes", () => {
		const imports = extractImports(
			[
				'import { a } from "./alpha.js";',
				'const b = require("../beta");',
				"from billing.service import BillingService",
			].join("\n"),
		);
		expect(imports).toContain("./alpha.js");
		expect(imports).toContain("../beta");
		expect(imports).toContain("billing.service");
	});
});

describe("buildProjectIndex", () => {
	test("indexes source files with symbols, imports, and test ownership", () => {
		const index = buildProjectIndex(root);
		const ids = index.entries.map((e) => e.id);
		expect(ids).toContain("billing/service.py");
		expect(ids).toContain("reporting/service.py");
		expect(ids).toContain("tests/test_billing.py");

		const billing = index.entries.find((e) => e.id === "billing/service.py")!;
		expect(billing.symbols).toContain("charge_card");
		expect(billing.imports).toContain("billing.gateway");
		expect(billing.is_test).toBe(false);
		expect(billing.hash).toMatch(/^[0-9a-f]{16}$/);

		const testFile = index.entries.find((e) => e.id === "tests/test_billing.py")!;
		expect(testFile.is_test).toBe(true);
		expect(testFile.covers).toContain("billing/service.py");
	});

	test("never indexes secret-bearing files, and stores no file content at all", () => {
		const index = buildProjectIndex(root);
		const ids = index.entries.map((e) => e.id);
		expect(ids).not.toContain(".env");
		expect(ids).not.toContain("deploy.pem");
		expect(index.skipped.some((s) => s.path === ".env" && s.reason === "secret")).toBe(true);

		// The whole serialized index carries no content from any file.
		const serialized = JSON.stringify(index);
		expect(serialized).not.toContain("SUPERSECRETVALUE12345");
		expect(serialized).not.toContain("SECRETKEYBODY");
		expect(serialized).not.toContain("BEGIN PRIVATE KEY");
		// Even ordinary source bodies are absent — only names are kept.
		expect(serialized).not.toContain("Gateway().charge(card)");
	});

	test("respects the file cap", () => {
		const index = buildProjectIndex(root, { maxFiles: 1 });
		expect(index.entries.length).toBeLessThanOrEqual(1);
	});
});

describe("retrieveContext", () => {
	test("the owning module outranks a same-named distractor", () => {
		const index = buildProjectIndex(root);
		const result = retrieveContext(index, {
			files: ["billing/service.py"],
			symbols: ["charge_card"],
			tokens: ["card"],
		});
		expect(result.entries.length).toBeGreaterThan(0);
		expect(result.entries[0].id).toBe("billing/service.py");

		const distractor = result.entries.find((e) => e.id === "reporting/service.py");
		const owner = result.entries.find((e) => e.id === "billing/service.py")!;
		if (distractor) expect(owner.score).toBeGreaterThan(distractor.score);
	});

	test("the owning test is pulled in via the coverage edge", () => {
		const index = buildProjectIndex(root);
		const result = retrieveContext(index, { files: ["billing/service.py"] });
		const testEntry = result.entries.find((e) => e.id === "tests/test_billing.py");
		expect(testEntry).toBeDefined();
		expect(testEntry!.reason).toContain("covers an implicated module");
	});

	test("files touched by a recent failed fix are boosted", () => {
		const index = buildProjectIndex(root);
		const without = retrieveContext(index, { tokens: ["render"] });
		const with_ = retrieveContext(index, {
			tokens: ["render"],
			recentFixFiles: ["reporting/service.py"],
		});
		const before = without.entries.find((e) => e.id === "reporting/service.py")?.score ?? 0;
		const after = with_.entries.find((e) => e.id === "reporting/service.py")!.score;
		expect(after).toBeGreaterThan(before);
		expect(with_.entries.find((e) => e.id === "reporting/service.py")!.reason).toContain(
			"recent fix attempt",
		);
	});

	test("obeys the byte budget", () => {
		const index = buildProjectIndex(root);
		const query = { files: ["billing/service.py"], symbols: ["charge_card"], tokens: ["service"] };
		const generous = retrieveContext(index, query, 4000);
		const tight = retrieveContext(index, query, 120);
		expect(tight.used_bytes).toBeLessThanOrEqual(120);
		expect(tight.entries.length).toBeLessThan(generous.entries.length);
		// The budget never hides how much was available.
		expect(tight.considered).toBe(generous.considered);
	});

	test("an unrelated failure retrieves nothing", () => {
		const index = buildProjectIndex(root);
		const result = retrieveContext(index, { files: ["totally/unrelated.py"], tokens: ["zzzz"] });
		expect(result.entries.length).toBe(0);
	});
});

describe("invalidation", () => {
	test("refresh re-hashes and rebuilds only what changed", () => {
		const index = buildProjectIndex(root);
		const before = index.entries.find((e) => e.id === "billing/service.py")!;
		expect(before.symbols).not.toContain("void_charge");

		writeFileSync(
			join(root, "billing", "service.py"),
			[
				"class BillingService:",
				"    def charge_card(self, card):",
				"        return None",
				"    def void_charge(self, tx):",
				"        return tx",
			].join("\n"),
		);

		const { index: refreshed, changed, removed } = refreshProjectIndex(index);
		expect(changed).toEqual(["billing/service.py"]);
		expect(removed).toEqual([]);
		const after = refreshed.entries.find((e) => e.id === "billing/service.py")!;
		expect(after.hash).not.toBe(before.hash);
		expect(after.symbols).toContain("void_charge");
		// Untouched entries keep their identity.
		expect(refreshed.entries.find((e) => e.id === "reporting/service.py")!.hash).toBe(
			index.entries.find((e) => e.id === "reporting/service.py")!.hash,
		);
	});

	test("a deleted file drops out of the index", () => {
		const index = buildProjectIndex(root);
		rmSync(join(root, "reporting", "service.py"));
		const { index: refreshed, removed } = refreshProjectIndex(index);
		expect(removed).toContain("reporting/service.py");
		expect(refreshed.entries.some((e) => e.id === "reporting/service.py")).toBe(false);
	});
});

describe("persistence", () => {
	test("round-trips, and a version mismatch is rejected rather than trusted", () => {
		const path = join(root, ".failsafe", "project-index.json");
		const index = buildProjectIndex(root);
		saveProjectIndex(path, index);
		expect(loadProjectIndex(path)!.entries.length).toBe(index.entries.length);

		saveProjectIndex(path, { ...index, version: 99 });
		expect(loadProjectIndex(path)).toBeNull();
		expect(loadProjectIndex(join(root, "nope.json"))).toBeNull();
	});
});

describe("failure-driven retrieval", () => {
	const errors = [
		{
			message: "KeyError: 'token'",
			error_type: "KeyError",
			location: { file: "billing/service.py", line: 5 },
			test_file: "tests/test_billing.py",
			test_name: "test_charge_card",
			stack_frames: [
				{ file: "billing/service.py", line: 5, function: "charge_card", is_application: true },
			],
		},
	];

	test("queryFromFailure pulls files, symbols, and meaningful tokens", () => {
		const query = queryFromFailure(errors, { file: "billing/service.py", line: 5 });
		expect(query.files).toContain("billing/service.py");
		expect(query.symbols).toContain("charge_card");
		expect(query.tokens).toContain("KeyError");
		// Stopwords are dropped.
		expect(query.tokens).not.toContain("error");
	});

	test("retrieveForFailure returns null without an index", () => {
		expect(retrieveForFailure(join(root, "missing.json"), errors, undefined)).toBeNull();
	});

	test("diagnose attaches retrieval provenance only when memory is enabled", async () => {
		const path = join(root, ".failsafe", "project-index.json");
		saveProjectIndex(path, buildProjectIndex(root));

		const failure: FailureRecord = {
			schema_version: SCHEMA_VERSION,
			failure_id: "fail_mem36",
			created_at: new Date().toISOString(),
			workspace: root,
			command: "pytest tests/",
			cwd: root,
			env_fingerprint: { os: "linux", arch: "x64", cwd: root },
			status: "failed",
			exit_code: 1,
			duration_ms: 1,
			stdout_path: "",
			stderr_path: "",
			combined_log_path: "",
			parsed: [{ parser: "pytest", failure_type: "test_failure", errors }],
			primary_location: { file: "billing/service.py", line: 5, symbol: "charge_card" },
			related_locations: [],
			raw_artifacts: [],
		};

		const store: Parameters<typeof diagnose>[1] = {
			findSimilarFailures: () => [],
			getRawOutput: () => "",
			getLearnedRuleByHash: () => null as LearnedRule | null,
			saveLearnedRule: () => {},
			updateLearnedRule: () => {},
			hasRecordedLearning: () => true,
			markLearningRecorded: () => {},
			getLatestSuccessfulFix: () => null,
			countUnresolvedAfterDate: () => 0,
			getFlakySignature: () => null,
			upsertFlakySignature: () => {},
			listFlakySignatures: () => [],
		};

		const off = FailsafeConfigSchema.parse({ schema_version: "0.1" });
		const offDiagnosis = await diagnose(failure, store, off);
		expect(offDiagnosis.retrieval).toBeUndefined();
		expect(offDiagnosis.evidence.some((e) => e.kind === "project_memory")).toBe(false);

		const on = FailsafeConfigSchema.parse({
			schema_version: "0.1",
			memory: { enabled: true, index_file: ".failsafe/project-index.json" },
		});
		const onDiagnosis = await diagnose(failure, store, on);
		expect(onDiagnosis.retrieval).toBeDefined();
		expect(onDiagnosis.retrieval!.source).toBe("project_index");
		expect(onDiagnosis.retrieval!.entries[0].id).toBe("billing/service.py");
		expect(onDiagnosis.retrieval!.used_bytes).toBeLessThanOrEqual(
			onDiagnosis.retrieval!.budget_bytes,
		);
		const memoryEvidence = onDiagnosis.evidence.filter((e) => e.kind === "project_memory");
		expect(memoryEvidence.length).toBeGreaterThan(0);
		expect(memoryEvidence[0].location).toBe("billing/service.py");
		// No secret ever reaches the packet.
		expect(JSON.stringify(onDiagnosis)).not.toContain("SUPERSECRETVALUE12345");
	});
});

describe("failsafe memory CLI", () => {
	const CLI = join(import.meta.dir, "../../src/cli/index.ts");

	async function run(args: string[]): Promise<Record<string, unknown>> {
		const proc = Bun.spawn(["bun", CLI, ...args], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		try {
			return JSON.parse(stdout) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	test("build -> status -> refresh reports the index without leaking secrets", async () => {
		const absent = await run(["memory", "status"]);
		expect(absent.status).toBe("absent");

		const built = await run(["memory", "build"]);
		expect(built.status).toBe("built");
		expect(built.indexed_files as number).toBeGreaterThan(0);
		expect(built.skipped_secret as number).toBeGreaterThan(0);
		expect(JSON.stringify(built)).not.toContain("SUPERSECRETVALUE12345");

		const status = await run(["memory", "status"]);
		expect(status.status).toBe("present");
		expect(status.enabled).toBe(false); // opt-in, off by default

		writeFileSync(
			join(root, "reporting", "service.py"),
			"class ReportingService:\n    def render_v2(self):\n        return 'x'\n",
		);
		const refreshed = await run(["memory", "refresh"]);
		expect(refreshed.status).toBe("refreshed");
		expect(refreshed.changed as string[]).toContain("reporting/service.py");
	}, 60_000);
});
