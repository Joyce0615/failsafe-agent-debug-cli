import { describe, expect, test } from "bun:test";
import {
	DRIFT_CATEGORIES,
	type EnvironmentSnapshot,
	type FailureContext,
	detectAbiDrift,
	detectDependencyDrift,
	detectDrift,
	rankDrift,
} from "../../src/diagnosis/drift.js";

function snapshot(label: string, overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
	return { label, ...overrides };
}

const CONTEXT: FailureContext = {
	stack_files: ["site-packages/urllib3/connection.py", "src/app.py"],
	error_text: "urllib3.exceptions.ProtocolError: connection aborted",
	implicated_components: ["urllib3"],
};

describe("transitive drift is invisible in a manifest diff", () => {
	test("manifests alone cannot support a no-drift conclusion", () => {
		const result = detectDependencyDrift(
			snapshot("a", { manifest: { requests: "^2.0" } }),
			snapshot("b", { manifest: { requests: "^2.0" } }),
		);
		expect(result.changes).toEqual([]);
		expect(result.transitives_invisible).toBe(true);
		expect(result.caveats[0]).toContain("cannot be concluded from this");
	});

	test("a lockfile makes the transitive move visible", () => {
		const result = detectDependencyDrift(
			snapshot("a", { manifest: { requests: "^2.0" }, lockfile: { urllib3: "2.0.7" } }),
			snapshot("b", { manifest: { requests: "^2.0" }, lockfile: { urllib3: "2.2.0" } }),
		);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].component).toBe("urllib3");
		expect(result.transitives_invisible).toBe(false);
	});

	test("added and removed dependencies are distinguished from changed ones", () => {
		const result = detectDependencyDrift(
			snapshot("a", { lockfile: { keep: "1", gone: "1" } }),
			snapshot("b", { lockfile: { keep: "2", fresh: "1" } }),
		);
		const kinds = Object.fromEntries(result.changes.map((c) => [c.component, c.kind]));
		expect(kinds).toEqual({ keep: "changed", gone: "removed", fresh: "added" });
	});

	test("no dependency data at all is reported as nothing compared", () => {
		const result = detectDependencyDrift(snapshot("a"), snapshot("b"));
		expect(result.sources).toEqual([]);
		expect(result.caveats[0]).toContain("nothing was compared");
	});

	test("the sources actually used are recorded", () => {
		const result = detectDependencyDrift(
			snapshot("a", { manifest: {}, lockfile: {} }),
			snapshot("b", { manifest: {}, lockfile: {} }),
		);
		expect(result.sources).toEqual(["manifest", "lockfile"]);
	});
});

describe("ABI drift is not version drift", () => {
	test("a changed ABI tag is reported with the binary-contract explanation", () => {
		const result = detectAbiDrift(
			snapshot("a", { abi_tags: { numpy: "cp310-x86_64" } }),
			snapshot("b", { abi_tags: { numpy: "cp311-x86_64" } }),
		);
		expect(result.changes).toHaveLength(1);
		expect(result.caveats.some((c) => c.includes("no version change at all"))).toBe(true);
	});

	test("absent ABI data is called out as a blind spot, not as no drift", () => {
		const result = detectAbiDrift(snapshot("a"), snapshot("b"));
		expect(result.changes).toEqual([]);
		expect(result.caveats[0]).toContain("would be invisible here");
	});

	test("identical ABI tags produce no change", () => {
		const result = detectAbiDrift(
			snapshot("a", { abi_tags: { numpy: "cp311" } }),
			snapshot("b", { abi_tags: { numpy: "cp311" } }),
		);
		expect(result.changes).toEqual([]);
		expect(result.caveats).toEqual([]);
	});
});

