/**
 * Item 9 -- agent communication fault injection: drop, duplication, reorder,
 * stale context, malformed artifacts, and delayed approvals.
 */
import { describe, expect, test } from "bun:test";
import {
	COMM_FAULT_KINDS,
	type AgentMessage,
	type CommFaultScenario,
	OBSERVABILITY_EXPECTATIONS,
	assessCommResilience,
	commBaseline,
	createMailbox,
	injectCommFault,
	processMessage,
	runCommFaultSuite,
} from "../../src/testing/comm-fault-injection.js";

const BASELINE = commBaseline(42, 10);

function scenario(kind: CommFaultScenario["kind"], target_ids: string[], magnitude?: number): CommFaultScenario {
	return { kind, target_ids, ...(magnitude !== undefined ? { magnitude } : {}) };
}

describe("every condition declares what must stay observable", () => {
	test("all six kinds have an expectation", () => {
		for (const kind of COMM_FAULT_KINDS) {
			expect(OBSERVABILITY_EXPECTATIONS[kind].length).toBeGreaterThan(20);
		}
	});
});

describe("the control arm", () => {
	test("a clean baseline stream is accepted end to end with no faults flagged", () => {
		const mailbox = createMailbox();
		const outcomes = BASELINE.map((m) => processMessage(mailbox, m));
		expect(outcomes.every((o) => o.accepted)).toBe(true);
		expect(outcomes.every((o) => o.fault_detected === null)).toBe(true);
	});
});

describe("drop", () => {
	test("a dropped message leaves a sequence gap that the next message flags", () => {
		const targetId = BASELINE[3]!.id;
		const result = assessCommResilience(BASELINE, scenario("drop", [targetId]));
		expect(result.verdict).toBe("handled_loudly");
		expect(result.target_outcomes.length).toBeGreaterThan(0);
		expect(result.target_outcomes[0]!.fault_detected).toBe("drop");
	});

	test("the message that reveals the gap is itself accepted, not rejected", () => {
		const targetId = BASELINE[3]!.id;
		const actual = injectCommFault(BASELINE, scenario("drop", [targetId]));
		const mailbox = createMailbox();
		const outcomes = actual.map((m) => processMessage(mailbox, m));
		const revealing = outcomes.find((o) => o.fault_detected === "drop");
		expect(revealing).toBeDefined();
		expect(revealing!.accepted).toBe(true);
	});
});

describe("duplicate", () => {
	test("a duplicated message's second copy is rejected as a duplicate", () => {
		const targetId = BASELINE[2]!.id;
		const result = assessCommResilience(BASELINE, scenario("duplicate", [targetId]));
		expect(result.verdict).toBe("handled_loudly");
		const rejected = result.target_outcomes.filter((o) => o.fault_detected === "duplicate");
		expect(rejected.length).toBe(1);
	});
});

describe("reorder", () => {
	test("a message moved behind a later one from the same sender is flagged as reordered", () => {
		const targetId = BASELINE[1]!.id;
		const result = assessCommResilience(BASELINE, scenario("reorder", [targetId], 3));
		expect(result.verdict).toBe("handled_loudly");
		expect(result.target_outcomes[0]!.fault_detected).toBe("reorder");
	});
});

describe("stale_context", () => {
	test("a message authored against an older context version than one already acted on is rejected", () => {
		// Pick a target late enough in the stream that an earlier message from
		// the same sender has already advanced the context version.
		const laterMessages = BASELINE.filter((m) => m.from === "agent-a" && m.kind !== "approval_response");
		const targetId = laterMessages[laterMessages.length - 1]!.id;
		const result = assessCommResilience(BASELINE, scenario("stale_context", [targetId], 1));
		// Only meaningful if the context actually advanced somewhere in the
		// baseline; commBaseline(42, 10) is deterministic, so assert the
		// precondition explicitly rather than assuming it.
		const versions = new Set(laterMessages.map((m) => m.context_version));
		expect(versions.size).toBeGreaterThan(1);
		expect(result.verdict).toBe("handled_loudly");
		expect(result.target_outcomes[0]!.fault_detected).toBe("stale_context");
	});
});

