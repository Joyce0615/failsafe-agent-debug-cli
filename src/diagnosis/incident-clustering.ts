/**
 * Clustering recurring incidents by causal signature rather than message
 * similarity (item 71).
 *
 * Message-similarity clustering is the default everywhere and it is wrong in
 * both directions at once:
 *
 * - It **merges** unrelated incidents. "connection reset by peer" from a
 *   database driver and from an object-store client produce the same string and
 *   land in the same bucket, so a genuine database outage is filed under a
 *   long-running S3 flakiness ticket and nobody looks at it.
 * - It **splits** related ones. "timeout after 30s", "timed out", and
 *   "deadline exceeded" are three phrasings of one mechanism from three
 *   libraries, and they become three separate recurring incidents that each
 *   look too small to prioritize.
 *
 * A causal signature is built from what the diagnosis concluded — cause
 * category, faulty component, the shape of the causal path, and the outcomes of
 * any interventions — and not from the text. That fixes both directions.
 *
 * The module deliberately implements *both* schemes and reports where they
 * disagree, because "we switched to causal clustering" is a claim, and
 * `compareSchemes` is the evidence for it: the pairs message clustering merges
 * that causal clustering separates, and vice versa. Without that comparison the
 * change is unfalsifiable.
 *
 * Two further commitments:
 *
 * - **Signatures are normalized against churn.** A version bump, a line-number
 *   shift, or an absolute path must not create a new cluster; an incident that
 *   recurs after a deploy is the same incident.
 * - **A cluster of one is not a cluster.** Singletons are reported separately
 *   rather than inflating the cluster count, because "we have 400 recurring
 *   incidents" is a very different statement from "we have 12 recurring
 *   incidents and 388 one-offs".
 *
 * Pure: no I/O.
 */

export type Incident = {
	id: string;
	/** Diagnosed cause class, e.g. `resource_exhaustion`, `config_drift`. */
	cause_category: string;
	/** The component the diagnosis blamed. */
	component: string;
	/** Ordered causal path, coarsest first, e.g. `["api", "db", "pool"]`. */
	causal_path: string[];
	/** Raw error text. Used only by the message scheme, never by the causal one. */
	message: string;
	/** Interventions tried and whether the symptom moved. */
	interventions?: Array<{ action: string; changed: boolean }>;
	occurred_at_ms: number;
	/** Release the incident occurred on, normalized away by the signature. */
	version?: string;
};

/**
 * Normalize a component or path segment against ordinary churn.
 *
 * Version numbers, line numbers, hashes, and absolute path prefixes all change
 * between two occurrences of the same incident, and a signature that includes
 * them produces a fresh cluster after every deploy — which looks exactly like a
 * new problem and is the single most common way incident clustering becomes
 * useless.
 */
