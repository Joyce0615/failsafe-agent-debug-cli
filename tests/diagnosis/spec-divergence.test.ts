import { describe, expect, test } from "bun:test";
import {
	type DivergenceEvidence,
	type FixtureRun,
	type ProtocolFixture,
	classifyDivergenceCause,
	diagnoseSpecDivergence,
	diffFixtureRun,
	reduceIncompatibilityWitnesses,
	renderSpecDivergenceReport,
} from "../../src/diagnosis/spec-divergence.js";

function fixture(overrides: Partial<ProtocolFixture> = {}): ProtocolFixture {
	return { fixture_id: "f1", ...overrides };
}

function run(overrides: Partial<FixtureRun> = {}): FixtureRun {
	return {
		fixture_id: "f1",
		generated: { outcome: "ok", response: { a: 1 } },
		handwritten: { outcome: "ok", response: { a: 1 } },
		...overrides,
	};
}

// ── diffFixtureRun ──

describe("diffFixtureRun", () => {
	test("returns null when both clients agree on an ok outcome and identical response", () => {
		expect(diffFixtureRun(run())).toBeNull();
	});

	test("returns null when both clients agree on an error outcome and identical error_type", () => {
		expect(
			diffFixtureRun(
				run({
					generated: { outcome: "error", error_type: "not_found" },
					handwritten: { outcome: "error", error_type: "not_found" },
				}),
			),
		).toBeNull();
	});

	test("outcome_mismatch when one client errors and the other succeeds", () => {
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: {} },
				handwritten: { outcome: "error", error_type: "timeout" },
			}),
		);
		expect(divergence?.kind).toBe("outcome_mismatch");
	});

	test("error_type_mismatch when both clients error but with different error types", () => {
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "error", error_type: "timeout" },
				handwritten: { outcome: "error", error_type: "not_found" },
			}),
		);
		expect(divergence?.kind).toBe("error_type_mismatch");
	});

	test("response_mismatch names every differing top-level key, sorted", () => {
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { a: 1, b: 2, c: 3 } },
				handwritten: { outcome: "ok", response: { a: 1, b: 99, c: 3 } },
			}),
		);
		expect(divergence?.kind).toBe("response_mismatch");
		expect(divergence?.differing_paths).toEqual(["b"]);
	});

	test("response_mismatch with multiple differing keys lists all of them sorted", () => {
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { z: 1, a: 2 } },
				handwritten: { outcome: "ok", response: { z: 99, a: 88 } },
			}),
		);
		expect(divergence?.differing_paths).toEqual(["a", "z"]);
	});

	test("a scalar response that differs produces a '$' differing path", () => {
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: 1 },
				handwritten: { outcome: "ok", response: 2 },
			}),
		);
		expect(divergence?.differing_paths).toEqual(["$"]);
	});
});

// ── classifyDivergenceCause ──

