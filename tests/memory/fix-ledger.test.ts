import { describe, expect, test } from "bun:test";
import {
	ATTEMPT_OUTCOMES,
	type FixEpisode,
	THRASHING_THRESHOLD,
	currentOutcome,
	durabilityReport,
	invalidateHypothesis,
	outcomeAt,
	regressionAt,
	signatureHistory,
	summarizeLedger,
} from "../../src/memory/fix-ledger.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

function episode(overrides: Partial<FixEpisode> & { id: string }): FixEpisode {
	return {
		signature: "sig-a",
		attempted_at_ms: T0,
		summary: "widened the guard",
		files_changed: ["src/handler.py"],
		justified_by: ["h1"],
		observations: [{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" }],
		...overrides,
	};
}

describe("outcome is a history, not a field", () => {
	test("the outcome at a time reflects only what was observed by then", () => {
		const e = episode({
			id: "e1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + 5 * DAY, source: "recurrence" },
			],
		});
		expect(outcomeAt(e, T0)).toBe("unknown");
		expect(outcomeAt(e, T0 + 2 * HOUR)).toBe("resolved");
		expect(outcomeAt(e, T0 + 6 * DAY)).toBe("regressed");
	});

	test("the current outcome is the last observation", () => {
		const e = episode({
			id: "e1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + DAY, source: "recurrence" },
			],
		});
		expect(currentOutcome(e)).toBe("regressed");
	});

	test("an episode with no observations is unknown, not unresolved", () => {
		expect(currentOutcome(episode({ id: "e1", observations: [] }))).toBe("unknown");
		expect(ATTEMPT_OUTCOMES).toContain("unknown");
	});

	test("a regression records both when it worked and when it stopped", () => {
		const e = episode({
			id: "e1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + 3 * DAY, source: "recurrence" },
			],
		});
		const regression = regressionAt(e)!;
		expect(regression.resolved_at_ms).toBe(T0 + HOUR);
		expect(regression.regressed_at_ms).toBe(T0 + 3 * DAY);
	});

	test("never working and working-then-breaking are distinguished", () => {
		const neverWorked = episode({
			id: "e1",
			observations: [{ outcome: "unresolved", observed_at_ms: T0 + HOUR, source: "rerun" }],
		});
		expect(regressionAt(neverWorked)).toBeNull();
		expect(currentOutcome(neverWorked)).toBe("unresolved");
	});
});

describe("durability requires a window", () => {
	function resolved(id: string, at: number): FixEpisode {
		return episode({
			id,
			attempted_at_ms: at,
			observations: [{ outcome: "resolved", observed_at_ms: at + HOUR, source: "rerun" }],
		});
	}

	test("attempts younger than the window are excluded, not counted as durable", () => {
		const now = T0 + 10 * DAY;
		const report = durabilityReport(
			[resolved("old", T0), resolved("today", now - HOUR)],
			7 * DAY,
			now,
		);
		expect(report.eligible).toBe(1);
		expect(report.too_recent).toBe(1);
		expect(report.durable).toBe(1);
		expect(report.durable_rate).toBe(1);
	});

	test("the exclusion is stated in the caveats", () => {
		const now = T0 + 10 * DAY;
		const report = durabilityReport([resolved("today", now - HOUR)], 7 * DAY, now);
		expect(report.caveats.some((c) => c.includes("excluded rather than counted as durable"))).toBe(
			true,
		);
	});

	test("a fix that regressed inside the window is not durable", () => {
		const e = episode({
			id: "e1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + 2 * DAY, source: "recurrence" },
			],
		});
		const report = durabilityReport([e], 7 * DAY, T0 + 30 * DAY);
		expect(report.durable).toBe(0);
		expect(report.regressed).toBe(1);
		expect(report.durable_rate).toBe(0);
	});

	test("a regression after the window does not count against it, which the window makes explicit", () => {
		const e = episode({
			id: "e1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + 30 * DAY, source: "recurrence" },
			],
		});
		expect(durabilityReport([e], 7 * DAY, T0 + 60 * DAY).durable).toBe(1);
		expect(durabilityReport([e], 60 * DAY, T0 + 90 * DAY).durable).toBe(0);
	});

	test("mean time to regression is reported over regressed attempts only", () => {
		const e1 = episode({
			id: "e1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + 2 * DAY, source: "recurrence" },
			],
		});
		const e2 = episode({
			id: "e2",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + 4 * DAY, source: "recurrence" },
			],
		});
		const report = durabilityReport([e1, e2], 7 * DAY, T0 + 30 * DAY);
		expect(report.mean_time_to_regression_ms).toBe(3 * DAY);
	});

	test("no regressions means no mean to report, rather than zero", () => {
		expect(durabilityReport([resolved("a", T0)], 7 * DAY, T0 + 30 * DAY).mean_time_to_regression_ms).toBeNull();
	});

	test("nothing eligible yields a null rate and says so", () => {
		const report = durabilityReport([resolved("a", T0)], 7 * DAY, T0 + HOUR);
		expect(report.durable_rate).toBeNull();
		expect(report.caveats.some((c) => c.includes("no rate to report yet"))).toBe(true);
	});

	test("the window is always stated", () => {
		expect(durabilityReport([], 7 * DAY, T0).caveats[0]).toContain("window");
	});
});