export function normalizeComponent(value: string): string {
	return value
		.replace(/^\/(?:home|Users|opt|var|srv)\/[^/]+\//, "")
		.replace(/[0-9a-f]{7,40}/gi, "<hash>")
		.replace(/\bv?\d+\.\d+(\.\d+)?(-[\w.]+)?\b/g, "<version>")
		.replace(/:\d+(:\d+)?$/, "")
		.replace(/\d+/g, "<n>")
		.toLowerCase();
}

/**
 * Causal signature.
 *
 * The intervention outcomes are included because two incidents that look
 * identical but respond differently to the same intervention are, by the only
 * definition that matters, different problems. Only *successful* interventions
 * are included: a failed intervention says nothing about the mechanism, only
 * about what somebody tried.
 */
export function causalSignature(incident: Incident): string {
	const path = incident.causal_path.map(normalizeComponent).join(">");
	const effective = (incident.interventions ?? [])
		.filter((i) => i.changed)
		.map((i) => i.action)
		.sort()
		.join(",");
	return [incident.cause_category, normalizeComponent(incident.component), path, effective].join(
		"|",
	);
}

/**
 * Message signature, for comparison only.
 *
 * A deliberately ordinary implementation — lowercase, strip numbers and quoted
 * literals — because the point is to compare against what teams actually do,
 * not against a strawman.
 */
export function messageSignature(incident: Incident): string {
	return incident.message
		.toLowerCase()
		.replace(/'[^']*'|"[^"]*"/g, "<str>")
		.replace(/\b\d+(\.\d+)?\b/g, "<n>")
		.replace(/\s+/g, " ")
		.trim();
}

export type Cluster = {
	signature: string;
	incidents: Incident[];
	first_seen_ms: number;
	last_seen_ms: number;
	/** Distinct components involved; >1 means the signature is too coarse. */
	components: string[];
	/** Distinct raw messages; >1 is the point, not a problem. */
	message_variants: number;
};

export type ClusteringResult = {
	scheme: "causal" | "message";
	/** Groups with more than one incident. */
	clusters: Cluster[];
	/** Groups of exactly one, reported apart so counts stay honest. */
	singletons: Incident[];
	/** Incidents in clusters divided by total. */
	clustered_fraction: number;
};

function buildClusters(
	incidents: Incident[],
	signature: (i: Incident) => string,
	scheme: ClusteringResult["scheme"],
): ClusteringResult {
	const groups = new Map<string, Incident[]>();
	for (const incident of incidents) {
		const key = signature(incident);
		const list = groups.get(key);
		if (list) list.push(incident);
		else groups.set(key, [incident]);
	}

	const clusters: Cluster[] = [];
	const singletons: Incident[] = [];
	for (const [key, group] of groups) {
		if (group.length === 1) {
			singletons.push(group[0]);
			continue;
		}
		clusters.push({
			signature: key,
			incidents: [...group].sort((a, b) => a.occurred_at_ms - b.occurred_at_ms),
			first_seen_ms: Math.min(...group.map((i) => i.occurred_at_ms)),
			last_seen_ms: Math.max(...group.map((i) => i.occurred_at_ms)),
			components: [...new Set(group.map((i) => i.component))].sort(),
			message_variants: new Set(group.map((i) => messageSignature(i))).size,
		});
	}

	clusters.sort(
		(a, b) => b.incidents.length - a.incidents.length || a.signature.localeCompare(b.signature),
	);
	singletons.sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.id.localeCompare(b.id));

	const inClusters = clusters.reduce((sum, c) => sum + c.incidents.length, 0);
	return {
		scheme,
		clusters,
		singletons,
		clustered_fraction: incidents.length > 0 ? inClusters / incidents.length : 0,
	};
}

export function clusterByCause(incidents: Incident[]): ClusteringResult {
	return buildClusters(incidents, causalSignature, "causal");
}

export function clusterByMessage(incidents: Incident[]): ClusteringResult {
	return buildClusters(incidents, messageSignature, "message");
}

export type SchemeDisagreement = {
	/** Two incident ids the schemes classify differently. */
	pair: [string, string];
	/**
	 * `merged_by_message` — message clustering joins them, causal separates.
	 *   These are the false merges: unrelated failures sharing a phrase.
	 * `merged_by_cause` — causal joins them, message separates.
	 *   These are the false splits: one mechanism reported three ways.
	 */
	kind: "merged_by_message" | "merged_by_cause";
	detail: string;
};

export type SchemeComparison = {
	incidents: number;
	causal: ClusteringResult;
	message: ClusteringResult;
	disagreements: SchemeDisagreement[];
	false_merges: number;
	false_splits: number;
	summary: string;
};

/**
 * Compare the two schemes over the same incidents.
 *
 * This is the evidence for the item's premise. Every pair the schemes treat
 * differently is enumerated with its direction, so a reader can check the claim
 * rather than take it — and can see, if it happens, that on their corpus the
 * two schemes agree and the change buys nothing.
 */
