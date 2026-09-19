import { describe, expect, test } from "bun:test";
import type { ExplorationCase, ExplorationTrace } from "../../src/bench/exploration.js";
import {
	COMPARISON_METRICS,
	MIN_COMPARISON_INSTANCES,
	type SystemRun,
	comparePaired,
	metricOf,
	readEverythingBaseline,
	scoreSystem,
	singleGuessBaseline,
	suiteReport,
	winLossTie,
} from "../../src/bench/exploration-suite.js";

const REPO_FILES = Array.from({ length: 20 }, (_, i) => `src/f${i}.py`);

function cases(n: number): ExplorationCase[] {
	return Array.from({ length: n }, (_, i) => ({
		case_id: `c${i}`,
		relevant: {
			files: [`src/f${i % 5}.py`, `src/f${(i % 5) + 5}.py`],
			functions: [`fn${i % 5}`],
			tests: [`test_${i % 5}`],
			dependency_paths: [],
		},
	}));
}

function trace(caseId: string, files: string[]): ExplorationTrace {
	return {
		case_id: caseId,
		steps: files.map((target, index) => ({ index, kind: "read" as const, target })),
		ranked_files: files,
		patch_resolved: false,
	};
}

/**
 * A system that reads the relevant files plus roughly `noise` irrelevant ones.
 *
 * The per-case jitter matters: with identical instances the paired differences
 * are constant, the bootstrap distribution is a point mass, and the interval
 * tests would pass for the wrong reason.
 */
function system(name: string, suite: ExplorationCase[], noise: number): SystemRun {
	return {
		system: name,
		traces: suite.map((testCase, i) => {
			const junk = REPO_FILES.filter((f) => !testCase.relevant.files.includes(f)).slice(
				0,
				Math.max(0, noise + (i % 5) - 2),
			);
			return trace(testCase.case_id, [...testCase.relevant.files, ...junk]);
		}),
	};
}

describe("scoring a system over a suite", () => {
	test("a missing trace is scored as an empty exploration, never skipped", () => {
		const suite = cases(5);
		const scored = scoreSystem(suite, { system: "partial", traces: [trace("c0", ["src/f0.py"])] });
		expect(scored.scores).toHaveLength(5);
		expect(scored.missing).toHaveLength(4);
		expect(scored.scores[1].files.recall).toBe(0);
	});

	test("declining hard cases cannot raise the mean", () => {
		const suite = cases(5);
		const full = scoreSystem(suite, system("full", suite, 0));
		const cherryPicked = scoreSystem(suite, {
			system: "cherry",
			traces: [trace("c0", suite[0].relevant.files)],
		});
		const meanOf = (s: typeof full) =>
			s.scores.reduce((sum, x) => sum + x.files.f1, 0) / s.scores.length;
		expect(meanOf(cherryPicked)).toBeLessThan(meanOf(full));
	});

	test("every declared metric is extractable", () => {
		const suite = cases(3);
		const scored = scoreSystem(suite, system("s", suite, 1));
		for (const metric of COMPARISON_METRICS) {
			expect(Number.isFinite(metricOf(scored.scores[0], metric))).toBe(true);
		}
	});
});

