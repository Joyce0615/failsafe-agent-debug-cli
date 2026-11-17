import { describe, expect, test } from "bun:test";
import {
	type ProgramOracleResult,
	type ProgramReductionOracle,
	type ProgrammaticRunEvidence,
	attributeProgrammaticFailure,
	reduceProgrammaticProgram,
	renderProgrammaticFailureAttribution,
} from "../../src/diagnosis/programmatic-tool-failure.js";
import type { TraceElement } from "../../src/repro/trace-reduction.js";

// ── attributeProgrammaticFailure ──

describe("attributeProgrammaticFailure", () => {
	test("no evidence at all produces a null primary cause and an explicit caveat", () => {
		const result = attributeProgrammaticFailure({});
		expect(result.findings).toEqual([]);
		expect(result.primary_cause).toBeNull();
		expect(result.caveats[0]).toContain("no evidence field was supplied");
	});

	test("environment evidence alone attributes to environment", () => {
		const evidence: ProgrammaticRunEvidence = {
			environment_mismatch: { detail: "numpy 1.20 required, 1.26 installed" },
		};
		const result = attributeProgrammaticFailure(evidence);
		expect(result.primary_cause).toBe("environment");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.cause).toBe("environment");
	});

	test("generated-code evidence alone attributes to generated_code", () => {
		const result = attributeProgrammaticFailure({
			code_exception: { error_type: "TypeError", message: "x is not a function" },
		});
		expect(result.primary_cause).toBe("generated_code");
		expect(result.findings[0]?.detail).toContain("TypeError");
	});

	test("proxy evidence alone attributes to proxy", () => {
		const result = attributeProgrammaticFailure({
			proxy_error: { tool_name: "search", message: "argument marshalling failed" },
		});
		expect(result.primary_cause).toBe("proxy");
		expect(result.findings[0]?.detail).toContain("search");
	});

	test("schema evidence alone attributes to schema", () => {
		const result = attributeProgrammaticFailure({
			schema_violation: {
				tool_name: "search",
				expected_schema_hash: "abc",
				actual_schema_hash: "def",
				detail: "result missing required field 'results'",
			},
		});
		expect(result.primary_cause).toBe("schema");
	});

	test("sandbox evidence alone attributes to sandbox", () => {
		const result = attributeProgrammaticFailure({
			sandbox_denial: { kind: "network", detail: "host api.example.com not in allowlist" },
		});
		expect(result.primary_cause).toBe("sandbox");
		expect(result.findings[0]?.detail).toContain("network");
	});

	test("tool evidence alone attributes to tool", () => {
		const result = attributeProgrammaticFailure({
			tool_error: { tool_name: "search", error_type: "RateLimitError", message: "429" },
		});
		expect(result.primary_cause).toBe("tool");
		expect(result.findings[0]?.detail).toContain("RateLimitError");
	});

	test("cancellation evidence ALONE attributes to cancellation", () => {
		const result = attributeProgrammaticFailure({
			cancelled: { reason: "operator aborted the run" },
		});
		expect(result.primary_cause).toBe("cancellation");
		expect(result.caveats).toEqual([]);
	});

	test("cancellation evidence alongside pipeline evidence is downgraded to a caveat, not a co-equal cause", () => {
		const result = attributeProgrammaticFailure({
			tool_error: { tool_name: "search", message: "500" },
			cancelled: { reason: "operator aborted after the tool error" },
		});
		expect(result.primary_cause).toBe("tool");
		expect(result.findings.map((f) => f.cause)).toContain("cancellation");
		expect(result.caveats.some((c) => c.includes("also cancelled"))).toBe(true);
	});

	test("earliest pipeline stage wins when multiple pipeline causes have evidence", () => {
		// environment mismatch (stage 1) AND a tool error (stage 6) both present.
		const result = attributeProgrammaticFailure({
			environment_mismatch: { detail: "missing dependency" },
			tool_error: { tool_name: "search", message: "boom" },
		});
		expect(result.primary_cause).toBe("environment");
		expect(result.findings).toHaveLength(2);
		expect(result.caveats.some((c) => c.includes("tool"))).toBe(true);
	});

	test("proxy evidence (stage 3) beats schema evidence (stage 4) when both present", () => {
		const result = attributeProgrammaticFailure({
			proxy_error: { tool_name: "search", message: "wrong wrapper" },
			schema_violation: { tool_name: "search", detail: "extra field" },
		});
		expect(result.primary_cause).toBe("proxy");
	});

	test("every supplied evidence field produces its own finding, never silently dropped", () => {
		const result = attributeProgrammaticFailure({
			environment_mismatch: { detail: "a" },
			code_exception: { error_type: "E", message: "b" },
			sandbox_denial: { kind: "resource_limit", detail: "c" },
		});
		expect(result.findings).toHaveLength(3);
		expect(result.findings.map((f) => f.cause).sort()).toEqual(
			(["environment", "generated_code", "sandbox"] as const).toSorted(),
		);
	});
});

