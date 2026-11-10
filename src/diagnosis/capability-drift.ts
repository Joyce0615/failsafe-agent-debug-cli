/**
 * Diagnose progressive-discovery and skill drift (item 36, item 102 in this
 * project's own module-header numbering convention — confirmed as the next
 * free number via `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t'
 * ' -k2 -n -u`, highest prior use was item 101 from item 20's
 * `cross-provider-replay.ts`).
 *
 * `grep -rln "capability.*catalog\|skill.*version\|policy.*scope\|ETag\|etag"
 * src --include="*.ts"` before this module matched only
 * `debug/variable-privacy.ts`'s unrelated DAP "scope" vocabulary (locals/
 * globals/closure — a debugger scope, not a tool's authorization scope) and
 * `cli/dump.ts`'s unrelated doc-comment use of the word "progressive"
 * (progressive *disclosure* of a stored failure's raw log, nothing to do
 * with tool discovery). `telemetry/mcp-conventions.ts` (item 11) already
 * names `FAILSAFE_MCP_TOOL_NAMES` as the one place Failsafe's OWN registered
 * tool catalog lives, but has no notion of comparing two catalogs over time,
 * and no project module compares an agent's VISIBLE capability surface
 * (which tools/skills it can see, at which version, under which schema and
 * policy scope, with which cache freshness) across two points in observation.
 * `diagnosis/drift.ts` (item 86) already diffs dependency/ABI/schema/
 * configuration/infrastructure snapshots and already separates "nothing
 * changed" from "not compared", but its `EnvironmentSnapshot` has no concept
 * of a tool, a policy scope, or a cache validator — composing a FIFTH drift
 * category onto it would smuggle a different kind of fact (what an agent can
 * currently invoke) into a module about what an environment currently runs.
 *
 * This item asks a narrower, sharper question than "what changed": of
 * everything that changed in a capability catalog, which kind of change
 * explains THIS failure — a tool the agent tried to call that is no longer
 * there, a tool whose contract moved out from under an already-written call,
 * or a tool the agent was never meant to have that showed up anyway. Three
 * named change kinds, deliberately not folded into one severity score,
 * mirroring `drift.ts`'s own "no overall goodness number" discipline for
 * ranked drift:
 *
 * - `missing_tool`: a tool present in `before` is absent in `after`. An
 *   agent whose plan still names it will get a tool-not-found failure that
 *   has nothing to do with its own reasoning.
 * - `stale_tool`: a tool present in both, but its `version`, `schema_hash`,
 *   or `policy_scope` changed in a way that is NOT a pure scope widening
 *   (see below). A call shaped for the old contract can fail against the
 *   new one even though the tool's name never moved.
 * - `unexpectedly_expanded`: a tool that is new (`new_tool`) or that gained
 *   a policy scope it did not have before (`policy_scope_widened`). This is
 *   reported as its own kind, never silently folded into `stale_tool`,
 *   because the item's own wording ("unexpectedly expanded") names it as a
 *   DISTINCT risk from staleness — a tool an agent now has whether or not
 *   its own planning ever asked for the expansion.
 *
 * A removed policy scope and an added policy scope on the SAME tool in the
 * SAME diff are two separate findings (one `stale_tool`, one
 * `unexpectedly_expanded`), never one blended "scope changed" fact — exactly
 * the discipline `diagnosis/recovery-packet.ts` (item 100)'s
 * `measureRerunImprovement` already applies to authority-expansion
 * detection (never averaged against an improving pass rate), generalized
 * here to catalog scopes instead of command allow-lists.
 *
 * **Cached ETags are a confound, not a change signal.** A catalog fetched
 * through a conditional-GET cache can report the SAME `catalog_etag` on two
 * genuinely different polls (the cache served a stale body under a
 * still-valid-looking validator) — `stale_catalog_cache` names exactly this:
 * the catalog claims nothing changed (identical `catalog_etag`) while the
 * entries supplied for comparison actually did. This is reported
 * independently of, and in addition to, whatever entry-level findings the
 * diff already produced — the point is not to suppress the real diff but to
 * flag that the catalog's OWN freshness signal cannot be trusted for this
 * comparison, mirroring `trace/telemetry-gaps.ts` (item 32)'s
 * `confirmed_absence` vs `unknown_evidence` split: a positive cache-identity
 * claim contradicted by observed content is itself evidence of something,
 * not merely absence of a signal.
 *
 * `attributeCapabilityFailure` names the MISSING-tool kind ahead of a
 * stale/expanded match when several kinds match the same failure context —
 * a tool that is simply gone explains a tool-not-found error more directly
 * than a tool whose shape merely moved, mirroring `diagnosis/drift.ts`'s own
 * evidence-based (never heuristic-severity) ranking discipline, scoped here
 * to a fixed three-kind priority instead of a continuous relevance score
 * because there are only three kinds to order.
 *
 * Pure: no fs/network. Callers (CLI/MCP) supply already-captured
 * `CapabilityCatalog` snapshots — this module never calls `tools/list`
 * itself, mirroring `diagnosis/drift.ts`'s own "compares snapshots that were
 * collected elsewhere" posture.
 */

