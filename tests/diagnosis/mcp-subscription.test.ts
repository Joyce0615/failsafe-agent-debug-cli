/**
 * MCP subscription loss & cross-talk diagnosis tests (item 52 — validate
 * acknowledged-first ordering, subscription ownership, requested event
 * types, duplicates, gaps, and graceful versus abrupt closure while
 * distinguishing confirmed loss from transport uncertainty).
 */
import { describe, expect, test } from "bun:test";
import {
	type SubscriptionEvent,
	diagnoseSubscriptionEvents,
	diagnoseSubscriptionExchange,
	renderSubscriptionReport,
} from "../../src/diagnosis/mcp-subscription.js";

describe("diagnoseSubscriptionEvents: acknowledgment-first ordering", () => {
	test("an update delivered before its own ack is a violation", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{
				sequence: 2,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				payload: "v1",
			},
			{ sequence: 3, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		expect(findings.some((f) => f.kind === "acknowledgment_order_violation")).toBe(true);
	});

	test("an update delivered after its own ack is not a violation", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				payload: "v1",
			},
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		expect(findings.find((f) => f.kind === "acknowledgment_order_violation")).toBeUndefined();
	});
});

describe("diagnoseSubscriptionEvents: cross-talk", () => {
	test("an update for a different owner than the subscription's own is cross_talk", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "client-a", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "client-a", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "client-b",
				kind: "update_delivered",
				payload: "v1",
			},
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		const crossTalk = findings.find((f) => f.kind === "cross_talk");
		expect(crossTalk).toBeDefined();
		expect(crossTalk?.detail).toContain("client-b");
	});

	test("events all from the established owner are not cross_talk", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "client-a", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "client-a", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "client-a",
				kind: "update_delivered",
				payload: "v1",
			},
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		expect(findings.find((f) => f.kind === "cross_talk")).toBeUndefined();
	});
});

describe("diagnoseSubscriptionEvents: unrequested resource", () => {
	test("an update about a different resource_uri than requested is unrequested_resource", () => {
		const events: SubscriptionEvent[] = [
			{
				sequence: 1,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "subscribe_requested",
				resource_uri: "file:///a",
			},
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				resource_uri: "file:///b",
				payload: "v1",
			},
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		expect(findings.some((f) => f.kind === "unrequested_resource")).toBe(true);
	});

	test("an update about the requested resource is not unrequested_resource", () => {
		const events: SubscriptionEvent[] = [
			{
				sequence: 1,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "subscribe_requested",
				resource_uri: "file:///a",
			},
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				resource_uri: "file:///a",
				payload: "v1",
			},
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		expect(findings.find((f) => f.kind === "unrequested_resource")).toBeUndefined();
	});
});

describe("diagnoseSubscriptionEvents: duplicate updates", () => {
	test("two updates sharing the same update_sequence with identical payloads are flagged as idempotent redelivery", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v1",
			},
			{
				sequence: 4,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v1",
			},
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		const dup = findings.find((f) => f.kind === "duplicate_update");
		expect(dup).toBeDefined();
		expect(dup?.detail).toContain("identical");
	});

	test("two updates sharing the same update_sequence with DIFFERING payloads are flagged as conflicting", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v1",
			},
			{
				sequence: 4,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v2",
			},
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		const dup = findings.find((f) => f.kind === "duplicate_update");
		expect(dup?.detail).toContain("DIFFERENT");
	});
});

