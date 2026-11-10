import { describe, expect, test } from "bun:test";
import {
	type CapabilityCatalog,
	attributeCapabilityFailure,
	diagnoseCapabilityDrift,
	diffCapabilityCatalogs,
} from "../../src/diagnosis/capability-drift.js";

function catalog(
	source: string,
	entries: CapabilityCatalog["entries"],
	catalogEtag?: string,
): CapabilityCatalog {
	return {
		source,
		captured_at: "2026-11-09T00:00:00.000Z",
		...(catalogEtag !== undefined ? { catalog_etag: catalogEtag } : {}),
		entries,
	};
}

describe("diffCapabilityCatalogs", () => {
	test("a tool present before and absent after is missing_tool", () => {
		const before = catalog("mcp", [{ name: "search_docs", version: "1.0" }]);
		const after = catalog("mcp", []);
		const changes = diffCapabilityCatalogs(before, after);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("missing_tool");
		if (changes[0].kind === "missing_tool") expect(changes[0].tool).toBe("search_docs");
	});

	test("a tool absent before and present after is unexpectedly_expanded with reason new_tool", () => {
		const before = catalog("mcp", []);
		const after = catalog("mcp", [{ name: "delete_repo", policy_scope: ["admin"] }]);
		const changes = diffCapabilityCatalogs(before, after);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("unexpectedly_expanded");
		if (changes[0].kind === "unexpectedly_expanded") {
			expect(changes[0].reason).toBe("new_tool");
			expect(changes[0].added_scopes).toEqual(["admin"]);
		}
	});

	test("a changed version is stale_tool with dimension 'version'", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }]);
		const after = catalog("mcp", [{ name: "run_tests", version: "2.0" }]);
		const changes = diffCapabilityCatalogs(before, after);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("stale_tool");
		if (changes[0].kind === "stale_tool") {
			expect(changes[0].dimension).toBe("version");
			expect(changes[0].before).toBe("1.0");
			expect(changes[0].after).toBe("2.0");
		}
	});

	test("a changed schema_hash is stale_tool with dimension 'schema'", () => {
		const before = catalog("mcp", [{ name: "run_tests", schema_hash: "abc" }]);
		const after = catalog("mcp", [{ name: "run_tests", schema_hash: "def" }]);
		const changes = diffCapabilityCatalogs(before, after);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("stale_tool");
		if (changes[0].kind === "stale_tool") expect(changes[0].dimension).toBe("schema");
	});

	test("a removed policy scope is stale_tool with dimension 'policy_scope'", () => {
		const before = catalog("mcp", [{ name: "run_tests", policy_scope: ["read", "write"] }]);
		const after = catalog("mcp", [{ name: "run_tests", policy_scope: ["read"] }]);
		const changes = diffCapabilityCatalogs(before, after);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("stale_tool");
		if (changes[0].kind === "stale_tool") {
			expect(changes[0].dimension).toBe("policy_scope");
			expect(changes[0].detail).toContain("write");
		}
	});

	test("an added policy scope is unexpectedly_expanded with reason policy_scope_widened", () => {
		const before = catalog("mcp", [{ name: "run_tests", policy_scope: ["read"] }]);
		const after = catalog("mcp", [{ name: "run_tests", policy_scope: ["read", "write"] }]);
		const changes = diffCapabilityCatalogs(before, after);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("unexpectedly_expanded");
		if (changes[0].kind === "unexpectedly_expanded") {
			expect(changes[0].reason).toBe("policy_scope_widened");
			expect(changes[0].added_scopes).toEqual(["write"]);
		}
	});

	test("simultaneous scope removal and addition for the same tool reports both findings, never conflated", () => {
		const before = catalog("mcp", [{ name: "run_tests", policy_scope: ["read", "write"] }]);
		const after = catalog("mcp", [{ name: "run_tests", policy_scope: ["read", "admin"] }]);
		const changes = diffCapabilityCatalogs(before, after);
		const kinds = changes.map((c) => c.kind).sort();
		expect(kinds).toEqual(["stale_tool", "unexpectedly_expanded"]);
	});

	test("an unchanged catalog_etag alongside real entry changes is stale_catalog_cache", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }], "etag-1");
		const after = catalog("mcp", [{ name: "run_tests", version: "2.0" }], "etag-1");
		const changes = diffCapabilityCatalogs(before, after);
		const cacheFinding = changes.find((c) => c.kind === "stale_catalog_cache");
		expect(cacheFinding).toBeDefined();
		if (cacheFinding?.kind === "stale_catalog_cache")
			expect(cacheFinding.catalog_etag).toBe("etag-1");
	});

	test("a changed catalog_etag with real entry changes is NOT reported as stale cache", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }], "etag-1");
		const after = catalog("mcp", [{ name: "run_tests", version: "2.0" }], "etag-2");
		const changes = diffCapabilityCatalogs(before, after);
		expect(changes.some((c) => c.kind === "stale_catalog_cache")).toBe(false);
	});

	test("an unchanged catalog with no entry differences and no etag produces zero findings", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }]);
		const after = catalog("mcp", [{ name: "run_tests", version: "1.0" }]);
		expect(diffCapabilityCatalogs(before, after)).toHaveLength(0);
	});
});