export type CapabilityEntry = {
	name: string;
	version?: string;
	/** Hash of the tool's input/output schema, when the caller computed one. */
	schema_hash?: string;
	/** Policy scopes this tool is currently authorized under. */
	policy_scope?: string[];
};

export type CapabilityCatalog = {
	/** Where this catalog was observed from, e.g. "mcp", "a2a". */
	source: string;
	captured_at: string;
	/** Cache validator reported alongside this catalog poll, if any. */
	catalog_etag?: string;
	entries: CapabilityEntry[];
};

export const CAPABILITY_DRIFT_KINDS = [
	"missing_tool",
	"stale_tool",
	"unexpectedly_expanded",
	"stale_catalog_cache",
] as const;
export type CapabilityDriftKind = (typeof CAPABILITY_DRIFT_KINDS)[number];

export type StaleDimension = "version" | "schema" | "policy_scope";

export type CapabilityChange =
	| { kind: "missing_tool"; tool: string; detail: string }
	| {
			kind: "stale_tool";
			tool: string;
			dimension: StaleDimension;
			before?: string;
			after?: string;
			detail: string;
	  }
	| {
			kind: "unexpectedly_expanded";
			tool: string;
			reason: "new_tool" | "policy_scope_widened";
			added_scopes: string[];
			detail: string;
	  }
	| { kind: "stale_catalog_cache"; catalog_etag: string; detail: string };

function scopeChanges(
	tool: string,
	before: string[] | undefined,
	after: string[] | undefined,
): CapabilityChange[] {
	const changes: CapabilityChange[] = [];
	const beforeSet = new Set(before ?? []);
	const afterSet = new Set(after ?? []);

	const removed = [...beforeSet].filter((s) => !afterSet.has(s)).sort();
	const added = [...afterSet].filter((s) => !beforeSet.has(s)).sort();

	if (removed.length > 0) {
		changes.push({
			kind: "stale_tool",
			tool,
			dimension: "policy_scope",
			before: [...beforeSet].sort().join(","),
			after: [...afterSet].sort().join(","),
			detail: `tool '${tool}' lost policy scope(s): ${removed.join(", ")}`,
		});
	}
	if (added.length > 0) {
		changes.push({
			kind: "unexpectedly_expanded",
			tool,
			reason: "policy_scope_widened",
			added_scopes: added,
			detail: `tool '${tool}' gained policy scope(s) it did not have before: ${added.join(", ")}`,
		});
	}
	return changes;
}

/**
 * Diff two capability catalogs, reporting each of missing/stale/expanded
 * tools plus any evidence that the catalog's own cache validator cannot be
 * trusted for this comparison.
 *
 * Deliberately NOT keyed by source — a caller comparing two catalogs from
 * different sources (e.g. before an MCP server upgrade, after) is exactly
 * the comparison this item asks for; `source` is carried through on each
 * input for a caller's own bookkeeping but never gates the diff.
 */