export function compareSchemes(incidents: Incident[]): SchemeComparison {
	const causal = clusterByCause(incidents);
	const message = clusterByMessage(incidents);

	const causalKey = new Map(incidents.map((i) => [i.id, causalSignature(i)]));
	const messageKey = new Map(incidents.map((i) => [i.id, messageSignature(i)]));

	const disagreements: SchemeDisagreement[] = [];
	for (let i = 0; i < incidents.length; i++) {
		for (let j = i + 1; j < incidents.length; j++) {
			const a = incidents[i];
			const b = incidents[j];
			const sameCause = causalKey.get(a.id) === causalKey.get(b.id);
			const sameMessage = messageKey.get(a.id) === messageKey.get(b.id);
			if (sameCause === sameMessage) continue;

			disagreements.push(
				sameMessage
					? {
							pair: [a.id, b.id],
							kind: "merged_by_message",
							detail: `'${a.component}' and '${b.component}' share the phrasing "${a.message.slice(0, 50)}" but have different causes (${a.cause_category} vs ${b.cause_category})`,
						}
					: {
							pair: [a.id, b.id],
							kind: "merged_by_cause",
							detail: `both are ${a.cause_category} in ${a.component}, reported as "${a.message.slice(0, 40)}" and "${b.message.slice(0, 40)}"`,
						},
			);
		}
	}

	const falseMerges = disagreements.filter((d) => d.kind === "merged_by_message").length;
	const falseSplits = disagreements.filter((d) => d.kind === "merged_by_cause").length;

	return {
		incidents: incidents.length,
		causal,
		message,
		disagreements,
		false_merges: falseMerges,
		false_splits: falseSplits,
		summary:
			disagreements.length === 0
				? "the two schemes agree on every pair: on this corpus causal clustering buys nothing over message clustering"
				: `message clustering would merge ${falseMerges} pair(s) that have different causes and split ${falseSplits} pair(s) that share one`,
	};
}

export type Assignment = {
	incident_id: string;
	/** Signature of the cluster joined, or the new one created. */
	signature: string;
	joined_existing: boolean;
	/** Why this incident went where it did, in one sentence. */
	reason: string;
};

/**
 * Assign a new incident to an existing cluster or open a new one.
 *
 * Exact signature match only. Fuzzy matching is tempting and is how clusters
 * drift: a threshold that admits a near-miss today admits its near-miss
 * tomorrow, and after a month the cluster contains three unrelated problems and
 * nobody can say when that happened.
 */
export function assign(incident: Incident, clusters: Cluster[]): Assignment {
	const signature = causalSignature(incident);
	const existing = clusters.find((c) => c.signature === signature);
	return {
		incident_id: incident.id,
		signature,
		joined_existing: existing !== undefined,
		reason: existing
			? `matches the causal signature of an existing cluster with ${existing.incidents.length} incident(s), last seen at ${existing.last_seen_ms}`
			: `no existing cluster has the causal signature '${signature}'`,
	};
}

export type ClusterHealth = {
	signature: string;
	size: number;
	/** More than one component under one signature means it is too coarse. */
	too_coarse: boolean;
	/** Message variety under one causal signature: the value the scheme adds. */
	message_variants: number;
	/** Milliseconds between first and last occurrence. */
	span_ms: number;
	/** Occurrences per day over the cluster's span. */
	rate_per_day: number;
	warnings: string[];
};

/**
 * Assess a cluster.
 *
 * `too_coarse` matters: a causal signature covering two components means the
 * component was normalized too aggressively, and the resulting cluster is
 * making the same mistake message clustering makes. Catching it here is cheaper
 * than discovering it during an incident review.
 */
export function assessCluster(cluster: Cluster): ClusterHealth {
	const span = cluster.last_seen_ms - cluster.first_seen_ms;
	const days = Math.max(span / 86_400_000, 1 / 24);
	const warnings: string[] = [];

	if (cluster.components.length > 1) {
		warnings.push(
			`one causal signature spans ${cluster.components.length} components (${cluster.components.join(", ")}): the normalization is too aggressive and this cluster is merging distinct failures`,
		);
	}
	if (span === 0) {
		warnings.push(
			"every occurrence has the same timestamp: this is probably one incident recorded several times, not a recurring one",
		);
	}

	return {
		signature: cluster.signature,
		size: cluster.incidents.length,
		too_coarse: cluster.components.length > 1,
		message_variants: cluster.message_variants,
		span_ms: span,
		rate_per_day: cluster.incidents.length / days,
		warnings,
	};
}
