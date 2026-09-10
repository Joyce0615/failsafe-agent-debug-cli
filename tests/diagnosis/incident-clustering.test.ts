import { describe, expect, test } from "bun:test";
import {
	type Incident,
	assessCluster,
	assign,
	causalSignature,
	clusterByCause,
	clusterByMessage,
	compareSchemes,
	messageSignature,
	normalizeComponent,
} from "../../src/diagnosis/incident-clustering.js";

function incident(overrides: Partial<Incident> & { id: string }): Incident {
	return {
		cause_category: "resource_exhaustion",
		component: "db-pool",
		causal_path: ["api", "db-pool"],
		message: "connection reset by peer",
		occurred_at_ms: 1_000_000,
		...overrides,
	};
}

describe("normalization against churn", () => {
	test("version numbers collapse", () => {
		expect(normalizeComponent("service@1.2.3")).toBe(normalizeComponent("service@1.9.0"));
		expect(normalizeComponent("service@v2.0.1-rc1")).toContain("<version>");
	});

	test("hashes collapse", () => {
		expect(normalizeComponent("worker-a3f9c21")).toBe(normalizeComponent("worker-ffeedd0"));
	});

	test("absolute home prefixes are stripped", () => {
		expect(normalizeComponent("/Users/alice/repo/src/db.py")).toBe(
			normalizeComponent("/home/bob/repo/src/db.py"),
		);
	});

	test("trailing line and column numbers collapse", () => {
		expect(normalizeComponent("src/db.py:42:9")).toBe(normalizeComponent("src/db.py:87:3"));
	});

	test("normalization is case-insensitive", () => {
		expect(normalizeComponent("DBPool")).toBe(normalizeComponent("dbpool"));
	});

	test("genuinely different components stay different", () => {
		expect(normalizeComponent("db-pool")).not.toBe(normalizeComponent("cache-pool"));
	});
});

describe("the causal signature ignores the message", () => {
	test("the same mechanism phrased three ways shares one signature", () => {
		const a = incident({ id: "a", message: "timeout after 30s" });
		const b = incident({ id: "b", message: "timed out" });
		const c = incident({ id: "c", message: "deadline exceeded" });
		expect(causalSignature(a)).toBe(causalSignature(b));
		expect(causalSignature(b)).toBe(causalSignature(c));
	});

	test("the same phrase from different components does not", () => {
		const db = incident({ id: "a", component: "db-pool", causal_path: ["api", "db-pool"] });
		const s3 = incident({
			id: "b",
			component: "s3-client",
			causal_path: ["api", "s3-client"],
			cause_category: "network_flake",
		});
		expect(db.message).toBe(s3.message);
		expect(causalSignature(db)).not.toBe(causalSignature(s3));
	});

	test("a version bump does not create a new signature", () => {
		const before = incident({ id: "a", component: "svc@1.2.3", version: "1.2.3" });
		const after = incident({ id: "b", component: "svc@1.3.0", version: "1.3.0" });
		expect(causalSignature(before)).toBe(causalSignature(after));
	});

	test("a different causal path is a different signature", () => {
		expect(
			causalSignature(incident({ id: "a", causal_path: ["api", "db-pool"] })),
		).not.toBe(causalSignature(incident({ id: "b", causal_path: ["worker", "db-pool"] })));
	});

	test("a different response to the same intervention separates two incidents", () => {
		const responds = incident({
			id: "a",
			interventions: [{ action: "restart_pool", changed: true }],
		});
		const doesNot = incident({
			id: "b",
			interventions: [{ action: "restart_pool", changed: false }],
		});
		expect(causalSignature(responds)).not.toBe(causalSignature(doesNot));
	});

	test("a failed intervention says nothing and is excluded", () => {
		const bare = incident({ id: "a" });
		const tried = incident({ id: "b", interventions: [{ action: "poke", changed: false }] });
		expect(causalSignature(bare)).toBe(causalSignature(tried));
	});

	test("intervention order does not matter", () => {
		const one = incident({
			id: "a",
			interventions: [
				{ action: "b", changed: true },
				{ action: "a", changed: true },
			],
		});
		const two = incident({
			id: "b",
			interventions: [
				{ action: "a", changed: true },
				{ action: "b", changed: true },
			],
		});
		expect(causalSignature(one)).toBe(causalSignature(two));
	});
});