describe("malformed_artifact", () => {
	test("an artifact missing its sha256 field is rejected", () => {
		const artifactMsg = BASELINE.find((m) => m.kind === "artifact");
		expect(artifactMsg).toBeDefined();
		const result = assessCommResilience(BASELINE, scenario("malformed_artifact", [artifactMsg!.id]));
		expect(result.verdict).toBe("handled_loudly");
		expect(result.target_outcomes[0]!.fault_detected).toBe("malformed_artifact");
	});
});

describe("delayed_approval", () => {
	test("an approval response arriving after its own request's deadline is rejected", () => {
		const responseMsg = BASELINE.find((m) => m.kind === "approval_response");
		expect(responseMsg).toBeDefined();
		// response_deadline_ms is request_sent_at + 500; delay by 1000ms to push
		// well past it.
		const result = assessCommResilience(BASELINE, scenario("delayed_approval", [responseMsg!.id], 1000));
		expect(result.verdict).toBe("handled_loudly");
		expect(result.target_outcomes[0]!.fault_detected).toBe("delayed_approval");
	});

	test("an approval response delayed but still inside the deadline is accepted (tested directly against processMessage)", () => {
		const responseMsg = BASELINE.find((m) => m.kind === "approval_response");
		expect(responseMsg).toBeDefined();
		const actual = injectCommFault(BASELINE, scenario("delayed_approval", [responseMsg!.id], 50));
		const mailbox = createMailbox();
		let outcome;
		for (const m of actual) outcome = processMessage(mailbox, m);
		expect(outcome!.message_id).toBe(responseMsg!.id);
		expect(outcome!.accepted).toBe(true);
		expect(outcome!.fault_detected).toBeNull();
	});
});

describe("runCommFaultSuite", () => {
	test("reports every untested kind when only some scenarios run", () => {
		const result = runCommFaultSuite(BASELINE, [scenario("drop", [BASELINE[0]!.id])]);
		expect(result.untested).toContain("duplicate");
		expect(result.caveats.some((c) => c.includes("were not exercised"))).toBe(true);
	});

	test("a fully covered suite with every fault caught reports no silently_corrupted scenarios", () => {
		const artifactMsg = BASELINE.find((m) => m.kind === "artifact")!;
		const responseMsg = BASELINE.find((m) => m.kind === "approval_response")!;
		const laterMessages = BASELINE.filter((m) => m.from === "agent-a" && m.kind !== "approval_response");
		const staleTarget = laterMessages[laterMessages.length - 1]!;
		const scenarios: CommFaultScenario[] = [
			scenario("drop", [BASELINE[0]!.id]),
			scenario("duplicate", [BASELINE[2]!.id]),
			scenario("reorder", [BASELINE[1]!.id], 3),
			scenario("stale_context", [staleTarget.id], 1),
			scenario("malformed_artifact", [artifactMsg.id]),
			scenario("delayed_approval", [responseMsg.id], 1000),
		];
		const result = runCommFaultSuite(BASELINE, scenarios);
		expect(result.untested).toEqual([]);
		expect(result.silently_corrupted).toEqual([]);
	});
});

describe("the obvious implementation gap this item's TDD caught", () => {
	// A naive reorder detector would compare a message's seq only against the
	// immediately-preceding message in the ARRIVAL stream, not against the
	// highest seq seen so far from that sender. That misses a message that
	// arrives behind one two-or-more slots ahead of it (reordered by more
	// than one position), because the immediately-preceding arrival might
	// itself be an even-later message, making the comparison look like a
	// forward (correct-looking) jump instead of a backward one.
	test("a message reordered behind two others (not just one) from the same sender is still caught", () => {
		const targetId = BASELINE[0]!.id;
		const result = assessCommResilience(BASELINE, scenario("reorder", [targetId], 2));
		expect(result.verdict).toBe("handled_loudly");
		expect(result.target_outcomes[0]!.fault_detected).toBe("reorder");
	});
});
