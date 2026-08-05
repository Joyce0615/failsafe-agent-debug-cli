/**
 * Confirming interventions for low-confidence diagnoses (item 31).
 *
 * A low-confidence root cause plus a primary location must yield ONE specific
 * probe that validates the hypothesis at runtime; a high-confidence one must
 * not (an agent should not pay for a debugger run it doesn't need).
 */
import { describe, expect, test } from "bun:test";
import { diagnose } from "../../src/diagnosis/engine.js";
import {
	buildConfirmingIntervention,
	deriveWatchExpressions,
} from "../../src/diagnosis/intervention.js";
import type { LearnedRule } from "../../src/rules/types.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureDiagnosis } from "../../src/types/diagnosis.js";
import type { FailureRecord, ParsedError } from "../../src/types/failure.js";

type DiagnoseStore = Parameters<typeof diagnose>[1];

function makeStore(opts: { flakyAfterFix?: boolean } = {}) {
	const cache = new Map<string, FailureDiagnosis>();
	const store: DiagnoseStore = {
		findSimilarFailures: () => [],
		getRawOutput: () => "",
		getLearnedRuleByHash: () => null as LearnedRule | null,
		saveLearnedRule: () => {},
		updateLearnedRule: () => {},
		hasRecordedLearning: () => true,
		markLearningRecorded: () => {},
		getLatestSuccessfulFix: () =>
			opts.flakyAfterFix ? { resolved_at: "2020-01-01T00:00:00.000Z" } : null,
		countUnresolvedAfterDate: () => (opts.flakyAfterFix ? 5 : 0),
		getFlakySignature: () => null,
		upsertFlakySignature: () => {},
		listFlakySignatures: () => [],
		getCachedDiagnosis: (key) => cache.get(key) ?? null,
		saveCachedDiagnosis: (key, diag) => {
			cache.set(key, diag);
		},
	};
	return { store, cache };
}

function makeFailure(
	errors: ParsedError[],
	command: string,
	id = "fail_low",
	file = "app/service.py",
	line = 42,
): FailureRecord {
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: id,
		created_at: new Date().toISOString(),
		workspace: process.cwd(),
		command,
		cwd: process.cwd(),
		env_fingerprint: { os: "linux", arch: "x64", cwd: process.cwd() },
		status: "failed",
		exit_code: 1,
		duration_ms: 3,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed: [{ parser: "pytest", failure_type: "test_failure", errors }],
		primary_location: { file, line, symbol: "load_user" },
		related_locations: [],
		raw_artifacts: [],
	};
}

describe("deriveWatchExpressions", () => {
	test("names the exact symbol the error complains about", () => {
		expect(deriveWatchExpressions([{ message: "KeyError: 'user_id'" }])).toContain("user_id");
		expect(
			deriveWatchExpressions([{ message: "NameError: name 'config' is not defined" }]),
		).toContain("config");
		expect(
			deriveWatchExpressions([
				{ message: "AttributeError: 'Repo' object has no attribute 'flush'" },
			]),
		).toContain("flush");
		expect(
			deriveWatchExpressions([
				{ message: "TypeError: Cannot read properties of undefined (reading 'rows')" },
			]),
		).toContain("rows");
	});

	test("includes the failing frame's symbol and caps the list", () => {
		const watch = deriveWatchExpressions([{ message: "KeyError: 'a'" }], {
			file: "x.py",
			line: 1,
			symbol: "handler",
		});
		expect(watch).toContain("a");
		expect(watch).toContain("handler");
		expect(watch.length).toBeLessThanOrEqual(3);
	});

	test("uses the assertion's actual value when there is no named symbol", () => {
		const watch = deriveWatchExpressions([
			{ message: "AssertionError", assertion_diff: { expected: "3", actual: "total" } },
		]);
		expect(watch).toContain("total");
	});

	test("returns nothing when the message names no symbol", () => {
		expect(deriveWatchExpressions([{ message: "something broke" }])).toEqual([]);
	});
});