export function diffCapabilityCatalogs(
	before: CapabilityCatalog,
	after: CapabilityCatalog,
): CapabilityChange[] {
	const changes: CapabilityChange[] = [];
	const beforeByName = new Map(before.entries.map((e) => [e.name, e]));
	const afterByName = new Map(after.entries.map((e) => [e.name, e]));
	const names = [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort();

	for (const name of names) {
		const b = beforeByName.get(name);
		const a = afterByName.get(name);

		if (b && !a) {
			changes.push({
				kind: "missing_tool",
				tool: name,
				detail: `tool '${name}' was visible before and is no longer in the catalog`,
			});
			continue;
		}
		if (!b && a) {
			changes.push({
				kind: "unexpectedly_expanded",
				tool: name,
				reason: "new_tool",
				added_scopes: [...(a.policy_scope ?? [])].sort(),
				detail: `tool '${name}' is new and was not visible before`,
			});
			continue;
		}
		if (!b || !a) continue; // unreachable; satisfies narrowing

		if (b.version !== a.version) {
			changes.push({
				kind: "stale_tool",
				tool: name,
				dimension: "version",
				before: b.version,
				after: a.version,
				detail: `tool '${name}' version changed: ${b.version ?? "(none)"} -> ${a.version ?? "(none)"}`,
			});
		}
		if (b.schema_hash !== a.schema_hash) {
			changes.push({
				kind: "stale_tool",
				tool: name,
				dimension: "schema",
				before: b.schema_hash,
				after: a.schema_hash,
				detail: `tool '${name}' schema_hash changed: ${b.schema_hash ?? "(none)"} -> ${a.schema_hash ?? "(none)"}`,
			});
		}
		changes.push(...scopeChanges(name, b.policy_scope, a.policy_scope));
	}

	// Cached-ETag confound: the catalog claims nothing changed (identical
	// catalog_etag) while entry-level changes were found above. Reported in
	// addition to, never instead of, the real findings.
	if (
		before.catalog_etag !== undefined &&
		before.catalog_etag === after.catalog_etag &&
		changes.length > 0
	) {
		changes.push({
			kind: "stale_catalog_cache",
			catalog_etag: before.catalog_etag,
			detail: `catalog_etag '${before.catalog_etag}' is unchanged but ${changes.length} entry-level change(s) were observed; this catalog's own cache validator cannot be trusted for this comparison`,
		});
	}

	return changes;
}

export type CapabilityFailureContext = {
	/** The tool name the failing call actually targeted, when known precisely. */
	tool_name?: string;
	/** The error text, searched for a tool name when `tool_name` is absent. */
	error_text: string;
};

export type CapabilityAttribution = {
	attributed: boolean;
	/** The highest-priority matching change, when attributed. */
	kind?: CapabilityDriftKind;
	tool?: string;
	/** Every change that matched, in priority order. */
	matches: CapabilityChange[];
};

/** missing_tool explains a tool-not-found failure more directly than a shape change. */
const KIND_PRIORITY: Record<CapabilityDriftKind, number> = {
	missing_tool: 0,
	unexpectedly_expanded: 1,
	stale_tool: 2,
	stale_catalog_cache: 3,
};

function changeTool(change: CapabilityChange): string | undefined {
	return change.kind === "stale_catalog_cache" ? undefined : change.tool;
}

/**
 * Attribute a failure to a named capability-drift change: either the
 * failure's precisely-known `tool_name`, or (absent that) a tool name
 * mentioned in the error text. `stale_catalog_cache` findings are always
 * attributed regardless of a name match, because an untrustworthy cache
 * validator calls the whole comparison into question independent of which
 * specific tool a failure happened to target.
 */
export function attributeCapabilityFailure(
	changes: CapabilityChange[],
	context: CapabilityFailureContext,
): CapabilityAttribution {
	const lowerError = context.error_text.toLowerCase();
	const lowerToolName = context.tool_name?.toLowerCase();

	const matches = changes.filter((change) => {
		if (change.kind === "stale_catalog_cache") return true;
		const tool = changeTool(change);
		if (!tool) return false;
		const lowerTool = tool.toLowerCase();
		if (lowerToolName !== undefined) return lowerTool === lowerToolName;
		return lowerTool.length > 0 && lowerError.includes(lowerTool);
	});

	if (matches.length === 0) {
		return { attributed: false, matches: [] };
	}

	const sorted = [...matches].sort((x, y) => KIND_PRIORITY[x.kind] - KIND_PRIORITY[y.kind]);
	const top = sorted[0];
	return {
		attributed: true,
		kind: top.kind,
		tool: changeTool(top),
		matches: sorted,
	};
}

export type CapabilityDriftReport = {
	changes: CapabilityChange[];
	by_kind: Partial<Record<CapabilityDriftKind, number>>;
	attribution: CapabilityAttribution;
};

/**
 * Compose the diff and the attribution into one report — the "diagnose" half
 * of this item, combining the two functions above exactly as a caller
 * (CLI/MCP) would.
 */
export function diagnoseCapabilityDrift(
	before: CapabilityCatalog,
	after: CapabilityCatalog,
	context: CapabilityFailureContext,
): CapabilityDriftReport {
	const changes = diffCapabilityCatalogs(before, after);
	const by_kind: Partial<Record<CapabilityDriftKind, number>> = {};
	for (const change of changes) by_kind[change.kind] = (by_kind[change.kind] ?? 0) + 1;
	const attribution = attributeCapabilityFailure(changes, context);
	return { changes, by_kind, attribution };
}

/** Render a human-readable summary of a capability drift report. */
export function renderCapabilityDriftReport(report: CapabilityDriftReport): string {
	const lines: string[] = ["# Capability Drift Report", ""];
	if (report.changes.length === 0) {
		lines.push("No capability drift detected.");
		return lines.join("\n");
	}
	for (const kind of CAPABILITY_DRIFT_KINDS) {
		const count = report.by_kind[kind] ?? 0;
		if (count > 0) lines.push(`- ${kind}: ${count}`);
	}
	lines.push("");
	if (report.attribution.attributed) {
		lines.push(
			`**Attributed:** ${report.attribution.kind} ${report.attribution.tool ? `(tool: ${report.attribution.tool})` : ""}`,
		);
	} else {
		lines.push("**Not attributed:** no change names or implicates the failing tool/error text.");
	}
	lines.push("", "## Changes", "");
	for (const change of report.changes) lines.push(`- ${change.detail}`);
	return lines.join("\n");
}
