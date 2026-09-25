/**
 * Dependency, ABI, schema, configuration, and infrastructure drift detection
 * (item 86).
 *
 * Diffing two environments is easy and produces two hundred lines of which one
 * matters. The work is in the four things a plain diff gets wrong.
 *
 * 1. **Relevance must be evidence-based, not heuristic.** Ranking drift by
 *    "importance" — major version bumps first, say — puts the framework upgrade
 *    above the transitive JSON parser that actually broke. `rankDrift` scores by
 *    whether the changed component appears in the failure's stack, is named in
 *    the error text, or owns a file the diagnosis pointed at. A change with none
 *    of those is reported as unlinked, and unlinked changes are the majority.
 *
 * 2. **Transitive drift is invisible in a manifest diff.** The manifest says
 *    `^1.2.0` before and after while the lock moved 1.2.3 → 1.9.0. A comparison
 *    with only manifests will report "no dependency drift" and be wrong;
 *    `detectDependencyDrift` records which source it had and refuses to make
 *    the stronger claim without a lockfile.
 *
 * 3. **ABI drift is not version drift.** A native module rebuilt against a
 *    different interpreter ABI has the same version and a different binary
 *    contract, and the failure is an import error that mentions no version at
 *    all. ABI tags are compared separately for exactly that reason.
 *
 * 4. **No drift is a finding.** "Nothing changed between the working run and
 *    the failing one" eliminates an entire class of cause and is more useful
 *    than most of what a diff produces. It is reported as a result rather than
 *    as an empty list.
 *
 * Pure: compares snapshots that were collected elsewhere.
 */

export const DRIFT_CATEGORIES = [
	"dependency",
	"abi",
	"schema",
	"configuration",
	"infrastructure",
] as const;
export type DriftCategory = (typeof DRIFT_CATEGORIES)[number];

export type DriftChange = {
	category: DriftCategory;
	/** The thing that changed: a package, a table, a config key, a node pool. */
	component: string;
	before?: string;
	after?: string;
	kind: "added" | "removed" | "changed";
	/** Where this was observed: `manifest`, `lockfile`, `runtime`, … */
	source: string;
};

export type EnvironmentSnapshot = {
	label: string;
	/** Direct dependency constraints, e.g. `{"requests": "^2.0"}`. */
	manifest?: Record<string, string>;
	/** Resolved versions including transitives, e.g. `{"urllib3": "2.1.0"}`. */
	lockfile?: Record<string, string>;
	/** ABI tags per native component, e.g. `{"numpy": "cp311-x86_64"}`. */
	abi_tags?: Record<string, string>;
	/** Schema version or migration head per store. */
	schema?: Record<string, string>;
	configuration?: Record<string, string>;
	/** Node pools, images, regions, instance types. */
	infrastructure?: Record<string, string>;
};

function diffMaps(
	before: Record<string, string> | undefined,
	after: Record<string, string> | undefined,
	category: DriftCategory,
	source: string,
): DriftChange[] {
	if (!before && !after) return [];
	const a = before ?? {};
	const b = after ?? {};
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	const changes: DriftChange[] = [];

	for (const key of keys) {
		const from = a[key];
		const to = b[key];
		if (from === to) continue;
		changes.push({
			category,
			component: key,
			...(from !== undefined ? { before: from } : {}),
			...(to !== undefined ? { after: to } : {}),
			kind: from === undefined ? "added" : to === undefined ? "removed" : "changed",
			source,
		});
	}
	return changes;
}

export type DependencyDriftResult = {
	changes: DriftChange[];
	/** Which sources were available to compare. */
	sources: string[];
	/**
	 * True when only manifests were available. A manifest comparison cannot see
	 * a transitive move under an unchanged constraint, which is the most common
	 * shape of dependency drift there is.
	 */
	transitives_invisible: boolean;
	caveats: string[];
};