describe("invalidating a hypothesis retracts justification, not outcome", () => {
	const episodes = [
		episode({ id: "e1", justified_by: ["h1"] }),
		episode({ id: "e2", justified_by: ["h1", "h2"] }),
		episode({ id: "e3", justified_by: ["h2"] }),
	];

	test("every fix that leaned on the hypothesis is marked", () => {
		const result = invalidateHypothesis(episodes, "h1", T0 + DAY, "probe refuted it");
		expect(result.retracted.sort()).toEqual(["e1", "e2"]);
		expect(result.episodes[0].justification_retracted?.reason).toBe("probe refuted it");
	});

	test("the outcome is left alone: the fix may still have worked", () => {
		const result = invalidateHypothesis(episodes, "h1", T0 + DAY, "refuted");
		expect(currentOutcome(result.episodes[0])).toBe("resolved");
	});

	test("unaffected episodes are untouched", () => {
		const result = invalidateHypothesis(episodes, "h1", T0 + DAY, "refuted");
		expect(result.episodes[2].justification_retracted).toBeUndefined();
	});

	test("the input is not mutated", () => {
		invalidateHypothesis(episodes, "h1", T0 + DAY, "refuted");
		expect(episodes[0].justification_retracted).toBeUndefined();
	});

	test("invalidating an unused hypothesis retracts nothing", () => {
		expect(invalidateHypothesis(episodes, "h99", T0, "refuted").retracted).toEqual([]);
	});
});

