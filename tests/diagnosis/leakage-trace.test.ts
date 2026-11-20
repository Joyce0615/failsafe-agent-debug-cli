import { describe, expect, test } from "bun:test";
import {
	CAPTURE_SURFACES,
	type SurfaceCapture,
	type TrackedValue,
	classifySurfaceCapture,
	renderLeakageSweepReport,
	sweepLeakage,
	traceValueLeakage,
} from "../../src/diagnosis/leakage-trace.js";
import { pseudonym } from "../../src/security/data-classes.js";

const SALTED: { salt: string } = { salt: "0123456789abcdef0123" };

describe("classifySurfaceCapture", () => {
	test("schema_metadata capture is always schema_metadata_only, regardless of class", () => {
		const value: TrackedValue = { value_id: "v1", key: "system_prompt", value: "do the thing" };
		const capture: SurfaceCapture = { surface: "span", location: "span.attr.prompt", kind: "schema_metadata" };
		const obs = classifySurfaceCapture(value, capture);
		expect(obs.verdict).toBe("schema_metadata_only");
		expect(obs.surface).toBe("span");
	});

	test("raw value verbatim in content capture is leaked when policy requires drop", () => {
		const value: TrackedValue = { value_id: "v2", key: "prompt", value: "the secret prompt text" };
		const capture: SurfaceCapture = {
			surface: "log",
			location: "logger.info",
			kind: "content",
			captured: "message included: the secret prompt text",
		};
		const obs = classifySurfaceCapture(value, capture);
		expect(obs.verdict).toBe("leaked");
	});

	test("raw value present but policy is allow -> compliant, not leaked", () => {
		const value: TrackedValue = { value_id: "v3", key: "random_unclassified_key", value: "just plain text" };
		const capture: SurfaceCapture = {
			surface: "cache",
			location: "diagnosis_cache.packet",
			kind: "content",
			captured: "just plain text",
		};
		const obs = classifySurfaceCapture(value, capture);
		expect(obs.verdict).toBe("compliant");
	});

	test("captured string exactly matches applyDataPolicy output -> compliant", () => {
		const value: TrackedValue = { value_id: "v4", key: "tool.arguments", value: "arg-payload-data" };
		const capture: SurfaceCapture = {
			surface: "span",
			location: "span.attr.tool_args",
			kind: "content",
			captured: "arg-payload-data", // tool_payload default is truncate at 512 bytes, short value unchanged after redactAll (no secret pattern)
		};
		const obs = classifySurfaceCapture(value, capture);
		expect(obs.verdict).toBe("compliant");
	});

	test("captured string matching drop's empty-string stand-in -> compliant", () => {
		const value: TrackedValue = { value_id: "v5", key: "prompt", value: "anything here" };
		const capture: SurfaceCapture = {
			surface: "bundle",
			location: "bundle.section.failure",
			kind: "content",
			captured: "",
		};
		const obs = classifySurfaceCapture(value, capture);
		expect(obs.verdict).toBe("compliant");
	});

	test("captured string is neither raw nor the shared policy output -> inconsistent_transform", () => {
		const value: TrackedValue = { value_id: "v6", key: "prompt", value: "anything here" };
		const capture: SurfaceCapture = {
			surface: "exception",
			location: "exception.message",
			kind: "content",
			captured: "[REDACTED-LOCALLY]",
		};
		const obs = classifySurfaceCapture(value, capture);
		expect(obs.verdict).toBe("inconsistent_transform");
	});

	test("PII with a valid salt hashes; captured pseudonym matches -> compliant", () => {
		const value: TrackedValue = { value_id: "v7", key: "customer_email", value: "alice@example.com" };
		const correctPseudonym = pseudonym(value.value, SALTED.salt);
		const matching = classifySurfaceCapture(
			value,
			{ surface: "model_visible_result", location: "cli.output", kind: "content", captured: correctPseudonym },
			SALTED,
		);
		expect(matching.verdict).toBe("compliant");

		const wrong = classifySurfaceCapture(
			value,
			{ surface: "model_visible_result", location: "cli.output", kind: "content", captured: "PLACEHOLDER" },
			SALTED,
		);
		expect(wrong.verdict).toBe("inconsistent_transform");
	});

	test("PII without a salt downgrades to drop; empty capture is compliant", () => {
		const value: TrackedValue = { value_id: "v8", key: "customer_email", value: "bob@example.com" };
		const capture: SurfaceCapture = {
			surface: "model_visible_result",
			location: "cli.output",
			kind: "content",
			captured: "",
		};
		const obs = classifySurfaceCapture(value, capture, {}); // no salt in opts; env salt presumed unset in test env
		expect(obs.verdict).toBe("compliant");
	});
});