/**
 * Compare dependencies, distinguishing what was actually observable.
 *
 * The distinction is the point. `{"requests": "^2.0"}` on both sides tells you
 * nothing about whether `urllib3` moved from 2.0.7 to 2.2.0 underneath it, and
 * a comparison that reports "no drift" from that is not merely incomplete, it
 * is asserting something it has no basis for.
 */
export function detectDependencyDrift(
	before: EnvironmentSnapshot,
	after: EnvironmentSnapshot,
): DependencyDriftResult {
	const sources: string[] = [];
	const changes: DriftChange[] = [];

	if (before.manifest || after.manifest) {
		sources.push("manifest");
		changes.push(...diffMaps(before.manifest, after.manifest, "dependency", "manifest"));
	}
	if (before.lockfile || after.lockfile) {
		sources.push("lockfile");
		changes.push(...diffMaps(before.lockfile, after.lockfile, "dependency", "lockfile"));
	}

	const manifestOnly = sources.includes("manifest") && !sources.includes("lockfile");
	const caveats: string[] = [];
	if (manifestOnly) {
		caveats.push(
			"only manifests were compared; a transitive dependency can move under an unchanged constraint, so 'no dependency drift' cannot be concluded from this",
		);
	}
	if (sources.length === 0) {
		caveats.push("neither snapshot carried dependency information; nothing was compared");
	}

	return {
		changes,
		sources,
		transitives_invisible: manifestOnly || sources.length === 0,
		caveats,
	};
}

/**
 * Compare ABI tags.
 *
 * Separate from version comparison because a native module rebuilt against a
 * different interpreter has the same version string and an incompatible binary
 * contract. The resulting failure is an import or symbol error that mentions no
 * version at all, which is why version-only drift detection never finds it.
 */
export function detectAbiDrift(
	before: EnvironmentSnapshot,
	after: EnvironmentSnapshot,
): { changes: DriftChange[]; caveats: string[] } {
	const changes = diffMaps(before.abi_tags, after.abi_tags, "abi", "runtime");
	const caveats: string[] = [];

	if (!before.abi_tags && !after.abi_tags) {
		caveats.push(
			"no ABI tags were captured; a native module rebuilt against a different interpreter would be invisible here and its failure would mention no version",
		);
	}
	for (const change of changes) {
		if (change.kind === "changed") {
			caveats.push(
				`'${change.component}' changed ABI tag (${change.before} → ${change.after}); this is a binary-contract change and can occur with no version change at all`,
			);
		}
	}
	return { changes, caveats };
}

export type FailureContext = {
	/** Files appearing in the failure's stack or diagnosis. */
	stack_files: string[];
	/** The error text, searched for component names. */
	error_text: string;
	/** Components the failure's stack frames belong to, when known. */
	implicated_components: string[];
};

export type RankedDrift = {
	change: DriftChange;
	/** 0..1. Composed of named signals, not an opaque weighting. */
	relevance: number;
	/** Which signals fired. Empty means unlinked. */
	signals: string[];
	linked: boolean;
};

/** Relevance below which a change is treated as unlinked to the failure. */
export const LINK_THRESHOLD = 0.2;

/**
 * Rank drift by evidence of a link to the failure.
 *
 * Deliberately not by severity. A major version bump of something the failure
 * never touches is less interesting than a patch bump of the module in the
 * stack, and severity-ranked drift reports put them the other way round every
 * time.
 */
export function rankDrift(changes: DriftChange[], context: FailureContext): RankedDrift[] {
	const text = context.error_text.toLowerCase();
	const implicated = new Set(context.implicated_components.map((c) => c.toLowerCase()));

	return changes
		.map((change) => {
			const name = change.component.toLowerCase();
			const signals: string[] = [];
			let relevance = 0;

			if (implicated.has(name)) {
				signals.push("the failure's stack frames belong to this component");
				relevance += 0.6;
			}
			if (name.length > 2 && text.includes(name)) {
				signals.push("the error text names this component");
				relevance += 0.3;
			}
			if (context.stack_files.some((file) => file.toLowerCase().includes(name))) {
				signals.push("a file in the stack is inside this component");
				relevance += 0.3;
			}
			if (change.category === "abi" && change.kind === "changed") {
				signals.push("an ABI change breaks a binary contract regardless of what the stack shows");
				relevance += 0.4;
			}
			if (change.category === "schema") {
				signals.push("a schema change alters data the application did not expect to move");
				relevance += 0.2;
			}

			relevance = Math.min(1, relevance);
			return { change, relevance, signals, linked: relevance >= LINK_THRESHOLD };
		})
		.sort(
			(a, b) =>
				b.relevance - a.relevance ||
				a.change.category.localeCompare(b.change.category) ||
				a.change.component.localeCompare(b.change.component),
		);
}