describe("renderProgrammaticFailureAttribution", () => {
	test("renders primary cause, every finding, and every caveat", () => {
		const attribution = attributeProgrammaticFailure({
			environment_mismatch: { detail: "missing dependency" },
			tool_error: { tool_name: "search", message: "boom" },
		});
		const rendered = renderProgrammaticFailureAttribution(attribution);
		expect(rendered).toContain("Primary cause: environment");
		expect(rendered).toContain("[environment]");
		expect(rendered).toContain("[tool]");
		expect(rendered).toContain("## Caveats");
	});

	test("renders 'indeterminate' and 'No evidence supplied' for an empty attribution", () => {
		const rendered = renderProgrammaticFailureAttribution(attributeProgrammaticFailure({}));
		expect(rendered).toContain("Primary cause: indeterminate");
		expect(rendered).toContain("No evidence supplied.");
	});
});

// ── reduceProgrammaticProgram ──

function el(id: string, depends_on?: string[]): TraceElement {
	return depends_on ? { id, depends_on } : { id };
}

describe("reduceProgrammaticProgram", () => {
	test("a candidate that uses exactly the baseline's capabilities is accepted", async () => {
		const elements = [el("a"), el("b"), el("c")];
		const oracle: ProgramReductionOracle = (ids): ProgramOracleResult => {
			const present = new Set(ids);
			if (!present.has("a")) return { reproduces: false };
			return {
				reproduces: true,
				cause_signature: "X",
				capabilities_used: [{ tool_name: "search" }],
			};
		};
		const result = await reduceProgrammaticProgram(elements, oracle);
		expect(result.reduced_size).toBeLessThanOrEqual(result.original_size);
		expect(result.capability_expansion_rejections.filter((r) => r.kind === "expanded")).toEqual([]);
		expect(result.baseline_capabilities).toEqual([{ tool_name: "search" }]);
	});

	test("a reduced candidate that exercises a NEW tool is rejected, not accepted as a smaller repro", async () => {
		const elements = [el("a"), el("b"), el("c"), el("d")];
		const oracle: ProgramReductionOracle = (ids): ProgramOracleResult => {
			const present = new Set(ids);
			if (!present.has("a")) return { reproduces: false };
			// Removing "b" reveals a different code path that calls "delete_all".
			const usedDelete = !present.has("b");
			return {
				reproduces: true,
				cause_signature: "X",
				capabilities_used: usedDelete
					? [{ tool_name: "search" }, { tool_name: "delete_all" }]
					: [{ tool_name: "search" }],
			};
		};
		const result = await reduceProgrammaticProgram(elements, oracle);
		const expandedRejections = result.capability_expansion_rejections.filter(
			(r) => r.kind === "expanded",
		);
		expect(expandedRejections.length).toBeGreaterThan(0);
		// Final kept set must still include "b" (the one element whose removal
		// expanded capabilities), since every attempt to remove it was rejected.
		expect(result.elements.some((e) => e.id === "b")).toBe(true);
	});

	test("a widened policy scope on the SAME tool is also an expansion, not just a new tool name", async () => {
		const elements = [el("a"), el("b")];
		const oracle: ProgramReductionOracle = (ids): ProgramOracleResult => {
			const present = new Set(ids);
			if (!present.has("a")) return { reproduces: false };
			const widened = !present.has("b");
			return {
				reproduces: true,
				cause_signature: "X",
				capabilities_used: widened
					? [{ tool_name: "fs", policy_scope: ["read", "write"] }]
					: [{ tool_name: "fs", policy_scope: ["read"] }],
			};
		};
		const result = await reduceProgrammaticProgram(elements, oracle);
		expect(
			result.capability_expansion_rejections.some(
				(r) => r.kind === "expanded" && r.expanded_capabilities.length > 0,
			),
		).toBe(true);
	});

	test("a candidate that cannot report capabilities_used is rejected as unobserved, not trusted", async () => {
		const elements = [el("a"), el("b")];
		const oracle: ProgramReductionOracle = (ids): ProgramOracleResult => {
			const present = new Set(ids);
			if (!present.has("a")) return { reproduces: false };
			const isFull = ids.length >= elements.length;
			return isFull
				? { reproduces: true, cause_signature: "X", capabilities_used: [{ tool_name: "search" }] }
				: { reproduces: true, cause_signature: "X" }; // no capabilities_used reported
		};
		const result = await reduceProgrammaticProgram(elements, oracle);
		expect(result.capability_expansion_rejections.some((r) => r.kind === "unobserved")).toBe(true);
		// Since every genuinely-smaller candidate is rejected as unobserved, the
		// result cannot have shrunk below the original.
		expect(result.reduced_size).toBe(result.original_size);
	});

	test("the full, unablated run is never itself gated by the capability check", async () => {
		const elements = [el("a")];
		const oracle: ProgramReductionOracle = (): ProgramOracleResult => ({
			reproduces: true,
			cause_signature: "X",
			capabilities_used: [{ tool_name: "search" }],
		});
		const result = await reduceProgrammaticProgram(elements, oracle);
		expect(result.minimality).toBe("not_reduced");
		expect(result.capability_expansion_rejections).toEqual([]);
	});

	test("a non-reproducing candidate is passed through unchanged by the capability gate", async () => {
		const elements = [el("a"), el("b")];
		const oracle: ProgramReductionOracle = (ids): ProgramOracleResult => {
			const present = new Set(ids);
			return present.has("a")
				? { reproduces: true, cause_signature: "X", capabilities_used: [{ tool_name: "search" }] }
				: { reproduces: false };
		};
		const result = await reduceProgrammaticProgram(elements, oracle);
		expect(result.capability_expansion_rejections).toEqual([]);
	});
});