describe("degenerate baselines", () => {
	const suite = cases(12);
	const repositoryFiles = Object.fromEntries(suite.map((c) => [c.case_id, REPO_FILES]));

	test("read-everything achieves perfect recall and terrible precision", () => {
		const scored = scoreSystem(suite, readEverythingBaseline(suite, repositoryFiles));
		expect(scored.scores[0].files.recall).toBe(1);
		expect(scored.scores[0].files.precision).toBeLessThan(0.2);
	});

	test("single-guess achieves perfect precision and poor recall", () => {
		const scored = scoreSystem(suite, singleGuessBaseline(suite));
		expect(scored.scores[0].files.precision).toBe(1);
		expect(scored.scores[0].files.recall).toBeLessThan(1);
	});

	test("a system that does not beat the baselines is called out", () => {
		const report = suiteReport(suite, [system("weak", suite, 18)], "file_f1", {
			repository_files: repositoryFiles,
		});
		expect(report.rows[0].beats_baselines).toBe(false);
		expect(
			report.caveats.some((c) => c.includes("not evidence of retrieval ability")),
		).toBe(true);
	});

	test("a genuinely good system does beat them", () => {
		const report = suiteReport(suite, [system("good", suite, 0)], "file_f1", {
			repository_files: repositoryFiles,
		});
		expect(report.rows[0].beats_baselines).toBe(true);
		expect(report.rows[0].baseline_margin).toBeGreaterThan(0);
	});

	test("both baselines appear in the report for inspection", () => {
		const report = suiteReport(suite, [], "file_f1", { repository_files: repositoryFiles });
		expect(report.baselines.map((b) => b.system).sort()).toEqual([
			"read_everything",
			"single_guess",
		]);
	});

	test("read-everything falls back to the relevant set when no repository listing is given", () => {
		const scored = scoreSystem(suite, readEverythingBaseline(suite, {}));
		expect(scored.scores[0].files.recall).toBe(1);
		expect(scored.scores[0].files.precision).toBe(1);
	});
});

describe("win/loss/tie", () => {
	test("differences within the tie threshold are ties", () => {
		expect(winLossTie([0.5, 0.5], [0.505, 0.495], 0.01)).toMatchObject({ ties: 2, decisive: 0 });
	});

	test("wins and losses are counted separately", () => {
		const table = winLossTie([1, 0, 1], [0, 1, 0], 0.01);
		expect(table.wins).toBe(2);
		expect(table.losses).toBe(1);
	});

	test("a mean improvement driven by one instance shows as mostly losses", () => {
		const a = [1, 0.4, 0.4, 0.4, 0.4];
		const b = [0, 0.5, 0.5, 0.5, 0.5];
		const meanA = a.reduce((x, y) => x + y) / a.length;
		const meanB = b.reduce((x, y) => x + y) / b.length;
		expect(meanA).toBeGreaterThan(meanB);
		expect(winLossTie(a, b).losses).toBe(4);
	});

	test("unequal lengths compare only the overlap", () => {
		expect(winLossTie([1, 1, 1], [0]).decisive).toBe(1);
	});
});

describe("paired comparison", () => {
	const suite = cases(30);

	test("a clearly better system wins with an interval excluding zero", () => {
		const good = scoreSystem(suite, system("good", suite, 0));
		const bad = scoreSystem(suite, system("bad", suite, 15));
		const comparison = comparePaired(good, bad, "file_f1", { seed: 7 });
		expect(comparison.verdict).toBe("a_better");
		expect(comparison.ci_lower).toBeGreaterThan(0);
	});

	test("the direction is detected either way round", () => {
		const good = scoreSystem(suite, system("good", suite, 0));
		const bad = scoreSystem(suite, system("bad", suite, 15));
		expect(comparePaired(bad, good, "file_f1", { seed: 7 }).verdict).toBe("b_better");
	});

	test("identical systems are indistinguishable, not ranked", () => {
		const a = scoreSystem(suite, system("a", suite, 3));
		const b = scoreSystem(suite, system("b", suite, 3));
		const comparison = comparePaired(a, b, "file_f1", { seed: 7 });
		expect(comparison.verdict).toBe("indistinguishable");
		expect(comparison.detail).toContain("whatever the means say");
	});

	test("the interval brackets the observed mean difference", () => {
		const good = scoreSystem(suite, system("good", suite, 0));
		const bad = scoreSystem(suite, system("bad", suite, 15));
		const comparison = comparePaired(good, bad, "file_f1", { seed: 7 });
		expect(comparison.ci_lower).toBeLessThanOrEqual(comparison.mean_difference);
		expect(comparison.ci_upper).toBeGreaterThanOrEqual(comparison.mean_difference);
	});

	test("a small suite refuses to compare at all", () => {
		const small = cases(4);
		const a = scoreSystem(small, system("a", small, 0));
		const b = scoreSystem(small, system("b", small, 10));
		const comparison = comparePaired(a, b, "file_f1", { seed: 7 });
		expect(comparison.verdict).toBe("insufficient_instances");
		expect(comparison.detail).toContain(String(MIN_COMPARISON_INSTANCES));
		expect(Number.isNaN(comparison.ci_lower)).toBe(true);
	});

	test("the bootstrap is deterministic from its seed", () => {
		const a = scoreSystem(suite, system("a", suite, 2));
		const b = scoreSystem(suite, system("b", suite, 8));
		const first = comparePaired(a, b, "file_f1", { seed: 42 });
		const second = comparePaired(a, b, "file_f1", { seed: 42 });
		expect(first.ci_lower).toBe(second.ci_lower);
		expect(comparePaired(a, b, "file_f1", { seed: 43 }).ci_lower).not.toBe(first.ci_lower);
	});

	test("a wider confidence level gives a wider interval", () => {
		const a = scoreSystem(suite, system("a", suite, 2));
		const b = scoreSystem(suite, system("b", suite, 8));
		const narrow = comparePaired(a, b, "file_f1", { seed: 7, confidence: 0.5 });
		const wide = comparePaired(a, b, "file_f1", { seed: 7, confidence: 0.99 });
		expect(wide.ci_upper - wide.ci_lower).toBeGreaterThan(narrow.ci_upper - narrow.ci_lower);
	});

	test("the win/loss table travels with every comparison", () => {
		const a = scoreSystem(suite, system("a", suite, 0));
		const b = scoreSystem(suite, system("b", suite, 15));
		const comparison = comparePaired(a, b, "file_f1", { seed: 7 });
		expect(comparison.win_loss_tie.wins + comparison.win_loss_tie.losses + comparison.win_loss_tie.ties).toBe(
			30,
		);
	});
});

