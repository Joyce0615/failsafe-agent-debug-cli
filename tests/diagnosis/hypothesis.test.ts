import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ABANDON_POSTERIOR,
	CONFIRM_POSTERIOR,
	type HypothesisTree,
	type Observation,
	abandonHypothesis,
	buildHypothesisTree,
	descendantsOf,
	levelRank,
	recordObservation,
	summarize,
	updatePosterior,
	validateTree,
} from "../../src/diagnosis/hypothesis.js";
import { FailsafeStore } from "../../src/storage/store.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

function observation(
	outcome: Observation["outcome"],
	likelihoodIfTrue = 0.9,
	likelihoodIfFalse = 0.2,
): Observation {
	return {
		detail: `probe result: ${outcome}`,
		outcome,
		observed_at: "2026-08-13T00:00:00.000Z",
		likelihood_if_true: likelihoodIfTrue,
		likelihood_if_false: likelihoodIfFalse,
	};
}

function sampleTree(): HypothesisTree {
	return buildHypothesisTree({
		failure_id: "f1",
		primary_location: { file: "src/auth/session.py", line: 42, symbol: "validate" },
		frames: [
			{ file: "src/auth/session.py", line: 42, function: "validate", is_application: true },
			{ file: "src/auth/tokens.py", line: 17, function: "decode", is_application: true },
			{ file: "site-packages/pytest/x.py", line: 1, is_application: false },
		],
		root_cause: { category: "key_error", explanation: "'email' is absent", confidence: 0.6 },
		test_name: "test_session_validate",
		command: "pytest tests/test_auth.py",
	});
}

describe("posterior update", () => {
	test("confirming evidence raises belief, refuting evidence lowers it", () => {
		expect(updatePosterior(0.5, 0.9, 0.1)).toBeCloseTo(0.9, 10);
		expect(updatePosterior(0.5, 0.1, 0.9)).toBeCloseTo(0.1, 10);
	});

	test("uninformative evidence leaves belief unchanged", () => {
		expect(updatePosterior(0.37, 0.5, 0.5)).toBeCloseTo(0.37, 10);
	});

	test("evidence impossible under both branches carries no information", () => {
		expect(updatePosterior(0.4, 0, 0)).toBeCloseTo(0.4, 10);
	});

	test("a prior of zero cannot be resurrected", () => {
		expect(updatePosterior(0, 1, 0.001)).toBe(0);
	});

	test("out-of-range priors are clamped rather than propagated", () => {
		expect(updatePosterior(1.5, 0.9, 0.2)).toBe(1);
		expect(updatePosterior(-1, 0.9, 0.2)).toBe(0);
	});
});

describe("tree construction", () => {
	test("builds a module → file → function → line chain", () => {
		const tree = sampleTree();
		const levels = tree.hypotheses.map((h) => h.level);
		expect(levels.slice(0, 4)).toEqual(["module", "file", "function", "line"]);
		expect(validateTree(tree)).toEqual([]);
	});

	test("every hypothesis is falsifiable before any probe runs", () => {
		for (const h of sampleTree().hypotheses) {
			expect(h.probe?.expected_if_true.length).toBeGreaterThan(0);
			expect(h.probe?.expected_if_false).not.toBe(h.probe?.expected_if_true);
		}
	});

	test("the next distinct application frame becomes a competing branch", () => {
		const tree = sampleTree();
		const alt = tree.hypotheses.find((h) => h.id === "f1:alt-file");
		expect(alt?.location).toBe("src/auth/tokens.py");
		expect(alt?.posterior).toBeCloseTo(0.4, 10);
		// The competitor hangs off the module, not off the file it competes with.
		expect(alt?.parent_id).toBe("f1:module");
	});

	test("non-application frames are never promoted to hypotheses", () => {
		const locations = sampleTree().hypotheses.map((h) => h.location);
		expect(locations.some((l) => l?.includes("site-packages"))).toBe(false);
	});

	test("the failing test is recorded as the intent source", () => {
		const root = sampleTree().hypotheses[0];
		expect(root.intent?.source).toBe("test");
		expect(root.intent?.location).toBe("test_session_validate");
	});

	test("a symbol-less location skips the function level and reparents the line", () => {
		const tree = buildHypothesisTree({
			failure_id: "f2",
			primary_location: { file: "src/a.ts", line: 3 },
			root_cause: { category: "type_error", explanation: "bad cast", confidence: 0.5 },
		});
		expect(tree.hypotheses.map((h) => h.level)).toEqual(["module", "file", "line"]);
		expect(tree.hypotheses[2].parent_id).toBe("f2:file");
		expect(validateTree(tree)).toEqual([]);
	});

	test("no primary location yields an empty tree rather than a guess", () => {
		expect(buildHypothesisTree({ failure_id: "f3" }).hypotheses).toEqual([]);
	});
});