describe("attributeCapabilityFailure", () => {
	test("attributes to the named tool when tool_name is supplied", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }]);
		const after = catalog("mcp", []);
		const changes = diffCapabilityCatalogs(before, after);
		const attribution = attributeCapabilityFailure(changes, {
			tool_name: "run_tests",
			error_text: "tool not found",
		});
		expect(attribution.attributed).toBe(true);
		expect(attribution.kind).toBe("missing_tool");
	});

	test("attributes by matching the tool name inside the error text when tool_name is absent", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }]);
		const after = catalog("mcp", [{ name: "run_tests", version: "2.0" }]);
		const changes = diffCapabilityCatalogs(before, after);
		const attribution = attributeCapabilityFailure(changes, {
			error_text: "Error: tool 'run_tests' rejected unexpected argument shape",
		});
		expect(attribution.attributed).toBe(true);
		expect(attribution.kind).toBe("stale_tool");
	});

	test("does not attribute when no change names or implicates the given tool/error text", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }]);
		const after = catalog("mcp", [{ name: "run_tests", version: "2.0" }]);
		const changes = diffCapabilityCatalogs(before, after);
		const attribution = attributeCapabilityFailure(changes, {
			tool_name: "unrelated_tool",
			error_text: "some other failure",
		});
		expect(attribution.attributed).toBe(false);
		expect(attribution.matches).toHaveLength(0);
	});

	test("a stale_catalog_cache finding is always attributed even without a named match", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }], "etag-1");
		const after = catalog("mcp", [{ name: "run_tests", version: "2.0" }], "etag-1");
		const changes = diffCapabilityCatalogs(before, after);
		const attribution = attributeCapabilityFailure(changes, {
			tool_name: "completely_different_tool",
			error_text: "unrelated error",
		});
		expect(attribution.attributed).toBe(true);
		expect(attribution.matches.some((m) => m.kind === "stale_catalog_cache")).toBe(true);
	});

	test("missing_tool outranks unexpectedly_expanded and stale_tool when several kinds match", () => {
		const before = catalog("mcp", [
			{ name: "run_tests", version: "1.0" },
			{ name: "run_tests_v2", policy_scope: [] },
		]);
		const after = catalog("mcp", [{ name: "run_tests_v2", policy_scope: ["admin"] }]);
		const changes = diffCapabilityCatalogs(before, after);
		const attribution = attributeCapabilityFailure(changes, {
			error_text: "run_tests failed, run_tests_v2 also involved",
		});
		expect(attribution.kind).toBe("missing_tool");
	});
});

describe("diagnoseCapabilityDrift", () => {
	test("composes diff + attribution into one report with correct by_kind counts", () => {
		const before = catalog("mcp", [{ name: "run_tests", version: "1.0" }, { name: "legacy_tool" }]);
		const after = catalog("mcp", [{ name: "run_tests", version: "2.0" }]);
		const report = diagnoseCapabilityDrift(before, after, {
			tool_name: "run_tests",
			error_text: "run_tests failed",
		});
		expect(report.changes).toHaveLength(2);
		expect(report.by_kind.missing_tool).toBe(1);
		expect(report.by_kind.stale_tool).toBe(1);
		expect(report.attribution.attributed).toBe(true);
		expect(report.attribution.kind).toBe("stale_tool");
	});
});
