import { describe, expect, test } from "bun:test";
import {
	ATTRIBUTION_DOMAINS,
	type AttributionCase,
	type AttributionDomain,
	type AttributionPrediction,
	AttributionCaseSchema,
	DEFAULT_STEP_TOLERANCE,
	LIFT_TOLERANCE,
	attributionReport,
	firstErrorBaseline,
	fromTrajectoryRows,
	lastStepBaseline,
	scoreAttribution,
	scoreCases,
	summarizeScores,
	validateCases,
} from "../../src/bench/agent-attribution.js";

/**
 * A trajectory where the failure is *introduced* at step 2 (planner passes a
 * stale id) but only *surfaces* at step 5 — the shape the last-step and
 * first-error baselines both get wrong.
 */
function apiCase(overrides: Partial<AttributionCase> = {}): AttributionCase {
	return AttributionCaseSchema.parse({
		case_id: "api-1",
		domain: "api",
		steps: [
			{ index: 0, agent: "planner", action: "plan", ok: true },
			{ index: 1, agent: "retriever", action: "fetch schema", ok: true },
			{ index: 2, agent: "planner", action: "select account_id=stale", ok: true },
			{ index: 3, agent: "caller", action: "GET /accounts/stale", ok: true },
			{ index: 4, agent: "caller", action: "GET /balance", ok: true },
			{ index: 5, agent: "caller", action: "POST /transfer", ok: false },
		],
		ground_truth: {
			agent: "planner",
			step_index: 2,
			evidence_steps: [1, 2, 5],
			recovery: "fix_input",
		},
		...overrides,
	});
}

/** A trajectory whose failure really is at the last step. */
function endLoadedCase(id: string, domain: AttributionDomain = "incident"): AttributionCase {
	return AttributionCaseSchema.parse({
		case_id: id,
		domain,
		steps: [
			{ index: 0, agent: "triage", action: "read alert", ok: true },
			{ index: 1, agent: "triage", action: "query metrics", ok: true },
			{ index: 2, agent: "responder", action: "restart service", ok: false },
		],
		ground_truth: {
			agent: "responder",
			step_index: 2,
			evidence_steps: [2],
			recovery: "escalate",
		},
	});
}

function perfect(c: AttributionCase): AttributionPrediction {
	return {
		case_id: c.case_id,
		agent: c.ground_truth.agent,
		step_index: c.ground_truth.step_index,
		cited_steps: c.ground_truth.evidence_steps,
		recovery: c.ground_truth.recovery,
	};
}

describe("agent and step attribution", () => {
	test("a perfect attribution scores every axis", () => {
		const c = apiCase();
		const s = scoreAttribution(c, perfect(c));
		expect(s.agent.correct).toBe(true);
		expect(s.step.exact).toBe(true);
		expect(s.joint_correct).toBe(true);
		expect(s.joint_supported).toBe(true);
		expect(s.recovery.correct).toBe(true);
	});

	test("the right agent at the wrong step is not a joint success", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { ...perfect(c), step_index: 0 });
		expect(s.agent.correct).toBe(true);
		expect(s.step.exact).toBe(false);
		expect(s.joint_correct).toBe(false);
	});

	test("off-by-one and off-by-many are distinguished", () => {
		const c = apiCase();
		const near = scoreAttribution(c, { ...perfect(c), step_index: 3 });
		const far = scoreAttribution(c, { ...perfect(c), step_index: 5 });
		expect(near.step.within_tolerance).toBe(true);
		expect(far.step.within_tolerance).toBe(false);
		expect(near.step.distance).toBe(1);
		expect(far.step.distance).toBe(3);
		expect(DEFAULT_STEP_TOLERANCE).toBe(1);
	});

	test("the tolerance band is configurable", () => {
		const c = apiCase();
		expect(
			scoreAttribution(c, { ...perfect(c), step_index: 5 }, { tolerance: 3 }).step
				.within_tolerance,
		).toBe(true);
	});

	test("abstention is distinguished from a wrong answer", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { case_id: c.case_id, cited_steps: [] });
		expect(s.agent.abstained).toBe(true);
		expect(s.step.abstained).toBe(true);
		expect(s.step.distance).toBeNull();
		expect(s.joint_correct).toBe(false);
	});

	test("truth position exposes where in the trajectory the corpus puts failures", () => {
		expect(scoreAttribution(apiCase(), perfect(apiCase())).step.truth_position).toBeCloseTo(
			2 / 5,
			10,
		);
		const end = endLoadedCase("i1");
		expect(scoreAttribution(end, perfect(end)).step.truth_position).toBe(1);
	});
});

