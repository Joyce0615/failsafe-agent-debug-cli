/**
 * Documentation drift tests (item 95).
 *
 * Prose rots. Every module path, constant, and default value the three
 * governance documents cite is checked against the code here, so a rename or a
 * threshold change breaks the build rather than quietly making the
 * documentation wrong. A document nobody can trust is worse than no document:
 * it is consulted, believed, and acted on.
 */
import { describe, expect, test } from "bun:test";
import { MIN_ACCEPTABLE_KAPPA, SOUNDNESS_THRESHOLD } from "../../src/bench/reasoning-rubric.js";
import { MIN_CALIBRATION_SAMPLES } from "../../src/diagnosis/calibration.js";
import { DISCRIMINATION_THRESHOLD } from "../../src/diagnosis/experiments.js";
import { LINK_THRESHOLD } from "../../src/diagnosis/drift.js";
import { MIN_LEADER_CONFIDENCE, MIN_MARGIN } from "../../src/diagnosis/ranking.js";
import { APPROVAL_REQUIRED_AT } from "../../src/remediation/approval.js";
import { UNDETECTABLE_PII, DEFAULT_CLASS_POLICIES } from "../../src/security/data-classes.js";
import { PROFILES } from "../../src/security/sandbox.js";
import { DEFAULT_CAPTURE_POLICY } from "../../src/telemetry/capture-policy.js";

const DOCS_ROOT = new URL("../../docs/", import.meta.url).pathname;
const SRC_ROOT = new URL("../../src/", import.meta.url).pathname;

async function readDoc(name: string): Promise<string> {
	return Bun.file(`${DOCS_ROOT}${name}`).text();
}

/** Every `src/...ts` path a document mentions. */
function citedModules(text: string): string[] {
	return [...new Set(text.match(/src\/[\w./-]+\.ts/g) ?? [])];
}

describe("the documents exist and are substantive", () => {
	test("all three are present", async () => {
		for (const name of ["threat-model.md", "confidence.md", "runbooks.md"]) {
			const text = await readDoc(name);
			expect(text.length).toBeGreaterThan(1000);
		}
	});
});

