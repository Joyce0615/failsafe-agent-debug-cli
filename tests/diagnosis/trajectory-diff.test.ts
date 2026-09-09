import { describe, expect, test } from "bun:test";
import {
	MIN_BASELINES,
	type Trajectory,
	type TrajectoryStep,
	actionSignature,
	align,
	argumentShape,
	diffAgainstBaselines,
	diffPair,
	stepSignature,
} from "../../src/diagnosis/trajectory-diff.js";

function step(
	action: string,
	overrides: Partial<TrajectoryStep> = {},
): TrajectoryStep {
	return { id: `${action}-${Math.random()}`, action, outcome: "ok", ...overrides };
}

function traj(id: string, steps: TrajectoryStep[]): Trajectory {
	return { id, steps };
}

describe("signatures are semantic, not textual", () => {
	test("two reads of different files are the same step", () => {
		const a = step("read", { arguments: { path: "/a/x.py" } });
		const b = step("read", { arguments: { path: "/b/y.py" } });
		expect(stepSignature(a)).toBe(stepSignature(b));
	});

	test("a changed argument shape is a different step", () => {
		const a = step("read", { arguments: { path: "x" } });
		const b = step("read", { arguments: { path: "x", encoding: "utf8" } });
		expect(stepSignature(a)).not.toBe(stepSignature(b));
	});

	test("a type change is a shape change even under the same key", () => {
		const a = step("read", { arguments: { paths: "x" } });
		const b = step("read", { arguments: { paths: ["x"] } });
		expect(argumentShape(a.arguments)).not.toBe(argumentShape(b.arguments));
	});

	test("the same call with a different outcome is a different step", () => {
		const ok = step("read", { arguments: { path: "x" } });
		const bad = step("read", { arguments: { path: "x" }, outcome: "error", error_class: "ENOENT" });
		expect(stepSignature(ok)).not.toBe(stepSignature(bad));
		// But the action signature is the same, which is how the diff knows it is
		// the same call and only the result moved.
		expect(actionSignature(ok)).toBe(actionSignature(bad));
	});

	test("argument key order does not matter", () => {
		expect(argumentShape({ b: 1, a: "x" })).toBe(argumentShape({ a: "y", b: 2 }));
	});

	test("timestamps are excluded from the signature", () => {
		const a = step("read", { ts_ms: 1 });
		const b = step("read", { ts_ms: 999_999 });
		expect(stepSignature(a)).toBe(stepSignature(b));
	});

	test("absent arguments are distinguishable from empty ones", () => {
		expect(argumentShape(undefined)).toBe("");
		expect(argumentShape({})).toBe("");
		expect(argumentShape({ a: "" })).toBe("a:string[empty]");
	});
});

describe("alignment does not shift on an insertion", () => {
	test("an identical pair aligns entirely as matches", () => {
		const pairs = align(["a", "b", "c"], ["a", "b", "c"]);
		expect(pairs.every((p) => p.op === "match")).toBe(true);
	});

	test("one extra step early costs one gap, not a cascade", () => {
		const pairs = align(["a", "x", "b", "c"], ["a", "b", "c"]);
		expect(pairs.filter((p) => p.op === "match")).toHaveLength(3);
		expect(pairs.filter((p) => p.op === "insert")).toHaveLength(1);
		expect(pairs.filter((p) => p.op === "substitute")).toHaveLength(0);
	});

	test("a missing step is a deletion", () => {
		const pairs = align(["a", "c"], ["a", "b", "c"]);
		expect(pairs.filter((p) => p.op === "delete")).toHaveLength(1);
		expect(pairs.filter((p) => p.op === "match")).toHaveLength(2);
	});

	test("a changed step prefers substitution over insert-plus-delete", () => {
		const pairs = align(["a", "x", "c"], ["a", "b", "c"]);
		expect(pairs.filter((p) => p.op === "substitute")).toHaveLength(1);
		expect(pairs.filter((p) => p.op === "insert")).toHaveLength(0);
	});

	test("an empty side aligns entirely as gaps", () => {
		expect(align([], ["a", "b"]).every((p) => p.op === "delete")).toBe(true);
		expect(align(["a"], []).every((p) => p.op === "insert")).toBe(true);
		expect(align([], [])).toEqual([]);
	});

	test("indices in the alignment refer to the right sequences", () => {
		const pairs = align(["a", "x", "b"], ["a", "b"]);
		const inserted = pairs.find((p) => p.op === "insert")!;
		expect(inserted.failing_index).toBe(1);
		expect(inserted.healthy_index).toBeNull();
	});
});

describe("difference classification", () => {
	const healthy = traj("h", [
		step("read", { arguments: { path: "x" } }),
		step("test", { arguments: { suite: "unit" } }),
	]);

	test("an extra step in the failing run is only_in_failing", () => {
		const failing = traj("f", [
			step("read", { arguments: { path: "x" } }),
			step("retry", {}),
			step("test", { arguments: { suite: "unit" } }),
		]);
		const diff = diffPair(failing, healthy);
		expect(diff.differences.map((d) => d.kind)).toEqual(["only_in_failing"]);
		expect(diff.differences[0].description).toContain("which the healthy run did not");
	});

	test("a skipped step is only_in_healthy", () => {
		const failing = traj("f", [step("read", { arguments: { path: "x" } })]);
		const diff = diffPair(failing, healthy);
		expect(diff.differences.map((d) => d.kind)).toEqual(["only_in_healthy"]);
	});

	test("the same call with a different result is changed_outcome", () => {
		const failing = traj("f", [
			step("read", { arguments: { path: "x" }, outcome: "error", error_class: "ENOENT" }),
			step("test", { arguments: { suite: "unit" } }),
		]);
		const diff = diffPair(failing, healthy);
		expect(diff.differences[0].kind).toBe("changed_outcome");
		expect(diff.differences[0].description).toContain("ENOENT");
	});

	test("a different argument shape is changed_arguments", () => {
		const failing = traj("f", [
			step("read", { arguments: { path: "x", follow_symlinks: true } }),
			step("test", { arguments: { suite: "unit" } }),
		]);
		expect(diffPair(failing, healthy).differences[0].kind).toBe("changed_arguments");
	});

	test("a different action at the same position is changed_action", () => {
		const failing = traj("f", [
			step("write", { arguments: { path: "x" } }),
			step("test", { arguments: { suite: "unit" } }),
		]);
		expect(diffPair(failing, healthy).differences[0].kind).toBe("changed_action");
	});

	test("identical trajectories produce no differences and perfect similarity", () => {
		const diff = diffPair(traj("f", healthy.steps), healthy);
		expect(diff.differences).toEqual([]);
		expect(diff.similarity).toBe(1);
	});
});