describe("per-signature history", () => {
	function attempt(id: string, at: number, outcome: "resolved" | "unresolved", files = ["a.py"]) {
		return episode({
			id,
			attempted_at_ms: at,
			files_changed: files,
			observations: [{ outcome, observed_at_ms: at + HOUR, source: "rerun" }],
		});
	}

	test("attempts-to-resolution counts the attempts, not the successes", () => {
		const history = signatureHistory(
			[
				attempt("a1", T0, "unresolved"),
				attempt("a2", T0 + DAY, "unresolved"),
				attempt("a3", T0 + 2 * DAY, "resolved"),
			],
			"sig-a",
		);
		expect(history.attempts).toBe(3);
		expect(history.attempts_to_resolution).toBe(3);
	});

	test("a signature never resolved reports null rather than its attempt count", () => {
		const history = signatureHistory(
			[attempt("a1", T0, "unresolved"), attempt("a2", T0 + DAY, "unresolved")],
			"sig-a",
		);
		expect(history.attempts_to_resolution).toBeNull();
	});

	test("repeated attempts with no resolution warn about the diagnosis", () => {
		const attempts = Array.from({ length: THRASHING_THRESHOLD }, (_, i) =>
			attempt(`a${i}`, T0 + i * DAY, "unresolved"),
		);
		const history = signatureHistory(attempts, "sig-a");
		expect(
			history.warnings.some((w) => w.includes("diagnosis is more likely wrong than the fixes")),
		).toBe(true);
	});

	test("one file edited repeatedly for one failure is called out", () => {
		const attempts = Array.from({ length: THRASHING_THRESHOLD }, (_, i) =>
			attempt(`a${i}`, T0 + i * DAY, "unresolved", ["src/hot.py"]),
		);
		const history = signatureHistory(attempts, "sig-a");
		expect(history.churned_files[0]).toEqual({ file: "src/hot.py", attempts: THRASHING_THRESHOLD });
		expect(history.warnings.some((w) => w.includes("point at the diagnosis rather than the edit"))).toBe(
			true,
		);
	});

	test("a file listed twice in one attempt counts once", () => {
		const history = signatureHistory(
			[attempt("a1", T0, "unresolved", ["a.py", "a.py"])],
			"sig-a",
		);
		expect(history.churned_files[0].attempts).toBe(1);
	});

	test("a regression is counted and warned about", () => {
		const regressing = episode({
			id: "r1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + DAY, source: "recurrence" },
			],
		});
		const history = signatureHistory([regressing], "sig-a");
		expect(history.recurrences).toBe(1);
		expect(history.warnings.some((w) => w.includes("cause was never addressed"))).toBe(true);
	});

	test("an unknown signature reports zero attempts rather than throwing", () => {
		const history = signatureHistory([], "nothing");
		expect(history.attempts).toBe(0);
		expect(history.warnings[0]).toContain("no attempts recorded");
	});

	test("attempts from other signatures are excluded", () => {
		const history = signatureHistory(
			[attempt("a1", T0, "resolved"), episode({ id: "b1", signature: "sig-b" })],
			"sig-a",
		);
		expect(history.attempts).toBe(1);
	});
});

describe("ledger summary", () => {
	test("unresolved signatures are excluded from the mean, and the exclusion is stated", () => {
		const resolvedSig = episode({ id: "r", signature: "resolved-sig" });
		const stuck = Array.from({ length: 3 }, (_, i) =>
			episode({
				id: `s${i}`,
				signature: "stuck-sig",
				attempted_at_ms: T0 + i * DAY,
				observations: [{ outcome: "unresolved", observed_at_ms: T0 + i * DAY, source: "rerun" }],
			}),
		);
		const summary = summarizeLedger([resolvedSig, ...stuck]);
		expect(summary.mean_attempts_to_resolution).toBe(1);
		expect(summary.caveats.some((c) => c.includes("every time somebody gives up"))).toBe(true);
	});

	test("thrashing signatures are listed", () => {
		const stuck = Array.from({ length: THRASHING_THRESHOLD }, (_, i) =>
			episode({
				id: `s${i}`,
				signature: "stuck-sig",
				attempted_at_ms: T0 + i * DAY,
				observations: [{ outcome: "unresolved", observed_at_ms: T0 + i * DAY, source: "rerun" }],
			}),
		);
		expect(summarizeLedger(stuck).thrashing).toEqual(["stuck-sig"]);
	});

	test("signatures with regressions are counted and called out", () => {
		const regressing = episode({
			id: "r1",
			observations: [
				{ outcome: "resolved", observed_at_ms: T0 + HOUR, source: "rerun" },
				{ outcome: "regressed", observed_at_ms: T0 + DAY, source: "recurrence" },
			],
		});
		const summary = summarizeLedger([regressing]);
		expect(summary.signatures_with_regressions).toBe(1);
		expect(summary.caveats.some((c) => c.includes("not successes at any window"))).toBe(true);
	});

	test("retracted justifications are counted", () => {
		const { episodes } = invalidateHypothesis([episode({ id: "e1" })], "h1", T0, "refuted");
		expect(summarizeLedger(episodes).retracted).toBe(1);
	});

	test("an empty ledger summarizes to zeros with a null mean", () => {
		const summary = summarizeLedger([]);
		expect(summary.episodes).toBe(0);
		expect(summary.signatures).toBe(0);
		expect(summary.mean_attempts_to_resolution).toBeNull();
		expect(summary.thrashing).toEqual([]);
	});
});