describe("evidence sufficiency", () => {
	test("citing every required antecedent is sufficient", () => {
		const c = apiCase();
		expect(scoreAttribution(c, perfect(c)).evidence.sufficient).toBe(true);
	});

	test("a correct attribution without sufficient evidence is flagged as unsupported", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { ...perfect(c), cited_steps: [2] });
		expect(s.joint_correct).toBe(true);
		expect(s.evidence.sufficient).toBe(false);
		expect(s.joint_supported).toBe(false);
	});

	test("padding citations costs precision but keeps recall", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { ...perfect(c), cited_steps: [0, 1, 2, 3, 4, 5] });
		expect(s.evidence.recall).toBe(1);
		expect(s.evidence.precision).toBeCloseTo(0.5, 10);
		expect(s.evidence.sufficient).toBe(true);
	});

	test("citing a step that does not exist is counted separately", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { ...perfect(c), cited_steps: [1, 2, 5, 99] });
		expect(s.evidence.out_of_range_citations).toBe(1);
	});

	test("citing nothing scores zero precision, not a free pass", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { ...perfect(c), cited_steps: [] });
		expect(s.evidence.precision).toBe(0);
		expect(s.evidence.recall).toBe(0);
		expect(s.evidence.sufficient).toBe(false);
	});
});

describe("recovery recommendation", () => {
	test("a wrong recovery does not affect the localization axes", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { ...perfect(c), recovery: "abort" });
		expect(s.recovery.correct).toBe(false);
		expect(s.recovery.predicted).toBe("abort");
		expect(s.joint_correct).toBe(true);
	});

	test("no recovery offered is an abstention", () => {
		const c = apiCase();
		const s = scoreAttribution(c, { ...perfect(c), recovery: undefined });
		expect(s.recovery.abstained).toBe(true);
		expect(s.recovery.correct).toBe(false);
	});
});

describe("baselines", () => {
	test("the last-step baseline blames the final step and its agent", () => {
		const b = lastStepBaseline(apiCase());
		expect(b.step_index).toBe(5);
		expect(b.agent).toBe("caller");
	});

	test("the first-error baseline blames the first failing step", () => {
		const b = firstErrorBaseline(apiCase());
		expect(b.step_index).toBe(5);
	});

	test("with no failing step the first-error baseline falls back to step 0", () => {
		const c = AttributionCaseSchema.parse({
			case_id: "x",
			domain: "web_file",
			steps: [{ index: 0, agent: "a", action: "go", ok: true }],
			ground_truth: { agent: "a", step_index: 0, evidence_steps: [0], recovery: "retry" },
		});
		expect(firstErrorBaseline(c).step_index).toBe(0);
	});

	test("both baselines fail the case where the fault is introduced before it surfaces", () => {
		const c = apiCase();
		expect(scoreAttribution(c, lastStepBaseline(c)).joint_correct).toBe(false);
		expect(scoreAttribution(c, firstErrorBaseline(c)).joint_correct).toBe(false);
	});

	test("the last-step baseline scores perfectly on an end-loaded case", () => {
		const c = endLoadedCase("i1");
		expect(scoreAttribution(c, lastStepBaseline(c)).joint_correct).toBe(true);
	});
});