describe("the suite report", () => {
	const suite = cases(30);
	const repositoryFiles = Object.fromEntries(suite.map((c) => [c.case_id, REPO_FILES]));

	test("systems are ranked by mean and every adjacent pair is compared", () => {
		const report = suiteReport(
			suite,
			[system("good", suite, 0), system("mid", suite, 5), system("bad", suite, 15)],
			"file_f1",
			{ repository_files: repositoryFiles, seed: 3 },
		);
		expect(report.rows.map((r) => r.system)).toEqual(["good", "mid", "bad"]);
		const adjacent = report.comparisons.filter((c) => c.system_b !== "read_everything" && c.system_b !== "single_guess");
		expect(adjacent).toHaveLength(2);
	});

	test("an indistinguishable adjacent pair is called out as sampling, not capability", () => {
		const report = suiteReport(suite, [system("a", suite, 3), system("b", suite, 3)], "file_f1", {
			repository_files: repositoryFiles,
			seed: 3,
		});
		expect(
			report.caveats.some((c) => c.includes("reflects sampling, not capability")),
		).toBe(true);
	});

	test("a small suite warns that no comparison on it can mean anything", () => {
		const small = cases(4);
		const report = suiteReport(small, [system("a", small, 0)], "file_f1", { seed: 3 });
		expect(report.caveats.some((c) => c.includes("distinguish a real difference from noise"))).toBe(
			true,
		);
	});

	test("missing traces are reported per system and explained", () => {
		const report = suiteReport(
			suite,
			[{ system: "partial", traces: [trace("c0", suite[0].relevant.files)] }],
			"file_f1",
			{ repository_files: repositoryFiles, seed: 3 },
		);
		expect(report.rows[0].missing).toBe(29);
		expect(report.caveats.some((c) => c.includes("cannot raise a mean"))).toBe(true);
	});

	test("every system is also compared against the strongest baseline", () => {
		const report = suiteReport(suite, [system("good", suite, 0)], "file_f1", {
			repository_files: repositoryFiles,
			seed: 3,
		});
		expect(
			report.comparisons.some(
				(c) => c.system_a === "good" && (c.system_b === "read_everything" || c.system_b === "single_guess"),
			),
		).toBe(true);
	});

	test("an empty system list still produces baselines and no rows", () => {
		const report = suiteReport(suite, [], "file_f1", { repository_files: repositoryFiles });
		expect(report.rows).toEqual([]);
		expect(report.baselines).toHaveLength(2);
		expect(report.instances).toBe(30);
	});
});