export type DriftReport = {
	before: string;
	after: string;
	/** Every change found, ranked. */
	ranked: RankedDrift[];
	/** Changes with a link to the failure. */
	linked: RankedDrift[];
	/** Changes with none. Usually most of them. */
	unlinked: number;
	by_category: Array<{ category: DriftCategory; changes: number; linked: number }>;
	/** True when nothing changed at all — which is itself a strong finding. */
	no_drift: boolean;
	caveats: string[];
	summary: string;
};

/**
 * Compare two snapshots and rank what changed against the failure.
 *
 * `no_drift` is a first-class result. "Nothing changed between the working run
 * and the failing one" eliminates dependency, configuration, and infrastructure
 * causes in one line and is more informative than most non-empty diffs — but
 * only when the comparison actually covered those categories, which is why the
 * caveats about missing snapshots are checked before the claim is made.
 */
export function detectDrift(
	before: EnvironmentSnapshot,
	after: EnvironmentSnapshot,
	context: FailureContext,
): DriftReport {
	const dependency = detectDependencyDrift(before, after);
	const abi = detectAbiDrift(before, after);

	const changes: DriftChange[] = [
		...dependency.changes,
		...abi.changes,
		...diffMaps(before.schema, after.schema, "schema", "migration"),
		...diffMaps(before.configuration, after.configuration, "configuration", "config"),
		...diffMaps(before.infrastructure, after.infrastructure, "infrastructure", "platform"),
	];

	const ranked = rankDrift(changes, context);
	const linked = ranked.filter((r) => r.linked);

	const caveats = [...dependency.caveats, ...abi.caveats];
	const uncovered = DRIFT_CATEGORIES.filter((category) => {
		switch (category) {
			case "dependency":
				return !before.manifest && !before.lockfile && !after.manifest && !after.lockfile;
			case "abi":
				return !before.abi_tags && !after.abi_tags;
			case "schema":
				return !before.schema && !after.schema;
			case "configuration":
				return !before.configuration && !after.configuration;
			case "infrastructure":
				return !before.infrastructure && !after.infrastructure;
		}
	});
	if (uncovered.length > 0) {
		caveats.push(
			`no data for ${uncovered.join(", ")}; those categories were not compared and cannot be excluded`,
		);
	}
	if (changes.length > 0 && linked.length === 0) {
		caveats.push(
			`${changes.length} change(s) were found and none is linked to the failure by any signal; drift is present but there is no evidence it is relevant`,
		);
	}

	const noDrift = changes.length === 0;
	return {
		before: before.label,
		after: after.label,
		ranked,
		linked,
		unlinked: ranked.length - linked.length,
		by_category: DRIFT_CATEGORIES.map((category) => ({
			category,
			changes: ranked.filter((r) => r.change.category === category).length,
			linked: linked.filter((r) => r.change.category === category).length,
		})).filter((row) => row.changes > 0),
		no_drift: noDrift,
		caveats,
		summary: noDrift
			? uncovered.length === 0
				? "nothing changed in any compared category: dependency, ABI, schema, configuration, and infrastructure causes are all eliminated"
				: `nothing changed in the compared categories, but ${uncovered.join(", ")} were not compared and remain possible`
			: `${changes.length} change(s), ${linked.length} with a link to the failure and ${ranked.length - linked.length} without`,
	};
}