describe("buildConfirmingIntervention", () => {
	const base = {
		failureId: "fail_1",
		command: "pytest tests/test_service.py",
		errors: [{ message: "KeyError: 'user_id'" }],
		primaryLocation: { file: "app/service.py", line: 42, symbol: "load_user" },
	};

	test("proposes a debugger breakpoint with watches for low confidence", () => {
		const iv = buildConfirmingIntervention({ ...base, confidence: 0.4 });
		expect(iv).not.toBeNull();
		expect(iv!.kind).toBe("debugger_breakpoint");
		expect(iv!.command).toBe(
			"failsafe debug fail_1 --break app/service.py:42 --watch user_id,load_user",
		);
		expect(iv!.location).toBe("app/service.py:42");
		expect(iv!.watch).toEqual(["user_id", "load_user"]);
		expect(iv!.confidence).toBe(0.4);
		expect(iv!.expected_observation).toContain("user_id");
		expect(iv!.reason).toContain("40%");
	});

	test("returns null for a confident diagnosis", () => {
		expect(buildConfirmingIntervention({ ...base, confidence: 0.6 })).toBeNull();
		expect(buildConfirmingIntervention({ ...base, confidence: 0.92 })).toBeNull();
	});

	test("returns null without a primary location to probe", () => {
		expect(
			buildConfirmingIntervention({ ...base, primaryLocation: undefined, confidence: 0.2 }),
		).toBeNull();
	});

	test("treats a missing root cause as maximally unconfirmed", () => {
		const iv = buildConfirmingIntervention({ ...base, confidence: undefined });
		expect(iv).not.toBeNull();
		expect(iv!.confidence).toBe(0);
	});

	test("falls back to an assertion probe when the runtime has no adapter", () => {
		const iv = buildConfirmingIntervention({
			...base,
			command: "cargo test --all",
			primaryLocation: { file: "src/lib.rs", line: 88, symbol: "parse" },
			confidence: 0.3,
			reproCommand: "cargo test parse_widget",
		});
		expect(iv!.kind).toBe("assertion_probe");
		expect(iv!.command).toBe("cargo test parse_widget");
		expect(iv!.expected_observation).toContain("rust");
		expect(iv!.expected_observation).toContain("ONE temporary assertion");
	});

	test("explains flakiness rather than a weak match when flaky", () => {
		const iv = buildConfirmingIntervention({ ...base, confidence: 0.3, flaky: true });
		expect(iv!.reason).toContain("flaky");
	});
});

describe("diagnose attaches confirming_intervention", () => {
	test("low-confidence diagnosis with a location gains a probe", async () => {
		// An unrecognized message matches no template -> no root cause at all.
		const { store } = makeStore();
		const failure = makeFailure(
			[{ message: "widget subsystem returned status 7", error_type: "WidgetError" }],
			"pytest tests/",
		);
		const diagnosis = await diagnose(failure, store);
		expect(diagnosis.root_cause?.confidence ?? 0).toBeLessThan(0.6);
		expect(diagnosis.confirming_intervention).toBeDefined();
		expect(diagnosis.confirming_intervention!.command).toContain("failsafe debug fail_low --break");
		expect(diagnosis.confirming_intervention!.location).toBe("app/service.py:42");
	});

	test("a high-confidence diagnosis gets no probe", async () => {
		const { store } = makeStore();
		const failure = makeFailure(
			[
				{
					message: "TypeError: Cannot read properties of undefined (reading 'rows')",
					error_type: "TypeError",
					location: { file: "app/service.py", line: 42 },
				},
			],
			"node app.js",
			"fail_high",
		);
		const diagnosis = await diagnose(failure, store);
		expect(diagnosis.root_cause!.confidence).toBeGreaterThanOrEqual(0.6);
		expect(diagnosis.confirming_intervention).toBeUndefined();
	});

	test("a flaky diagnosis is capped low and therefore gains a probe", async () => {
		const { store } = makeStore({ flakyAfterFix: true });
		const failure = makeFailure(
			[
				{
					message: "TypeError: Cannot read properties of undefined (reading 'rows')",
					error_type: "TypeError",
				},
			],
			"pytest tests/",
			"fail_flaky",
		);
		const diagnosis = await diagnose(failure, store);
		expect(diagnosis.severity).toBe("flaky");
		expect(diagnosis.confirming_intervention).toBeDefined();
		expect(diagnosis.confirming_intervention!.reason).toContain("flaky");
	});

	test("a cache hit re-targets the probe at the CURRENT failure id", async () => {
		const { store, cache } = makeStore();
		const first = await diagnose(
			makeFailure([{ message: "widget subsystem returned status 7" }], "pytest tests/", "fail_a"),
			store,
		);
		expect(first.confirming_intervention!.command).toContain("fail_a");

		// Same signature, different failure: served from cache.
		const second = await diagnose(
			makeFailure([{ message: "widget subsystem returned status 7" }], "pytest tests/", "fail_b"),
			store,
		);
		expect(second.confirming_intervention!.command).toContain("fail_b");
		expect(second.confirming_intervention!.command).not.toContain("fail_a");

		// The stored entry itself stays failure-id free.
		for (const cached of cache.values()) {
			expect(cached.confirming_intervention).toBeUndefined();
		}
	});
});
