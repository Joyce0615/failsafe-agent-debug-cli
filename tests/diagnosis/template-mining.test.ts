/**
 * Diagnosis of unrecognized tool output via template mining (item 27).
 *
 * A failure from a tool no parser knows used to diagnose as bare
 * "Unknown failure" with an empty-ish signature. It now carries a templated
 * summary, the mined template + concrete line as evidence, a low-confidence
 * root cause, and a signature hash that groups repeats of the same shape.
 */
import { describe, expect, test } from "bun:test";
import { diagnose } from "../../src/diagnosis/engine.js";
import { detectAndParse } from "../../src/parsers/index.js";
import { computeSignatureHash } from "../../src/rules/learned.js";
import type { LearnedRule } from "../../src/rules/types.js";
import { SCHEMA_VERSION } from "../../src/types/common.js";
import type { FailureRecord, ParsedFailure } from "../../src/types/failure.js";

type DiagnoseStore = Parameters<typeof diagnose>[1];

function makeStore(): DiagnoseStore {
	return {
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
}

function makeFailure(parsed: ParsedFailure[], id = "fail_unknown_tool"): FailureRecord {
	const primary = parsed[0]?.errors[0]?.location;
	return {
		schema_version: SCHEMA_VERSION,
		failure_id: id,
		created_at: new Date().toISOString(),
		workspace: process.cwd(),
		command: "blorp build",
		cwd: process.cwd(),
		env_fingerprint: { os: "linux", arch: "x64", cwd: process.cwd() },
		status: "failed",
		exit_code: 2,
		duration_ms: 5,
		stdout_path: "",
		stderr_path: "",
		combined_log_path: "",
		parsed,
		primary_location: primary,
		related_locations: [],
		raw_artifacts: [],
	};
}

/** Output from a tool with no registered parser. */
const BLORP_OUTPUT = [
	"blorp v3.1 starting",
	"blorp: compiling module alpha",
	"blorp: compiling module beta",
	"blorp: compiling module gamma",
	"blorp: FATAL config/widget.blorp:88: unresolved reference 'gizmo'",
].join("\n");

describe("diagnose with mined log templates", () => {
	test("unknown tool output yields a templated summary, not 'Unknown failure'", async () => {
		const parsed = detectAndParse(BLORP_OUTPUT, "", "blorp build", { mineTemplates: true });
		expect(parsed[0].parser).toBe("drain-template");

		const diagnosis = await diagnose(makeFailure(parsed), makeStore());

		expect(diagnosis.summary).not.toBe("Unknown failure");
		expect(diagnosis.summary).toContain("unresolved reference");

		// Root cause is present but deliberately low-confidence.
		expect(diagnosis.root_cause).toBeDefined();
		expect(diagnosis.root_cause!.category).toBe("unknown");
		expect(diagnosis.root_cause!.confidence).toBeLessThan(0.6);

		// Both the generalized template and the concrete line are evidence.
		const templateEvidence = diagnosis.evidence.find((e) => e.kind === "log_template");
		expect(templateEvidence).toBeDefined();
		expect(templateEvidence!.location).toBe("config/widget.blorp:88");
		expect(diagnosis.evidence.some((e) => e.kind === "error_message")).toBe(true);

		// The agent is told this is inferred, not parsed.
		expect(diagnosis.uncertainty.some((u) => /template mining/i.test(u))).toBe(true);
		expect(diagnosis.uncertainty).not.toContain("No specific diagnosis template matched");
	});

	test("a location candidate is recovered from the unstructured line", async () => {
		const parsed = detectAndParse(BLORP_OUTPUT, "", "blorp build", { mineTemplates: true });
		const failure = makeFailure(parsed);
		expect(failure.primary_location).toEqual({ file: "config/widget.blorp", line: 88 });
	});

	test("the same failure shape groups to one signature, different shapes do not", () => {
		const first = detectAndParse(BLORP_OUTPUT, "", "blorp build", { mineTemplates: true });
		// Same template, different literal values.
		const variantOutput = BLORP_OUTPUT.replace(
			"config/widget.blorp:88: unresolved reference 'gizmo'",
			"config/widget.blorp:88: unresolved reference 'doohickey'",
		);
		const variant = detectAndParse(variantOutput, "", "blorp build", { mineTemplates: true });
		const other = detectAndParse("blorp: FATAL out of disk space", "", "blorp build", {
			mineTemplates: true,
		});

		const hashOf = (results: ReturnType<typeof detectAndParse>) =>
			computeSignatureHash(results[0].errors, results[0].errors[0].location);

		// Signature is non-degenerate and stable for identical shapes...
		const h1 = hashOf(first);
		expect(h1).toMatch(/^[0-9a-f]{16}$/);
		expect(hashOf(variant)).not.toBe(hashOf(other));
		// ...and distinct from a structurally different unknown failure.
		expect(h1).not.toBe(hashOf(other));
	});

	test("a real parser match still wins over the mined template", async () => {
		const pytest = [
			"E   KeyError: 'user_id'",
			"tests/test_auth.py:42: KeyError",
			"=================== 1 failed, 2 passed in 0.11s ====================",
		].join("\n");
		const parsed = detectAndParse(pytest, "", "pytest", { mineTemplates: true });
		const diagnosis = await diagnose(makeFailure(parsed, "fail_pytest"), makeStore());
		expect(diagnosis.evidence.some((e) => e.kind === "log_template")).toBe(false);
		expect(diagnosis.summary).not.toContain("<*>");
	});
});