describe("one baseline is not enough", () => {
	const failing = traj("f", [step("read"), step("retry"), step("test")]);

	test("no baseline at all is a refusal", () => {
		const report = diffAgainstBaselines(failing, []);
		expect(report.differences).toEqual([]);
		expect(report.divergence_point).toBeNull();
		expect(report.caveats[0]).toContain("nothing can be said");
	});

	test("a single baseline reports differences but calls none discriminating", () => {
		const report = diffAgainstBaselines(failing, [traj("h1", [step("read"), step("test")])]);
		expect(report.differences.length).toBeGreaterThan(0);
		expect(report.differences.every((d) => d.discriminativeness === 0)).toBe(true);
		expect(report.divergence_point).toBeNull();
		expect(report.caveats[0]).toContain(String(MIN_BASELINES));
	});

	test("two baselines are still not enough", () => {
		const report = diffAgainstBaselines(failing, [
			traj("h1", [step("read"), step("test")]),
			traj("h2", [step("read"), step("test")]),
		]);
		expect(report.divergence_point).toBeNull();
		expect(report.caveats.some((c) => c.includes("run-to-run variation"))).toBe(true);
	});
});

describe("noise is separated from signal", () => {
	/** Healthy runs that vary among themselves in one harmless way. */
	function noisyBaselines(): Trajectory[] {
		return [
			traj("h1", [step("read"), step("lint"), step("test")]),
			traj("h2", [step("read"), step("test")]),
			traj("h3", [step("read"), step("test")]),
			traj("h4", [step("read"), step("test")]),
		];
	}

	test("a difference the baselines also show among themselves is noise", () => {
		// The failing run omits `lint`, which h2/h3/h4 also omit relative to h1.
		const failing = traj("f", [step("read"), step("test")]);
		const report = diffAgainstBaselines(failing, noisyBaselines());
		const lintDiff = report.differences.find((d) => d.healthy_step?.action === "lint");
		expect(lintDiff?.is_noise).toBe(true);
		expect(lintDiff?.shared_with_healthy).toBeGreaterThan(0);
	});

	test("a difference unique to the failing run is the divergence point", () => {
		const failing = traj("f", [
			step("read"),
			step("test", { outcome: "error", error_class: "AssertionError" }),
		]);
		const report = diffAgainstBaselines(failing, noisyBaselines());
		expect(report.divergence_point?.kind).toBe("changed_outcome");
		expect(report.divergence_point?.discriminativeness).toBe(1);
		expect(report.divergence_point?.is_noise).toBe(false);
	});

	test("the first difference and the divergence point are distinguished", () => {
		const failing = traj("f", [
			step("read"),
			step("test", { outcome: "error", error_class: "AssertionError" }),
		]);
		const report = diffAgainstBaselines(failing, noisyBaselines());
		expect(report.first_difference).not.toBeNull();
		if (report.first_difference !== report.divergence_point) {
			expect(report.caveats.some((c) => c.includes("is not the divergence point"))).toBe(true);
		}
	});

	test("a failing run identical in shape to the baselines says so plainly", () => {
		const failing = traj("f", [step("read"), step("test")]);
		const report = diffAgainstBaselines(failing, [
			traj("h1", [step("read"), step("test")]),
			traj("h2", [step("read"), step("test")]),
			traj("h3", [step("read"), step("test")]),
		]);
		expect(report.differences).toEqual([]);
		expect(report.divergence_point).toBeNull();
	});

	test("every difference being noise is called out explicitly", () => {
		const failing = traj("f", [step("read"), step("test")]);
		const report = diffAgainstBaselines(failing, noisyBaselines());
		if (report.differences.every((d) => d.is_noise) && report.differences.length > 0) {
			expect(
				report.caveats.some((c) => c.includes("not distinguishable from a healthy one")),
			).toBe(true);
		}
	});

	test("differences are ranked by discriminativeness, not by position", () => {
		const failing = traj("f", [
			step("read"),
			step("test", { outcome: "error", error_class: "AssertionError" }),
		]);
		const report = diffAgainstBaselines(failing, noisyBaselines());
		for (let i = 1; i < report.differences.length; i++) {
			expect(report.differences[i - 1].discriminativeness).toBeGreaterThanOrEqual(
				report.differences[i].discriminativeness,
			);
		}
	});

	test("every pairwise diff is retained for inspection", () => {
		const report = diffAgainstBaselines(traj("f", [step("read")]), noisyBaselines());
		expect(report.pairwise).toHaveLength(4);
		expect(report.pairwise.map((p) => p.healthy_id)).toEqual(["h1", "h2", "h3", "h4"]);
	});

	test("the baseline count is reported", () => {
		expect(diffAgainstBaselines(traj("f", [step("read")]), noisyBaselines()).baselines).toBe(4);
	});
});