describe("hierarchical refutation", () => {
	test("refuting a parent abandons its whole subtree with a stated reason", () => {
		const tree = sampleTree();
		const { tree: after, transitions } = recordObservation(
			tree,
			"f1:file",
			observation("refutes", 0.1, 0.9),
		);
		const file = after.hypotheses.find((h) => h.id === "f1:file");
		expect(file?.status).toBe("refuted");

		for (const id of descendantsOf(after, "f1:file")) {
			const child = after.hypotheses.find((h) => h.id === id);
			expect(child?.status).toBe("abandoned");
			expect(child?.abandonment_reason).toContain("f1:file");
		}
		expect(transitions.length).toBeGreaterThanOrEqual(3);
	});

	test("a refuted branch's belief moves to its surviving competitor", () => {
		const tree = sampleTree();
		const before = tree.hypotheses.find((h) => h.id === "f1:alt-file")?.posterior ?? 0;
		const { tree: after } = recordObservation(tree, "f1:file", observation("refutes", 0.05, 0.95));
		const alt = after.hypotheses.find((h) => h.id === "f1:alt-file");
		expect(alt?.posterior).toBeGreaterThan(before);
		expect(alt?.status).toBe("open");
	});

	test("a sibling refutation does not touch an unrelated branch's subtree", () => {
		const { tree: after } = recordObservation(
			sampleTree(),
			"f1:alt-file",
			observation("refutes", 0.05, 0.95),
		);
		expect(after.hypotheses.find((h) => h.id === "f1:line")?.status).toBe("open");
	});

	test("strong confirmation promotes a hypothesis to confirmed", () => {
		const { tree: after, transitions } = recordObservation(
			sampleTree(),
			"f1:line",
			observation("confirms", 0.99, 0.01),
		);
		const line = after.hypotheses.find((h) => h.id === "f1:line");
		expect(line?.posterior).toBeGreaterThanOrEqual(CONFIRM_POSTERIOR);
		expect(line?.status).toBe("confirmed");
		expect(transitions.some((t) => t.to === "confirmed")).toBe(true);
	});

	test("weak confirmation raises belief without declaring victory", () => {
		const { tree: after } = recordObservation(
			sampleTree(),
			"f1:line",
			observation("confirms", 0.6, 0.5),
		);
		const line = after.hypotheses.find((h) => h.id === "f1:line");
		expect(line?.status).toBe("open");
		expect(line?.posterior).toBeGreaterThan(0.6);
	});

	test("a hypothesis whose belief collapses is abandoned with the number that did it", () => {
		const { tree: after } = recordObservation(
			sampleTree(),
			"f1:alt-file",
			observation("inconclusive", 0.0001, 0.9999),
		);
		const alt = after.hypotheses.find((h) => h.id === "f1:alt-file");
		expect(alt?.status).toBe("abandoned");
		expect(alt?.posterior).toBeLessThan(ABANDON_POSTERIOR);
		expect(alt?.abandonment_reason).toContain("posterior fell to");
	});

	test("recording an observation does not mutate the input tree", () => {
		const tree = sampleTree();
		const snapshot = JSON.stringify(tree);
		recordObservation(tree, "f1:file", observation("refutes", 0.05, 0.95));
		expect(JSON.stringify(tree)).toBe(snapshot);
	});

	test("an unknown hypothesis id is a no-op, not a crash", () => {
		const { transitions } = recordObservation(sampleTree(), "nope", observation("confirms"));
		expect(transitions).toEqual([]);
	});
});

describe("explicit abandonment", () => {
	test("a reason is mandatory", () => {
		expect(() => abandonHypothesis(sampleTree(), "f1:file", "   ")).toThrow("non-empty reason");
	});

	test("abandonment cascades to descendants naming the ancestor", () => {
		const after = abandonHypothesis(sampleTree(), "f1:file", "file was rewritten since the run");
		expect(after.hypotheses.find((h) => h.id === "f1:file")?.abandonment_reason).toBe(
			"file was rewritten since the run",
		);
		expect(after.hypotheses.find((h) => h.id === "f1:line")?.abandonment_reason).toContain(
			"ancestor 'f1:file'",
		);
	});

	test("the summary lists every dropped hypothesis with its reason", () => {
		const after = abandonHypothesis(sampleTree(), "f1:file", "ruled out by code review");
		const summary = summarize(after);
		expect(summary.abandoned_with_reasons.length).toBeGreaterThan(0);
		for (const entry of summary.abandoned_with_reasons) {
			expect(entry.reason).not.toBe("(unrecorded)");
		}
	});
});