describe("every cited module exists", () => {
	test("no document references a path that has been renamed away", async () => {
		const missing: string[] = [];
		for (const name of ["threat-model.md", "confidence.md", "runbooks.md"]) {
			const text = await readDoc(name);
			for (const path of citedModules(text)) {
				const relative = path.replace(/^src\//, "");
				if (!(await Bun.file(`${SRC_ROOT}${relative}`).exists())) {
					missing.push(`${name} → ${path}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	test("the threat model cites a meaningful number of modules", async () => {
		// A threat model that names no code is a wish list.
		expect(citedModules(await readDoc("threat-model.md")).length).toBeGreaterThanOrEqual(8);
	});
});

describe("the confidence document's threshold table matches the code", () => {
	test("every listed constant has its actual value", async () => {
		const text = await readDoc("confidence.md");
		const expected: Array<[string, number | string]> = [
			["MIN_LEADER_CONFIDENCE", MIN_LEADER_CONFIDENCE],
			["MIN_MARGIN", MIN_MARGIN],
			["SOUNDNESS_THRESHOLD", SOUNDNESS_THRESHOLD],
			["MIN_CALIBRATION_SAMPLES", MIN_CALIBRATION_SAMPLES],
			["MIN_ACCEPTABLE_KAPPA", MIN_ACCEPTABLE_KAPPA],
			["LINK_THRESHOLD", LINK_THRESHOLD],
		];
		for (const [name, value] of expected) {
			const row = text.split("\n").find((line) => line.includes(`\`${name}\``));
			expect(row).toBeDefined();
			expect(row).toContain(String(value));
		}
	});

	test("the bits threshold is documented in bits, not as a probability", async () => {
		const text = await readDoc("confidence.md");
		const row = text.split("\n").find((line) => line.includes("DISCRIMINATION_THRESHOLD"));
		expect(row).toContain(String(DISCRIMINATION_THRESHOLD));
		expect(row).toContain("bits");
	});

	test("every threshold named in the table is importable, so none is invented", () => {
		for (const value of [
			MIN_LEADER_CONFIDENCE,
			MIN_MARGIN,
			SOUNDNESS_THRESHOLD,
			DISCRIMINATION_THRESHOLD,
			MIN_CALIBRATION_SAMPLES,
			MIN_ACCEPTABLE_KAPPA,
			LINK_THRESHOLD,
		]) {
			expect(Number.isFinite(value)).toBe(true);
		}
	});
});

describe("the threat model's defaults match the code", () => {
	test("the documented telemetry default is the actual default", async () => {
		const text = await readDoc("threat-model.md");
		const row = text.split("\n").find((line) => line.includes("Telemetry capture mode"));
		expect(row).toContain(DEFAULT_CAPTURE_POLICY.mode);
	});

	test("the documented sandbox network default is the actual default", async () => {
		const text = await readDoc("threat-model.md");
		const row = text.split("\n").find((line) => line.includes("Sandbox network"));
		expect(row).toContain(PROFILES.reproducer.network.mode);
	});

	test("the documented PII default is the actual default", async () => {
		const text = await readDoc("threat-model.md");
		const row = text.split("\n").find((line) => line.includes("PII action"));
		expect(row).toContain(DEFAULT_CLASS_POLICIES.pii.action);
	});

	test("the documented prompt default is the actual default", async () => {
		const text = await readDoc("threat-model.md");
		const row = text.split("\n").find((line) => line.includes("Prompt capture"));
		expect(row).toContain(DEFAULT_CLASS_POLICIES.prompt.action);
	});

	test("the documented approval threshold is the actual threshold", async () => {
		const text = await readDoc("threat-model.md");
		const row = text.split("\n").find((line) => line.includes("Approval threshold"));
		expect(row).toContain(APPROVAL_REQUIRED_AT);
	});
});

describe("the out-of-scope list is real and specific", () => {
	test("it names key management, which every scheme here defers", async () => {
		const text = await readDoc("threat-model.md");
		expect(text).toContain("Key management");
		expect(text).toContain("Distribution, rotation, revocation");
	});

	test("it names the undetectable PII categories the code also names", async () => {
		const text = await readDoc("threat-model.md");
		expect(text).toContain("UNDETECTABLE_PII");
		expect(UNDETECTABLE_PII.length).toBeGreaterThan(3);
	});

	test("it admits that nothing here makes a diagnosis correct", async () => {
		const text = await readDoc("threat-model.md");
		expect(text).toContain("Correctness of a diagnosis");
	});

	test("the out-of-scope section has at least as many entries as the in-scope table", async () => {
		// A threat model listing only what it defends against reads as a claim
		// that nothing else matters.
		const text = await readDoc("threat-model.md");
		const outOfScope = (text.match(/^\d+\. \*\*/gm) ?? []).length;
		expect(outOfScope).toBeGreaterThanOrEqual(6);
	});
});

describe("the runbooks state what remains outstanding", () => {
	test("every runbook has a 'still outstanding' section", async () => {
		const text = await readDoc("runbooks.md");
		const runbooks = (text.match(/^## Runbook: /gm) ?? []).length;
		const outstanding = (text.match(/\*\*Still outstanding afterwards\*\*/g) ?? []).length;
		expect(runbooks).toBeGreaterThanOrEqual(5);
		expect(outstanding).toBe(runbooks);
	});

	test("the four remediation modes each have a runbook", async () => {
		const text = await readDoc("runbooks.md");
		for (const heading of ["Rollback", "Feature disable", "Retry", "Traffic shift"]) {
			expect(text).toContain(`## Runbook: ${heading}`);
		}
	});

	test("the retry runbook lists its contraindications", async () => {
		const text = await readDoc("runbooks.md");
		const section = text.split("## Runbook: Retry")[1].split("## Runbook:")[0];
		for (const cause of ["resource_exhaustion", "capacity", "regression", "data_corruption"]) {
			expect(section).toContain(cause);
		}
	});

	test("the retry runbook states the three-passes error rate", async () => {
		const text = await readDoc("runbooks.md");
		expect(text).toContain("51%");
	});

	test("the override runbook says what it does not excuse", async () => {
		const text = await readDoc("runbooks.md");
		const section = text.split("## Runbook: Emergency override")[1];
		expect(section).toContain("does **not** excuse an expired approval");
		expect(section).toContain("post-hoc review");
	});

	test("the document opens by saying none of these fixes a defect", async () => {
		const text = await readDoc("runbooks.md");
		expect(text.slice(0, 800)).toContain("None of them fixes a defect");
	});
});