describe("report", () => {
	const cases = [apiCase(), endLoadedCase("i1"), endLoadedCase("w1", "web_file")];

	test("a system that only matches the baseline is not credited with beating it", () => {
		const report = attributionReport(cases, cases.map(lastStepBaseline));
		expect(report.joint_lift_over_best_baseline).toBeCloseTo(0, 10);
		expect(report.verdict).toBe("matches_baselines");
	});

	test("a genuinely better system shows lift", () => {
		const report = attributionReport(cases, cases.map(perfect));
		expect(report.joint_lift_over_best_baseline).toBeGreaterThan(LIFT_TOLERANCE);
		expect(report.verdict).toBe("beats_baselines");
		expect(report.system.joint_accuracy).toBe(1);
	});

	test("a system worse than the trivial control is called out", () => {
		const report = attributionReport(
			cases,
			cases.map((c) => ({ case_id: c.case_id, agent: "nobody", step_index: 0, cited_steps: [] })),
		);
		expect(report.verdict).toBe("below_baselines");
	});

	test("baselines are always reported alongside the system", () => {
		const report = attributionReport(cases, cases.map(perfect));
		expect(report.baselines.last_step.cases).toBe(cases.length);
		expect(report.baselines.first_error.cases).toBe(cases.length);
	});

	test("mean truth position exposes an end-loaded corpus", () => {
		const endLoaded = attributionReport(
			[endLoadedCase("a"), endLoadedCase("b")],
			[],
		).mean_truth_position;
		expect(endLoaded).toBe(1);
		expect(attributionReport([apiCase()], []).mean_truth_position).toBeCloseTo(0.4, 10);
	});

	test("metrics are broken out per fixture domain", () => {
		const report = attributionReport(cases, cases.map(perfect));
		expect(report.by_domain.map((d) => d.domain).sort()).toEqual(["api", "incident", "web_file"]);
		expect(report.by_domain.every((d) => d.joint_accuracy === 1)).toBe(true);
	});

	test("unsupported-but-correct answers are visible as a gap between the two joint rates", () => {
		const report = attributionReport(
			cases,
			cases.map((c) => ({ ...perfect(c), cited_steps: [] })),
		);
		expect(report.system.joint_accuracy).toBe(1);
		expect(report.system.joint_supported_accuracy).toBe(0);
	});

	test("a case with no prediction is scored as an abstention, not skipped", () => {
		const scores = scoreCases(cases, [perfect(cases[0])]);
		expect(scores).toHaveLength(3);
		expect(summarizeScores(scores).abstention_rate).toBeCloseTo(2 / 3, 10);
	});

	test("an empty corpus reports no cases rather than dividing by zero", () => {
		const report = attributionReport([], []);
		expect(report.verdict).toBe("no_cases");
		expect(report.system.agent_accuracy).toBe(0);
		expect(report.by_domain).toEqual([]);
	});
});

describe("corpus validation", () => {
	test("a well-formed case has no issues", () => {
		expect(validateCases([apiCase()])).toEqual([]);
	});

	test("duplicate case ids are rejected", () => {
		expect(validateCases([apiCase(), apiCase()]).some((i) => i.problem.includes("duplicate"))).toBe(
			true,
		);
	});

	test("non-contiguous step indices are rejected", () => {
		const c = apiCase();
		c.steps[3].index = 9;
		expect(validateCases([c]).some((i) => i.problem.includes("not contiguous"))).toBe(true);
	});

	test("a ground-truth step outside the trajectory is rejected", () => {
		const c = apiCase();
		c.ground_truth.step_index = 42;
		expect(validateCases([c]).some((i) => i.problem.includes("outside the trajectory"))).toBe(
			true,
		);
	});

	test("a ground-truth agent that does not own the step is rejected", () => {
		const c = apiCase();
		c.ground_truth.agent = "caller";
		expect(validateCases([c]).some((i) => i.problem.includes("does not own step"))).toBe(true);
	});

	test("an evidence step outside the trajectory is rejected", () => {
		const c = apiCase();
		c.ground_truth.evidence_steps = [1, 99];
		expect(validateCases([c]).some((i) => i.problem.includes("evidence step 99"))).toBe(true);
	});

	test("a case with no evidence steps cannot score sufficiency", () => {
		const c = apiCase();
		c.ground_truth.evidence_steps = [];
		expect(validateCases([c]).some((i) => i.problem.includes("sufficiency"))).toBe(true);
	});
});

describe("row adapter", () => {
	test("normalizes nested and flat ground-truth shapes", () => {
		const cases = fromTrajectoryRows([
			{
				case_id: "r1",
				domain: "web_file",
				steps: [
					{ agent: "browser", action: "open", ok: true },
					{ agent: "writer", action: "save", error: "EACCES" },
				],
				failing_agent: "writer",
				failing_step: 1,
				evidence_steps: [1],
				recovery: "escalate",
			},
		]);
		expect(cases).toHaveLength(1);
		expect(cases[0].steps[1].ok).toBe(false);
		expect(cases[0].ground_truth.agent).toBe("writer");
	});

	test("rows without an attributable agent/step are skipped, not defaulted", () => {
		const cases = fromTrajectoryRows([
			{ case_id: "bad", domain: "api", steps: [{ agent: "a", action: "x" }] },
			{ case_id: "worse", domain: "api" },
		]);
		expect(cases).toEqual([]);
	});

	test("an unknown recovery action is rejected rather than coerced", () => {
		const cases = fromTrajectoryRows([
			{
				case_id: "r2",
				domain: "api",
				steps: [{ agent: "a", action: "x" }],
				failing_agent: "a",
				failing_step: 0,
				evidence_steps: [0],
				recovery: "think_harder",
			},
		]);
		expect(cases).toEqual([]);
	});

	test("every fixture domain is representable", () => {
		expect(ATTRIBUTION_DOMAINS).toEqual(["api", "incident", "web_file"]);
	});
});