describe("validation summary", () => {
	test("reports counts, the leading hypothesis, and the deepest open level", () => {
		const summary = summarize(sampleTree());
		expect(summary.total).toBe(5);
		expect(summary.open).toBe(5);
		expect(summary.deepest_open_level).toBe("line");
		expect(summary.leading?.posterior).toBeGreaterThan(0);
	});

	test("surfaces conflicting intent sources instead of picking one", () => {
		const tree = sampleTree();
		tree.hypotheses[0].intent = {
			source: "test",
			statement: "returns None for a missing key",
			conflicts: [{ source: "spec", statement: "raises KeyError for a missing key" }],
		};
		const summary = summarize(tree);
		expect(summary.intent_conflicts).toHaveLength(1);
		expect(summary.intent_conflicts[0].sources).toEqual(["test", "spec"]);
	});

	test("a fully refuted tree has no leading hypothesis", () => {
		let tree = sampleTree();
		for (const id of ["f1:module", "f1:alt-file"]) {
			tree = abandonHypothesis(tree, id, "ruled out");
		}
		expect(summarize(tree).leading).toBeUndefined();
	});
});

describe("structural validation", () => {
	test("a parent must be coarser than its child", () => {
		const tree = sampleTree();
		tree.hypotheses[1].level = "module";
		expect(validateTree(tree).some((e) => e.includes("not finer-grained"))).toBe(true);
	});

	test("a missing parent is reported", () => {
		const tree = sampleTree();
		tree.hypotheses[1].parent_id = "ghost";
		expect(validateTree(tree).some((e) => e.includes("missing parent"))).toBe(true);
	});

	test("an open hypothesis without a probe is not falsifiable", () => {
		const tree = sampleTree();
		tree.hypotheses[0].probe = undefined;
		expect(validateTree(tree).some((e) => e.includes("not falsifiable"))).toBe(true);
	});

	test("an abandoned hypothesis without a reason is rejected", () => {
		const tree = sampleTree();
		tree.hypotheses[0].status = "abandoned";
		expect(validateTree(tree).some((e) => e.includes("no abandonment_reason"))).toBe(true);
	});

	test("a parent cycle is detected rather than hanging", () => {
		const tree = sampleTree();
		tree.hypotheses[0].parent_id = "f1:line";
		expect(validateTree(tree).some((e) => e.includes("parent cycle"))).toBe(true);
	});

	test("levelRank orders coarse to fine", () => {
		expect(levelRank("module")).toBeLessThan(levelRank("file"));
		expect(levelRank("function")).toBeLessThan(levelRank("line"));
	});
});

describe("persistence", () => {
	function withStore<T>(fn: (store: FailsafeStore) => T): T {
		const dir = mkdtempSync(join(tmpdir(), "failsafe-hyp-"));
		const store = new FailsafeStore(DEFAULT_CONFIG, dir);
		try {
			return fn(store);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("a tree round-trips through storage unchanged", () => {
		withStore((store) => {
			const tree = sampleTree();
			store.saveHypotheses(tree);
			const loaded = store.getHypotheses("f1");
			expect(loaded).toEqual(tree);
		});
	});

	test("saving replaces the previous tree rather than appending", () => {
		withStore((store) => {
			store.saveHypotheses(sampleTree());
			const { tree: updated } = recordObservation(
				sampleTree(),
				"f1:file",
				observation("refutes", 0.05, 0.95),
			);
			store.saveHypotheses(updated);
			const loaded = store.getHypotheses("f1");
			expect(loaded?.hypotheses).toHaveLength(updated.hypotheses.length);
			expect(loaded?.hypotheses.find((h) => h.id === "f1:file")?.status).toBe("refuted");
		});
	});

	test("observations and abandonment reasons survive the round trip", () => {
		withStore((store) => {
			const abandoned = abandonHypothesis(sampleTree(), "f1:alt-file", "frame is third-party");
			const { tree: observed } = recordObservation(
				abandoned,
				"f1:line",
				observation("confirms", 0.99, 0.01),
			);
			store.saveHypotheses(observed);
			const loaded = store.getHypotheses("f1");
			expect(loaded?.hypotheses.find((h) => h.id === "f1:line")?.observations).toHaveLength(1);
			expect(loaded?.hypotheses.find((h) => h.id === "f1:alt-file")?.abandonment_reason).toBe(
				"frame is third-party",
			);
		});
	});

	test("an unknown failure has no stored tree", () => {
		withStore((store) => {
			expect(store.getHypotheses("nope")).toBeNull();
		});
	});
});