describe("relevance is evidence-based, not severity-based", () => {
	test("a patch bump in the stack outranks a major bump that is untouched", () => {
		const ranked = rankDrift(
			[
				{
					category: "dependency",
					component: "bigframework",
					before: "3.0.0",
					after: "4.0.0",
					kind: "changed",
					source: "lockfile",
				},
				{
					category: "dependency",
					component: "urllib3",
					before: "2.0.7",
					after: "2.0.8",
					kind: "changed",
					source: "lockfile",
				},
			],
			CONTEXT,
		);
		expect(ranked[0].change.component).toBe("urllib3");
		expect(ranked[0].linked).toBe(true);
		expect(ranked[1].linked).toBe(false);
	});

	test("every signal that fired is named", () => {
		const ranked = rankDrift(
			[
				{
					category: "dependency",
					component: "urllib3",
					kind: "changed",
					source: "lockfile",
				},
			],
			CONTEXT,
		);
		expect(ranked[0].signals.length).toBeGreaterThanOrEqual(3);
		expect(ranked[0].signals.some((s) => s.includes("error text names"))).toBe(true);
		expect(ranked[0].signals.some((s) => s.includes("file in the stack"))).toBe(true);
	});

	test("an ABI change is linked regardless of what the stack shows", () => {
		const ranked = rankDrift(
			[{ category: "abi", component: "obscure", kind: "changed", source: "runtime" }],
			{ stack_files: [], error_text: "", implicated_components: [] },
		);
		expect(ranked[0].linked).toBe(true);
		expect(ranked[0].signals[0]).toContain("binary contract");
	});

	test("a component nothing points at is unlinked", () => {
		const ranked = rankDrift(
			[{ category: "configuration", component: "LOG_FORMAT", kind: "changed", source: "config" }],
			CONTEXT,
		);
		expect(ranked[0].linked).toBe(false);
		expect(ranked[0].signals).toEqual([]);
	});

	test("a very short component name does not match the error text by accident", () => {
		const ranked = rankDrift(
			[{ category: "dependency", component: "io", kind: "changed", source: "lockfile" }],
			{ stack_files: [], error_text: "connection aborted", implicated_components: [] },
		);
		expect(ranked[0].signals).toEqual([]);
	});

	test("ranking is deterministic when relevance ties", () => {
		const changes = [
			{ category: "configuration" as const, component: "b", kind: "changed" as const, source: "x" },
			{ category: "configuration" as const, component: "a", kind: "changed" as const, source: "x" },
		];
		expect(rankDrift(changes, CONTEXT).map((r) => r.change.component)).toEqual(["a", "b"]);
		expect(rankDrift([...changes].reverse(), CONTEXT).map((r) => r.change.component)).toEqual([
			"a",
			"b",
		]);
	});
});

describe("no drift is a finding", () => {
	test("identical full snapshots eliminate every compared category", () => {
		const full: Partial<EnvironmentSnapshot> = {
			manifest: { a: "1" },
			lockfile: { a: "1.0.0" },
			abi_tags: { a: "cp311" },
			schema: { main: "0007" },
			configuration: { TIMEOUT: "30" },
			infrastructure: { pool: "standard" },
		};
		const report = detectDrift(snapshot("before", full), snapshot("after", full), CONTEXT);
		expect(report.no_drift).toBe(true);
		expect(report.summary).toContain("all eliminated");
		expect(report.caveats).toEqual([]);
	});

	test("no drift with missing categories does not claim to have eliminated them", () => {
		const report = detectDrift(
			snapshot("before", { lockfile: { a: "1" } }),
			snapshot("after", { lockfile: { a: "1" } }),
			CONTEXT,
		);
		expect(report.no_drift).toBe(true);
		expect(report.summary).toContain("remain possible");
		expect(report.caveats.some((c) => c.includes("cannot be excluded"))).toBe(true);
	});

	test("uncompared categories are named individually", () => {
		const report = detectDrift(snapshot("a"), snapshot("b"), CONTEXT);
		for (const category of DRIFT_CATEGORIES) {
			expect(report.caveats.join(" ")).toContain(category);
		}
	});
});

describe("the full report", () => {
	const before = snapshot("working", {
		lockfile: { urllib3: "2.0.7", left_pad: "1.0.0" },
		abi_tags: { numpy: "cp311" },
		schema: { main: "0007" },
		configuration: { TIMEOUT: "30" },
		infrastructure: { pool: "standard" },
	});
	const after = snapshot("failing", {
		lockfile: { urllib3: "2.2.0", left_pad: "2.0.0" },
		abi_tags: { numpy: "cp311" },
		schema: { main: "0008" },
		configuration: { TIMEOUT: "5" },
		infrastructure: { pool: "spot" },
	});

	test("linked and unlinked changes are separated", () => {
		const report = detectDrift(before, after, CONTEXT);
		expect(report.linked.some((r) => r.change.component === "urllib3")).toBe(true);
		expect(report.unlinked).toBeGreaterThan(0);
		expect(report.no_drift).toBe(false);
	});

	test("the most relevant change is first", () => {
		expect(detectDrift(before, after, CONTEXT).ranked[0].change.component).toBe("urllib3");
	});

	test("per-category counts include how many are linked", () => {
		const report = detectDrift(before, after, CONTEXT);
		const dependency = report.by_category.find((c) => c.category === "dependency")!;
		expect(dependency.changes).toBe(2);
		expect(dependency.linked).toBe(1);
	});

	test("categories with no changes are omitted from the breakdown", () => {
		const report = detectDrift(before, after, CONTEXT);
		expect(report.by_category.some((c) => c.category === "abi")).toBe(false);
	});

	test("drift with no linked change says so rather than implying relevance", () => {
		const report = detectDrift(
			snapshot("a", { configuration: { LOG_LEVEL: "info" } }),
			snapshot("b", { configuration: { LOG_LEVEL: "debug" } }),
			CONTEXT,
		);
		expect(report.linked).toEqual([]);
		expect(report.caveats.some((c) => c.includes("no evidence it is relevant"))).toBe(true);
	});

	test("the summary counts both linked and unlinked", () => {
		const report = detectDrift(before, after, CONTEXT);
		expect(report.summary).toContain("with a link to the failure");
		expect(report.summary).toContain("without");
	});
});