describe("the message signature is an ordinary implementation", () => {
	test("numbers and quoted literals are templated", () => {
		expect(messageSignature(incident({ id: "a", message: "failed after 30 retries" }))).toBe(
			messageSignature(incident({ id: "b", message: "failed after 5 retries" })),
		);
		expect(messageSignature(incident({ id: "a", message: "no key 'email'" }))).toBe(
			messageSignature(incident({ id: "b", message: "no key 'name'" })),
		);
	});

	test("different phrasings of one mechanism stay apart, which is the flaw", () => {
		expect(messageSignature(incident({ id: "a", message: "timed out" }))).not.toBe(
			messageSignature(incident({ id: "b", message: "deadline exceeded" })),
		);
	});
});

describe("clustering", () => {
	const corpus: Incident[] = [
		incident({ id: "i1", message: "timed out", occurred_at_ms: 1000 }),
		incident({ id: "i2", message: "deadline exceeded", occurred_at_ms: 2000 }),
		incident({ id: "i3", message: "timeout after 30s", occurred_at_ms: 3000 }),
		incident({
			id: "i4",
			component: "s3-client",
			causal_path: ["api", "s3-client"],
			cause_category: "network_flake",
			message: "timed out",
			occurred_at_ms: 4000,
		}),
	];

	test("causal clustering joins the three phrasings and excludes the impostor", () => {
		const result = clusterByCause(corpus);
		expect(result.clusters).toHaveLength(1);
		expect(result.clusters[0].incidents.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
		expect(result.singletons.map((i) => i.id)).toEqual(["i4"]);
	});

	test("message clustering does the opposite", () => {
		const result = clusterByMessage(corpus);
		const timedOut = result.clusters.find((c) => c.signature.includes("timed out"))!;
		expect(timedOut.incidents.map((i) => i.id)).toEqual(["i1", "i4"]);
	});

	test("a cluster records its span, components, and message variety", () => {
		const cluster = clusterByCause(corpus).clusters[0];
		expect(cluster.first_seen_ms).toBe(1000);
		expect(cluster.last_seen_ms).toBe(3000);
		expect(cluster.components).toEqual(["db-pool"]);
		expect(cluster.message_variants).toBe(3);
	});

	test("singletons are counted apart from clusters", () => {
		const result = clusterByCause(corpus);
		expect(result.clustered_fraction).toBe(0.75);
		expect(result.clusters.length + result.singletons.length).toBe(2);
	});

	test("clusters are ordered largest first, deterministically", () => {
		const result = clusterByCause([...corpus].reverse());
		expect(result.clusters[0].incidents.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
	});

	test("an empty corpus clusters to nothing without dividing by zero", () => {
		const result = clusterByCause([]);
		expect(result.clusters).toEqual([]);
		expect(result.clustered_fraction).toBe(0);
	});
});

describe("comparing the two schemes is the evidence", () => {
	const corpus: Incident[] = [
		incident({ id: "db1", message: "timed out" }),
		incident({ id: "db2", message: "deadline exceeded" }),
		incident({
			id: "s3",
			component: "s3-client",
			causal_path: ["api", "s3-client"],
			cause_category: "network_flake",
			message: "timed out",
		}),
	];

	test("a false merge by message is enumerated with its direction", () => {
		const comparison = compareSchemes(corpus);
		const merge = comparison.disagreements.find((d) => d.kind === "merged_by_message")!;
		expect(merge.pair.sort()).toEqual(["db1", "s3"]);
		expect(merge.detail).toContain("different causes");
	});

	test("a false split by message is enumerated too", () => {
		const comparison = compareSchemes(corpus);
		const split = comparison.disagreements.find((d) => d.kind === "merged_by_cause")!;
		expect(split.pair.sort()).toEqual(["db1", "db2"]);
	});

	test("the counts and summary reflect both directions", () => {
		const comparison = compareSchemes(corpus);
		expect(comparison.false_merges).toBeGreaterThan(0);
		expect(comparison.false_splits).toBeGreaterThan(0);
		expect(comparison.summary).toContain("merge");
		expect(comparison.summary).toContain("split");
	});

	test("a corpus where the schemes agree says the change buys nothing", () => {
		const agreeing = [
			incident({ id: "a", message: "timed out" }),
			incident({ id: "b", message: "timed out" }),
		];
		const comparison = compareSchemes(agreeing);
		expect(comparison.disagreements).toEqual([]);
		expect(comparison.summary).toContain("buys nothing");
	});

	test("both clusterings are returned for inspection", () => {
		const comparison = compareSchemes(corpus);
		expect(comparison.causal.scheme).toBe("causal");
		expect(comparison.message.scheme).toBe("message");
		expect(comparison.incidents).toBe(3);
	});
});

describe("assignment", () => {
	const clusters = clusterByCause([
		incident({ id: "a", occurred_at_ms: 1000 }),
		incident({ id: "b", occurred_at_ms: 2000 }),
	]).clusters;

	test("a matching incident joins the existing cluster with a stated reason", () => {
		const result = assign(incident({ id: "c", message: "totally different words" }), clusters);
		expect(result.joined_existing).toBe(true);
		expect(result.reason).toContain("existing cluster with 2 incident(s)");
	});

	test("a non-matching incident opens a new cluster and says why", () => {
		const result = assign(
			incident({ id: "d", component: "cache", causal_path: ["api", "cache"] }),
			clusters,
		);
		expect(result.joined_existing).toBe(false);
		expect(result.reason).toContain("no existing cluster");
	});

	test("matching is exact, never fuzzy", () => {
		// A near-miss on the causal path does not join; fuzzy thresholds are how
		// clusters silently drift into containing unrelated problems.
		const result = assign(
			incident({ id: "e", causal_path: ["api", "db-pool", "socket"] }),
			clusters,
		);
		expect(result.joined_existing).toBe(false);
	});

	test("assignment against no clusters always opens a new one", () => {
		expect(assign(incident({ id: "f" }), []).joined_existing).toBe(false);
	});
});

describe("cluster health", () => {
	test("a healthy cluster reports its rate and no warnings", () => {
		const cluster = clusterByCause([
			incident({ id: "a", occurred_at_ms: 0 }),
			incident({ id: "b", occurred_at_ms: 86_400_000 }),
		]).clusters[0];
		const health = assessCluster(cluster);
		expect(health.size).toBe(2);
		expect(health.rate_per_day).toBeCloseTo(2, 5);
		expect(health.warnings).toEqual([]);
		expect(health.too_coarse).toBe(false);
	});

	test("a signature spanning two components is flagged as too coarse", () => {
		// Both normalize to the same string, which is the over-normalization case.
		const cluster = clusterByCause([
			incident({ id: "a", component: "worker-aaaaaaa", occurred_at_ms: 0 }),
			incident({ id: "b", component: "worker-bbbbbbb", occurred_at_ms: 1000 }),
		]).clusters[0];
		const health = assessCluster(cluster);
		expect(health.too_coarse).toBe(true);
		expect(health.warnings[0]).toContain("normalization is too aggressive");
	});

	test("identical timestamps are called out as one incident recorded twice", () => {
		const cluster = clusterByCause([
			incident({ id: "a", occurred_at_ms: 5000 }),
			incident({ id: "b", occurred_at_ms: 5000 }),
		]).clusters[0];
		expect(assessCluster(cluster).warnings.some((w) => w.includes("not a recurring one"))).toBe(
			true,
		);
	});

	test("message variety under one causal signature is reported as the scheme's value", () => {
		const cluster = clusterByCause([
			incident({ id: "a", message: "timed out", occurred_at_ms: 0 }),
			incident({ id: "b", message: "deadline exceeded", occurred_at_ms: 1000 }),
		]).clusters[0];
		expect(assessCluster(cluster).message_variants).toBe(2);
	});
});
