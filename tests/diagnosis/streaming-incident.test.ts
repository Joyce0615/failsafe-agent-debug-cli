import { describe, expect, test } from "bun:test";
import {
	type HypothesisTree,
	type Observation,
	buildHypothesisTree,
} from "../../src/diagnosis/hypothesis.js";
import {
	type AlertChurnBudget,
	type StreamEvent,
	ingestLiveEvent,
	newStreamingSession,
	streamingSnapshot,
} from "../../src/diagnosis/streaming-incident.js";

function sampleTree(): HypothesisTree {
	return buildHypothesisTree({
		failure_id: "f1",
		primary_location: { file: "src/auth/session.py", line: 42, symbol: "validate" },
		frames: [
			{ file: "src/auth/session.py", line: 42, function: "validate", is_application: true },
			{ file: "src/auth/tokens.py", line: 17, function: "decode", is_application: true },
		],
		root_cause: { category: "key_error", explanation: "'email' is absent", confidence: 0.6 },
		test_name: "test_session_validate",
		command: "pytest tests/test_auth.py",
	});
}

function observation(
	outcome: Observation["outcome"],
	likelihoodIfTrue = 0.95,
	likelihoodIfFalse = 0.1,
): Observation {
	return {
		detail: `probe result: ${outcome}`,
		outcome,
		observed_at: "2026-08-13T00:00:00.000Z",
		likelihood_if_true: likelihoodIfTrue,
		likelihood_if_false: likelihoodIfFalse,
	};
}

describe("ingestLiveEvent", () => {
	test("a confirming observation updates the hypothesis tree and may emit an alert", () => {
		let session = newStreamingSession("f1", sampleTree());
		const moduleId = "f1:module";
		const event: StreamEvent = { sequence: 1, observation: { hypothesis_id: moduleId, observation: observation("confirms") } };
		session = ingestLiveEvent(session, event);
		expect(session.processed).toBe(1);
		const h = session.tree.hypotheses.find((x) => x.id === moduleId);
		expect(h?.posterior).toBeGreaterThan(0.6);
	});

	test("a hypothesis that flips from confirmed back to refuted produces an explicit retraction, not a silent overwrite", () => {
		let session = newStreamingSession("f1", sampleTree());
		const moduleId = "f1:module";
		// Drive the module hypothesis to confirmed with a strong confirming observation.
		session = ingestLiveEvent(session, {
			sequence: 1,
			observation: { hypothesis_id: moduleId, observation: observation("confirms", 0.999, 0.001) },
		});
		expect(session.tree.hypotheses.find((h) => h.id === moduleId)?.status).toBe("confirmed");
		expect(session.alerts.some((a) => a.hypothesis_id === moduleId)).toBe(true);

		// A later refuting observation flips it to refuted.
		session = ingestLiveEvent(session, {
			sequence: 2,
			observation: { hypothesis_id: moduleId, observation: observation("refutes") },
		});
		expect(session.tree.hypotheses.find((h) => h.id === moduleId)?.status).toBe("refuted");
		expect(session.retractions).toHaveLength(1);
		expect(session.retractions[0]?.hypothesis_id).toBe(moduleId);
		expect(session.retractions[0]?.previous_status).toBe("confirmed");
		expect(session.retractions[0]?.new_status).toBe("refuted");
	});

	test("alert churn is bounded: once max_alerts is reached, further leading-hypothesis changes are suppressed, not silently dropped", () => {
		let session = newStreamingSession("f1", sampleTree());
		const budget: AlertChurnBudget = { max_alerts: 1, cooldown_events: 0 };
		const fileId = "f1:file";
		const altFileId = "f1:alt-file";

		// First event: the file hypothesis becomes leading -> 1 alert.
		session = ingestLiveEvent(
			session,
			{ sequence: 1, observation: { hypothesis_id: fileId, observation: observation("confirms", 0.9, 0.5) } },
			budget,
		);
		const alertsAfterFirst = session.alerts.length;
		expect(alertsAfterFirst).toBeGreaterThanOrEqual(1);

		// Second event: push the sibling hypothesis's posterior above the file's,
		// changing the leading hypothesis again -- this should be suppressed
		// under max_alerts: 1, not silently ignored.
		session = ingestLiveEvent(
			session,
			{ sequence: 2, observation: { hypothesis_id: altFileId, observation: observation("confirms", 0.8, 0.2) } },
			budget,
		);
		expect(session.alerts.length).toBe(alertsAfterFirst);
		expect(session.suppressed.length).toBeGreaterThanOrEqual(1);
		expect(session.suppressed[0]?.reason).toBe("max_alerts_reached");
	});
});

describe("streamingSnapshot", () => {
	test("replaying the same event sequence through a fresh session yields the same snapshot hash", () => {
		const events: StreamEvent[] = [
			{ sequence: 1, observation: { hypothesis_id: "f1:module", observation: observation("confirms") } },
			{ sequence: 2, observation: { hypothesis_id: "f1:file", observation: observation("inconclusive", 0.5, 0.5) } },
		];

		let sessionA = newStreamingSession("f1", sampleTree());
		for (const e of events) sessionA = ingestLiveEvent(sessionA, e);

		let sessionB = newStreamingSession("f1", sampleTree());
		for (const e of events) sessionB = ingestLiveEvent(sessionB, e);

		const snapA = streamingSnapshot(sessionA);
		const snapB = streamingSnapshot(sessionB);
		expect(snapA.snapshot_hash).toBe(snapB.snapshot_hash);
		expect(snapA.processed).toBe(2);
	});
});