describe("classifyDivergenceCause", () => {
	test("transport_defect wins unconditionally, even over a fully-ambiguous response_mismatch", () => {
		const f = fixture({ spec_ambiguous_fields: ["b"] });
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { b: 1 } },
				handwritten: { outcome: "ok", response: { b: 2 } },
			}),
		)!;
		const evidence: DivergenceEvidence = { transport_defect: { detail: "corrupted frame" } };
		const result = classifyDivergenceCause(f, divergence, evidence);
		expect(result.cause).toBe("transport_defect");
		expect(result.caveats).toEqual([]);
	});

	test("spec_ambiguity when every differing path is declared ambiguous on the fixture", () => {
		const f = fixture({ spec_ambiguous_fields: ["b", "c"] });
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { a: 1, b: 1 } },
				handwritten: { outcome: "ok", response: { a: 1, b: 2 } },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence);
		expect(result.cause).toBe("spec_ambiguity");
		expect(result.caveats).toEqual([]);
	});

	test("a PARTIALLY-ambiguous mismatch does not qualify for spec_ambiguity", () => {
		const f = fixture({ spec_ambiguous_fields: ["b"] });
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { a: 1, b: 1 } },
				handwritten: { outcome: "ok", response: { a: 99, b: 2 } },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence);
		expect(result.cause).not.toBe("spec_ambiguity");
	});

	test("a partially-ambiguous mismatch falls through to runtime_defect when that evidence is supplied", () => {
		const f = fixture({ spec_ambiguous_fields: ["b"] });
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { a: 1, b: 1 } },
				handwritten: { outcome: "ok", response: { a: 99, b: 2 } },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence, {
			runtime_defect: { detail: "null pointer in handler" },
		});
		expect(result.cause).toBe("runtime_defect");
		expect(result.caveats.length).toBeGreaterThan(0);
	});

	test("a partially-ambiguous mismatch with no further evidence is unattributed with a caveat", () => {
		const f = fixture({ spec_ambiguous_fields: ["b"] });
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { a: 1, b: 1 } },
				handwritten: { outcome: "ok", response: { a: 99, b: 2 } },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence);
		expect(result.cause).toBeNull();
		expect(result.caveats.length).toBeGreaterThan(0);
	});

	test("spec_ambiguous_fields never apply to an outcome_mismatch", () => {
		const f = fixture({ spec_ambiguous_fields: ["response"] });
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: {} },
				handwritten: { outcome: "error", error_type: "timeout" },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence);
		expect(result.cause).not.toBe("spec_ambiguity");
	});

	test("spec_ambiguous_fields never apply to an error_type_mismatch", () => {
		const f = fixture({ spec_ambiguous_fields: ["error_type"] });
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "error", error_type: "timeout" },
				handwritten: { outcome: "error", error_type: "not_found" },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence);
		expect(result.cause).not.toBe("spec_ambiguity");
	});

	test("runtime_defect applies to an outcome_mismatch when that evidence is supplied", () => {
		const f = fixture();
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: {} },
				handwritten: { outcome: "error", error_type: "timeout" },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence, {
			runtime_defect: { detail: "race condition" },
		});
		expect(result.cause).toBe("runtime_defect");
	});

	test("generator_defect applies when only that evidence is supplied", () => {
		const f = fixture();
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence, {
			generator_defect: { detail: "stale contract" },
		});
		expect(result.cause).toBe("generator_defect");
	});

	test("no evidence and no full ambiguity match yields cause null with a caveat", () => {
		const f = fixture();
		const divergence = diffFixtureRun(
			run({
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
		)!;
		const result = classifyDivergenceCause(f, divergence);
		expect(result.cause).toBeNull();
		expect(result.caveats.length).toBeGreaterThan(0);
	});
});

// ── diagnoseSpecDivergence ──

