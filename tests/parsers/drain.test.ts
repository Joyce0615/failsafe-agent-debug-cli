/**
 * Drain-style template mining (item 27).
 *
 * Covers the miner itself (clustering, wildcards, ranking, bounds) and the
 * `detectAndParse` last-resort integration.
 */
import { describe, expect, test } from "bun:test";
import {
	TEMPLATE_WILDCARD,
	extractLocationFromLine,
	mineTemplateResult,
	mineTemplates,
	selectFailureTemplate,
	templateHash,
} from "../../src/parsers/drain.js";
import { detectAndParse } from "../../src/parsers/index.js";

describe("mineTemplates", () => {
	test("collapses lines differing only in literals into one template", () => {
		const log = [
			"worker 1 processed batch 100 in 12 ms",
			"worker 2 processed batch 200 in 34 ms",
			"worker 3 processed batch 300 in 56 ms",
		].join("\n");
		const templates = mineTemplates(log);
		expect(templates.length).toBe(1);
		expect(templates[0].occurrences).toBe(3);
		expect(templates[0].template).toBe(
			`worker ${TEMPLATE_WILDCARD} processed batch ${TEMPLATE_WILDCARD} in ${TEMPLATE_WILDCARD} ms`,
		);
		// The concrete first line is retained for evidence.
		expect(templates[0].representative).toBe("worker 1 processed batch 100 in 12 ms");
		expect(templates[0].line_number).toBe(1);
	});

	test("keeps structurally different lines in separate templates", () => {
		const log = [
			"heartbeat ok 1",
			"heartbeat ok 2",
			"fatal: widget assembly failed after 3 retries",
		].join("\n");
		const templates = mineTemplates(log);
		expect(templates.length).toBe(2);
		// Ordered by occurrence count: the repeated heartbeat first.
		expect(templates[0].occurrences).toBe(2);
		expect(templates[1].occurrences).toBe(1);
	});

	test("ignores blank lines and strips ANSI colour codes", () => {
		const log = "\n\u001b[31mfatal: build broke\u001b[0m\n\n";
		const templates = mineTemplates(log);
		expect(templates.length).toBe(1);
		expect(templates[0].representative).toBe("fatal: build broke");
	});

	test("marks failure vocabulary as salient", () => {
		const templates = mineTemplates("all good here\nfatal: everything exploded");
		const salient = templates.filter((t) => t.salient);
		expect(salient.length).toBe(1);
		expect(salient[0].representative).toContain("fatal");
	});

	test("bounds the scan window and line length", () => {
		const noise = Array.from({ length: 500 }, (_, i) => `noise line ${i}`).join("\n");
		const log = `${noise}\nfatal: the last thing that happened`;
		const templates = mineTemplates(log, { maxLines: 3 });
		// Only the tail is scanned, so total matched lines never exceeds the cap.
		const scanned = templates.reduce((s, t) => s + t.occurrences, 0);
		expect(scanned).toBeLessThanOrEqual(3);
		expect(templates.some((t) => t.representative.includes("fatal"))).toBe(true);

		const long = mineTemplates(`${"x".repeat(5000)} boom`, { maxLineLength: 20 });
		expect(long[0].representative.length).toBeLessThanOrEqual(20);
	});

	test("returns nothing for empty input", () => {
		expect(mineTemplates("")).toEqual([]);
		expect(mineTemplates("   \n\n  ")).toEqual([]);
		expect(selectFailureTemplate([])).toBeNull();
	});
});