describe("diagnoseSubscriptionEvents: confirmed gap vs transport uncertainty", () => {
	test("a numeric gap between consecutive update_sequence values is a confirmed_gap", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v1",
			},
			{
				sequence: 4,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 3,
				payload: "v3",
			},
		];
		const { findings, transport_uncertain_subscriptions } = diagnoseSubscriptionEvents(events);
		const gap = findings.find((f) => f.kind === "confirmed_gap");
		expect(gap).toBeDefined();
		expect(gap?.detail).toContain("2");
		expect(transport_uncertain_subscriptions).toEqual([]);
	});

	test("updates with NO update_sequence at all are reported as transport_uncertain, not as a gap finding", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				payload: "v1",
			},
			{
				sequence: 4,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				payload: "v2",
			},
		];
		const { findings, transport_uncertain_subscriptions } = diagnoseSubscriptionEvents(events);
		expect(findings.find((f) => f.kind === "confirmed_gap")).toBeUndefined();
		expect(transport_uncertain_subscriptions).toEqual(["s1"]);
	});

	test("consecutive update_sequence values with no gap are not flagged, and not transport_uncertain", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v1",
			},
			{
				sequence: 4,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 2,
				payload: "v2",
			},
		];
		const { findings, transport_uncertain_subscriptions } = diagnoseSubscriptionEvents(events);
		expect(findings.find((f) => f.kind === "confirmed_gap")).toBeUndefined();
		expect(transport_uncertain_subscriptions).toEqual([]);
	});
});

describe("diagnoseSubscriptionEvents: graceful vs abrupt closure", () => {
	test("a connection_closed with no preceding unsubscribe is abrupt_closure", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{ sequence: 3, subscription_id: "s1", owner_id: "c1", kind: "connection_closed" },
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		expect(findings.some((f) => f.kind === "abrupt_closure")).toBe(true);
	});

	test("a connection_closed preceded by unsubscribe_acked is graceful, not flagged", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{ sequence: 3, subscription_id: "s1", owner_id: "c1", kind: "unsubscribe_requested" },
			{ sequence: 4, subscription_id: "s1", owner_id: "c1", kind: "unsubscribe_acked" },
			{ sequence: 5, subscription_id: "s1", owner_id: "c1", kind: "connection_closed" },
		];
		const { findings } = diagnoseSubscriptionEvents(events);
		expect(findings.find((f) => f.kind === "abrupt_closure")).toBeUndefined();
	});
});

describe("diagnoseSubscriptionExchange: first_violation", () => {
	test("names the earliest-sequence finding across multiple subscriptions", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				payload: "v1",
			},
			// s2's violation is earlier in sequence.
			{ sequence: 0, subscription_id: "s2", owner_id: "c2", kind: "subscribe_requested" },
			{
				sequence: 1.5 as unknown as number,
				subscription_id: "s2",
				owner_id: "other-owner",
				kind: "update_delivered",
				payload: "v1",
			},
		];
		const report = diagnoseSubscriptionExchange(events);
		expect(report.first_violation).not.toBeNull();
		expect(report.first_violation?.subscription_id).toBe("s2");
	});

	test("an exchange with no violations and no transport uncertainty reports first_violation: null", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v1",
			},
		];
		const report = diagnoseSubscriptionExchange(events);
		expect(report.first_violation).toBeNull();
		expect(report.findings).toEqual([]);
	});
});

describe("renderSubscriptionReport", () => {
	test("renders the first violation, findings, and transport-uncertain subscriptions", () => {
		const events: SubscriptionEvent[] = [
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				payload: "v1",
			},
			{
				sequence: 4,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				payload: "v2",
			},
		];
		const report = diagnoseSubscriptionExchange(events);
		const text = renderSubscriptionReport(report);
		expect(text).toContain("MCP Subscription Loss & Cross-Talk Report");
		expect(text).toContain("Transport-uncertain subscriptions");
		expect(text).toContain("s1");
	});

	test("renders a clean exchange with no violations or uncertainty", () => {
		const report = diagnoseSubscriptionExchange([
			{ sequence: 1, subscription_id: "s1", owner_id: "c1", kind: "subscribe_requested" },
			{ sequence: 2, subscription_id: "s1", owner_id: "c1", kind: "subscribe_acked" },
			{
				sequence: 3,
				subscription_id: "s1",
				owner_id: "c1",
				kind: "update_delivered",
				update_sequence: 1,
				payload: "v1",
			},
		]);
		const text = renderSubscriptionReport(report);
		expect(text).toContain("No subscription violations found, and no transport uncertainty.");
	});
});