describe("traceValueLeakage", () => {
	test("aggregates leaking_surfaces in the item's fixed six-surface order, not input order", () => {
		const value: TrackedValue = { value_id: "v9", key: "prompt", value: "secret prompt" };
		const captures: SurfaceCapture[] = [
			{ surface: "bundle", location: "b", kind: "content", captured: "contains secret prompt verbatim" },
			{ surface: "span", location: "s", kind: "content", captured: "contains secret prompt verbatim" },
			{ surface: "cache", location: "c", kind: "content", captured: "" },
		];
		const report = traceValueLeakage(value, captures);
		expect(report.leaking_surfaces).toEqual(["span", "bundle"]);
		expect(report.first_leak).toBe("span");
	});

	test("no leaks -> first_leak is null and leaking_surfaces is empty", () => {
		const value: TrackedValue = { value_id: "v10", key: "prompt", value: "secret prompt" };
		const captures: SurfaceCapture[] = [
			{ surface: "span", location: "s", kind: "content", captured: "" },
			{ surface: "log", location: "l", kind: "schema_metadata" },
		];
		const report = traceValueLeakage(value, captures);
		expect(report.leaking_surfaces).toEqual([]);
		expect(report.first_leak).toBeNull();
	});

	test("classes reflect classifyValue for the tracked value's key/value", () => {
		const value: TrackedValue = { value_id: "v11", key: "prompt", value: "hello world" };
		const report = traceValueLeakage(value, []);
		expect(report.classes).toEqual(["prompt"]);
	});

	test("expected_action matches the policy's chosen action for this value's classes", () => {
		const value: TrackedValue = { value_id: "v12", key: "tool.result", value: "some tool output" };
		const report = traceValueLeakage(value, []);
		expect(report.expected_action).toBe("truncate");
	});

	test("secret-classified value with no salt still expects drop (secret policy is always drop)", () => {
		const value: TrackedValue = {
			value_id: "v13",
			key: "random_field",
			value: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		};
		const report = traceValueLeakage(value, []);
		expect(report.classes).toContain("secret");
		expect(report.expected_action).toBe("drop");
	});

	test("value falling into multiple classes still produces one report with one expected_action", () => {
		const value: TrackedValue = {
			value_id: "v14",
			key: "prompt",
			value: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		};
		const report = traceValueLeakage(value, []);
		expect(report.classes.length).toBeGreaterThan(1);
		expect(report.expected_action).toBe("drop"); // secret is strictest
	});

	test("empty captures list produces zero observations but still a valid report shape", () => {
		const value: TrackedValue = { value_id: "v15", key: "prompt", value: "x" };
		const report = traceValueLeakage(value, []);
		expect(report.observations).toEqual([]);
		expect(report.first_leak).toBeNull();
	});

	test("schema_metadata capture never counts as leaked even if location name contains the raw value", () => {
		const value: TrackedValue = { value_id: "v16", key: "prompt", value: "topsecret" };
		const captures: SurfaceCapture[] = [
			{ surface: "span", location: "contains topsecret in name", kind: "schema_metadata" },
		];
		const report = traceValueLeakage(value, captures);
		expect(report.leaking_surfaces).toEqual([]);
	});

	test("multiple content captures on the same surface: surface counted once in leaking_surfaces", () => {
		const value: TrackedValue = { value_id: "v17", key: "prompt", value: "dup" };
		const captures: SurfaceCapture[] = [
			{ surface: "log", location: "l1", kind: "content", captured: "dup" },
			{ surface: "log", location: "l2", kind: "content", captured: "dup" },
		];
		const report = traceValueLeakage(value, captures);
		expect(report.leaking_surfaces).toEqual(["log"]);
		expect(report.observations.filter((o) => o.verdict === "leaked")).toHaveLength(2);
	});
});

describe("sweepLeakage", () => {
	test("collects leaked_value_ids across many tracked values in supplied order", () => {
		const sweep = sweepLeakage([
			{
				value: { value_id: "a", key: "prompt", value: "secretA" },
				captures: [{ surface: "span", location: "x", kind: "content", captured: "secretA" }],
			},
			{
				value: { value_id: "b", key: "prompt", value: "secretB" },
				captures: [{ surface: "span", location: "y", kind: "content", captured: "" }],
			},
			{
				value: { value_id: "c", key: "prompt", value: "secretC" },
				captures: [{ surface: "cache", location: "z", kind: "content", captured: "secretC" }],
			},
		]);
		expect(sweep.leaked_value_ids).toEqual(["a", "c"]);
		expect(sweep.reports).toHaveLength(3);
	});

	test("empty input -> empty reports and empty leaked_value_ids", () => {
		const sweep = sweepLeakage([]);
		expect(sweep.reports).toEqual([]);
		expect(sweep.leaked_value_ids).toEqual([]);
	});
});

describe("renderLeakageSweepReport", () => {
	test("renders a header, per-value sections, and a leaked-values summary", () => {
		const sweep = sweepLeakage([
			{
				value: { value_id: "only", key: "prompt", value: "boom" },
				captures: [{ surface: "span", location: "s", kind: "content", captured: "boom" }],
			},
		]);
		const text = renderLeakageSweepReport(sweep);
		expect(text).toContain("Prompt-Variable / Structured-Result Leakage Report");
		expect(text).toContain("only");
		expect(text).toContain("First leak: span");
		expect(text).toContain("Values with at least one leak: 1");
	});

	test("renders 'First leak: none found' when nothing leaked", () => {
		const sweep = sweepLeakage([
			{
				value: { value_id: "clean", key: "prompt", value: "boom" },
				captures: [{ surface: "span", location: "s", kind: "content", captured: "" }],
			},
		]);
		const text = renderLeakageSweepReport(sweep);
		expect(text).toContain("First leak: none found");
		expect(text).toContain("Values with at least one leak: 0");
	});
});

describe("CAPTURE_SURFACES ordering", () => {
	test("matches the item's own six-surface listing order exactly", () => {
		expect(CAPTURE_SURFACES).toEqual([
			"span",
			"log",
			"exception",
			"cache",
			"bundle",
			"model_visible_result",
		]);
	});
});