describe("selectFailureTemplate", () => {
	test("prefers a failure-vocabulary line over a more frequent progress line", () => {
		const log = [
			"downloading chunk 1",
			"downloading chunk 2",
			"downloading chunk 3",
			"downloading chunk 4",
			"ERROR: checksum mismatch for artifact xyz",
		].join("\n");
		const selected = selectFailureTemplate(mineTemplates(log));
		expect(selected).not.toBeNull();
		expect(selected!.representative).toContain("checksum mismatch");
		// ...even though the progress template is 4x more frequent.
		expect(mineTemplates(log)[0].occurrences).toBe(4);
	});

	test("falls back to the most frequent template when nothing is salient", () => {
		const log = ["step alpha 1", "step alpha 2", "step alpha 3", "different shape here"].join("\n");
		const selected = selectFailureTemplate(mineTemplates(log));
		expect(selected!.occurrences).toBe(3);
	});
});

describe("templateHash", () => {
	test("is stable per template and distinct across templates", () => {
		expect(templateHash("a <*> b")).toBe(templateHash("a <*> b"));
		expect(templateHash("a <*> b")).not.toBe(templateHash("a <*> c"));
		expect(templateHash("a <*> b")).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("extractLocationFromLine", () => {
	test("extracts file:line and file:line:col", () => {
		expect(extractLocationFromLine("blorp: src/widget.conf:42: bad key")).toEqual({
			file: "src/widget.conf",
			line: 42,
		});
		expect(extractLocationFromLine("fail at lib/thing.q:7:15 -> nope")).toEqual({
			file: "lib/thing.q",
			line: 7,
			column: 15,
		});
	});

	test("returns undefined when there is no location", () => {
		expect(extractLocationFromLine("something went wrong")).toBeUndefined();
	});
});

describe("detectAndParse last-resort mining", () => {
	const unknownOutput = [
		"blorp v3.1 starting",
		"blorp: compiling module alpha",
		"blorp: compiling module beta",
		"blorp: FATAL config/widget.blorp:88: unresolved reference 'gizmo'",
	].join("\n");

	test("is off by default so the no-match contract is unchanged", () => {
		expect(detectAndParse(unknownOutput, "", "blorp build").length).toBe(0);
		expect(detectAndParse("everything is fine", "", "echo hello").length).toBe(0);
	});

	test("mines a template when explicitly enabled", () => {
		const results = detectAndParse(unknownOutput, "", "blorp build", { mineTemplates: true });
		expect(results.length).toBe(1);
		expect(results[0].parser).toBe("drain-template");
		expect(results[0].failure_type).toBe("unknown");

		const err = results[0].errors[0];
		expect(err.message).toContain("unresolved reference");
		expect(err.error_type).toMatch(/^log_template:[0-9a-f]{8}$/);
		expect(err.location).toEqual({ file: "config/widget.blorp", line: 88 });
		// A one-off line has no variable slot yet, so its template is the line.
		expect(err.log_template?.template).toBe(
			"blorp: FATAL config/widget.blorp:88: unresolved reference 'gizmo'",
		);
		expect(err.log_template?.occurrences).toBe(1);
		expect(err.log_template?.scanned_lines).toBe(4);
	});

	test("generalizes repeated failing lines into a wildcard template", () => {
		const repeated = [
			"blorp: FATAL shard 1 lost quorum",
			"blorp: FATAL shard 2 lost quorum",
			"blorp: FATAL shard 3 lost quorum",
		].join("\n");
		const results = detectAndParse(repeated, "", "blorp run", { mineTemplates: true });
		const err = results[0].errors[0];
		expect(err.log_template?.template).toContain(TEMPLATE_WILDCARD);
		expect(err.log_template?.occurrences).toBe(3);
	});

	test("does not override a real parser match", () => {
		const pytest = [
			"E   KeyError: 'user_id'",
			"tests/test_auth.py:42: KeyError",
			"=================== 1 failed, 2 passed in 0.11s ====================",
		].join("\n");
		const results = detectAndParse(pytest, "", "pytest", { mineTemplates: true });
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.parser !== "drain-template")).toBe(true);
	});

	test("returns nothing to mine for empty output", () => {
		expect(mineTemplateResult("", "", {})).toBeNull();
		expect(detectAndParse("", "", "true", { mineTemplates: true }).length).toBe(0);
	});
});