describe("diagnoseSpecDivergence", () => {
	test("fixtures with no divergence produce no classifications", () => {
		const report = diagnoseSpecDivergence([fixture()], [run()]);
		expect(report.classifications).toEqual([]);
		expect(report.unattributed).toBe(0);
	});

	test("tallies by_cause and unattributed across multiple fixtures", () => {
		const fixtures = [
			fixture({ fixture_id: "f1", spec_ambiguous_fields: ["a"] }),
			fixture({ fixture_id: "f2" }),
		];
		const runs = [
			run({
				fixture_id: "f1",
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
			run({
				fixture_id: "f2",
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
		];
		const report = diagnoseSpecDivergence(fixtures, runs);
		expect(report.by_cause.spec_ambiguity).toBe(1);
		expect(report.unattributed).toBe(1);
	});

	test("a run whose fixture_id is not in the fixture list is unattributed with a caveat naming the missing fixture", () => {
		const report = diagnoseSpecDivergence(
			[],
			[
				run({
					fixture_id: "ghost",
					generated: { outcome: "ok", response: { a: 1 } },
					handwritten: { outcome: "ok", response: { a: 2 } },
				}),
			],
		);
		expect(report.classifications).toHaveLength(1);
		expect(report.classifications[0]?.cause).toBeNull();
		expect(report.classifications[0]?.caveats[0]).toContain("ghost");
	});

	test("evidenceByFixtureId routes evidence to the matching fixture only", () => {
		const fixtures = [fixture({ fixture_id: "f1" }), fixture({ fixture_id: "f2" })];
		const runs = [
			run({
				fixture_id: "f1",
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
			run({
				fixture_id: "f2",
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
		];
		const report = diagnoseSpecDivergence(fixtures, runs, {
			f1: { generator_defect: { detail: "stale" } },
		});
		const f1 = report.classifications.find((c) => c.fixture_id === "f1");
		const f2 = report.classifications.find((c) => c.fixture_id === "f2");
		expect(f1?.cause).toBe("generator_defect");
		expect(f2?.cause).toBeNull();
	});
});

// ── renderSpecDivergenceReport ──

describe("renderSpecDivergenceReport", () => {
	test("renders every classification, its caveats, and the by-cause tally", () => {
		const report = diagnoseSpecDivergence(
			[fixture({ spec_ambiguous_fields: ["a"] })],
			[
				run({
					generated: { outcome: "ok", response: { a: 1 } },
					handwritten: { outcome: "ok", response: { a: 2 } },
				}),
			],
		);
		const rendered = renderSpecDivergenceReport(report);
		expect(rendered).toContain("# Generated-SDK / Spec Divergence Report");
		expect(rendered).toContain("f1");
		expect(rendered).toContain("spec_ambiguity: 1");
	});
});

// ── reduceIncompatibilityWitnesses ──

describe("reduceIncompatibilityWitnesses", () => {
	test("reduces to the minimal fixture subset that still witnesses the same classified cause", async () => {
		const fixtures = [
			fixture({ fixture_id: "clean1" }),
			fixture({ fixture_id: "clean2" }),
			fixture({ fixture_id: "bad" }),
			fixture({ fixture_id: "clean3" }),
		];
		const runs = [
			run({ fixture_id: "clean1" }),
			run({ fixture_id: "clean2" }),
			run({
				fixture_id: "bad",
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
			run({ fixture_id: "clean3" }),
		];
		const evidence = { bad: { generator_defect: { detail: "stale contract" } } };
		const result = await reduceIncompatibilityWitnesses(fixtures, runs, evidence);
		expect(result.baseline_cause).toBe("generator_defect");
		expect(result.elements.map((e) => e.id)).toEqual(["bad"]);
	});

	test("when no fixture diverges, the reduction reports not_reduced with baseline_cause 'unattributed'", async () => {
		const fixtures = [fixture({ fixture_id: "clean1" }), fixture({ fixture_id: "clean2" })];
		const runs = [run({ fixture_id: "clean1" }), run({ fixture_id: "clean2" })];
		const result = await reduceIncompatibilityWitnesses(fixtures, runs);
		expect(result.minimality).toBe("not_reduced");
		expect(result.baseline_cause).toBe("unattributed");
	});

	test("a reduction candidate that would swap in a DIFFERENT fixture's cause is rejected as cause drift", async () => {
		const fixtures = [fixture({ fixture_id: "bad_a" }), fixture({ fixture_id: "bad_b" })];
		const runs = [
			run({
				fixture_id: "bad_a",
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "ok", response: { a: 2 } },
			}),
			run({
				fixture_id: "bad_b",
				generated: { outcome: "ok", response: { a: 1 } },
				handwritten: { outcome: "error", error_type: "timeout" },
			}),
		];
		// bad_a classifies as generator_defect (evidence supplied); bad_b
		// classifies as runtime_defect (evidence supplied). The baseline's
		// dominant cause is runtime_defect (earlier in DIVERGENCE_CAUSES
		// pipeline order than generator_defect), so reducing toward bad_a
		// alone (whose own cause is generator_defect) must be rejected as
		// cause drift, keeping bad_b instead.
		const evidence = {
			bad_a: { generator_defect: { detail: "stale" } },
			bad_b: { runtime_defect: { detail: "race" } },
		};
		const result = await reduceIncompatibilityWitnesses(fixtures, runs, evidence);
		expect(result.baseline_cause).toBe("runtime_defect");
		expect(result.elements.map((e) => e.id)).toEqual(["bad_b"]);
	});
});
