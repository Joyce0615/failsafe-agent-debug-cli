/**
 * Protocol-deprecation migration forensics (item 59, module-header
 * numbering: item 124, confirmed next-free via `grep -rohE "item
 * [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u | tail`, highest
 * prior being item 123 from item 58's `retry-amplification.ts`).
 *
 * The MCP 2026-07-28 changelog (cited in this project's own research
 * list) deprecated or changed five surfaces this project already has
 * SEPARATE live-detection modules for: `mrtr.ts` (item 51) models the
 * multi-round tool-response state machine the changelog introduced;
 * `mcp-subscription.ts` (item 52) models the `resources/subscribe`
 * ack-before-deliver lifecycle it formalized; `telemetry/mcp-
 * conventions.ts` (item 11) already enumerates fields a stdio server
 * cannot populate truthfully. None of the three, nor anything else
 * (`grep -rln "protocol.deprecation|SDK translation|client.assumption|
 * server.nonconformance|SSE.resume|migration.forensic" src --include=
 * "*.ts" -i` returned nothing before this module), compares a PRE-
 * migration ("legacy") trace of one operation against a POST-migration
 * ("current") trace of the SAME operation and assigns blame for a
 * divergence from the spec's own expected post-migration behavior.
 *
 * The raw packet-level pairing of a legacy transcript against a
 * current transcript of the same operation_id is a parsing problem
 * already owned by whatever transport layer captured the two traces
 * (the five dimensions this module reasons over are exactly the ones
 * `mrtr.ts`/`mcp-subscription.ts`/`telemetry/mcp-conventions.ts`
 * already extract facts about). This module's job — and the gap
 * nothing else filled — is the ATTRIBUTION step once a caller has
 * already paired the two traces and extracted, per dimension, what
 * the current run's observed behavior actually was, what the spec
 * expects it to be post-migration, and whether each of the two
 * endpoints' own messages still carried the legacy shape.
 *
 * Five migration dimensions, one `MigrationObservation` per
 * (operation, dimension) pair, matching this item's own list exactly:
 * `mrtr`, `result_type`, `stateless_metadata`, `subscription`,
 * `sse_resume`.
 *
 * `classifyMigrationDivergence` first checks whether the observed
 * current behavior already matches the spec's expected post-migration
 * behavior — if so there is NOTHING to attribute, and the function
 * returns `null` rather than manufacturing a finding for a dimension
 * that migrated cleanly (this is why the top-level report separates
 * `migrated_cleanly` dimensions from `findings`, mirroring this
 * project's "untested is not the same statement as clean" discipline,
 * here inverted: "migrated cleanly" is its own fact, not a non-event).
 * When the behaviors diverge, blame is assigned from the TWO
 * independent provenance flags a caller supplies — whether the
 * CLIENT's own message for this exchange still carried the legacy
 * shape, and whether the SERVER's own message still carried the
 * legacy shape:
 *
 * - client legacy, server current → `client_assumption`: the server
 *   did its part; the client is the one still speaking the old
 *   dialect.
 * - server legacy, client current → `server_nonconformance`:
 *   symmetric — the client sent a current-shape request; the server
 *   replied in the old shape anyway.
 * - BOTH legacy → `insufficient_evidence`: neither endpoint has
 *   adopted the new shape at all, so there is no single party whose
 *   migration failure explains the divergence more than the other's —
 *   asserting either one over the other here would be a guess wearing
 *   an attribution it never earned, mirroring `workflow-executor-
 *   attribution.ts`'s (item 57) own refusal to assert a main effect
 *   from an ambiguous 50/50 split.
 * - BOTH current (neither message carries the legacy shape) yet the
 *   overall observed behavior STILL diverges from spec → `sdk_
 *   translation_defect`: both endpoints did their own part correctly,
 *   so something sitting between them — an SDK, proxy, or compat
 *   shim — is the only remaining place the divergence could have been
 *   introduced.
 *
 * Pure: no fs/network/process. Caller supplies every
 * `MigrationObservation`; this module never parses a raw trace or
 * decides what the spec expects on its own.
 */

export const MIGRATION_DIMENSIONS = [
	"mrtr",
	"result_type",
	"stateless_metadata",
	"subscription",
	"sse_resume",
] as const;
export type MigrationDimension = (typeof MIGRATION_DIMENSIONS)[number];

export type MigrationObservation = {
	operation_id: string;
	dimension: MigrationDimension;
	/** What the CURRENT (post-migration) trace actually exhibited for this dimension. */
	current_behavior: string;
	/** What the MCP 2026-07-28 changelog expects a migrated implementation to exhibit. */
	spec_expected_behavior: string;
	/** Whether the CLIENT's own message in the current trace still carries the pre-migration shape. */
	client_sent_legacy_shape: boolean;
	/** Whether the SERVER's own message in the current trace still carries the pre-migration shape. */
	server_replied_legacy_shape: boolean;
};

export type MigrationAttribution =
	| "client_assumption"
	| "server_nonconformance"
	| "sdk_translation_defect"
	| "insufficient_evidence";

export type MigrationFinding = {
	operation_id: string;
	dimension: MigrationDimension;
	attribution: MigrationAttribution;
	current_behavior: string;
	spec_expected_behavior: string;
	detail: string;
};

/**
 * Classify one dimension's divergence (or lack thereof) for one
 * operation. Returns `null` when the current trace already matches
 * the spec's expected post-migration behavior — nothing to attribute.
 */
export function classifyMigrationDivergence(
	observation: MigrationObservation,
): MigrationFinding | null {
	if (observation.current_behavior === observation.spec_expected_behavior) {
		return null;
	}

	const { client_sent_legacy_shape: clientLegacy, server_replied_legacy_shape: serverLegacy } =
		observation;

	let attribution: MigrationAttribution;
	let detail: string;
	if (clientLegacy && !serverLegacy) {
		attribution = "client_assumption";
		detail = `operation '${observation.operation_id}' dimension '${observation.dimension}': the server replied in the current post-migration shape, but the client's own message still carries the legacy shape -- the client has not adopted the new semantics`;
	} else if (serverLegacy && !clientLegacy) {
		attribution = "server_nonconformance";
		detail = `operation '${observation.operation_id}' dimension '${observation.dimension}': the client sent a current post-migration shape message, but the server's own reply still carries the legacy shape -- the server has not adopted the new semantics`;
	} else if (clientLegacy && serverLegacy) {
		attribution = "insufficient_evidence";
		detail = `operation '${observation.operation_id}' dimension '${observation.dimension}': neither the client's nor the server's own message adopted the current post-migration shape, so no single endpoint's migration failure explains the divergence more than the other's`;
	} else {
		attribution = "sdk_translation_defect";
		detail = `operation '${observation.operation_id}' dimension '${observation.dimension}': both the client's and the server's own messages already carry the current post-migration shape, yet the overall observed behavior still diverges from the spec's expectation -- something between the two endpoints (an SDK, proxy, or compatibility shim) introduced the divergence`;
	}

	return {
		operation_id: observation.operation_id,
		dimension: observation.dimension,
		attribution,
		current_behavior: observation.current_behavior,
		spec_expected_behavior: observation.spec_expected_behavior,
		detail,
	};
}

export type MigrationForensicsReport = {
	operation_id: string;
	findings: MigrationFinding[];
	/** Dimensions where the current trace already matched spec expectations: nothing to attribute. */
	migrated_cleanly: MigrationDimension[];
	dimensions_analyzed: number;
};

/**
 * Pair every observation for one operation_id and attribute each
 * dimension's divergence independently -- never a single combined
 * verdict for the whole operation, since a migration can succeed on
 * one surface (e.g. `result_type`) while failing on another (e.g.
 * `subscription`) for the exact same operation.
 */
export function diagnoseMigrationForensics(
	observations: MigrationObservation[],
): MigrationForensicsReport[] {
	const byOperation = new Map<string, MigrationObservation[]>();
	for (const obs of observations) {
		const list = byOperation.get(obs.operation_id);
		if (list) list.push(obs);
		else byOperation.set(obs.operation_id, [obs]);
	}

	const reports: MigrationForensicsReport[] = [];
	for (const [operationId, obsList] of byOperation) {
		const findings: MigrationFinding[] = [];
		const migratedCleanly: MigrationDimension[] = [];
		for (const obs of obsList) {
			const finding = classifyMigrationDivergence(obs);
			if (finding) {
				findings.push(finding);
			} else {
				migratedCleanly.push(obs.dimension);
			}
		}
		reports.push({
			operation_id: operationId,
			findings,
			migrated_cleanly: migratedCleanly.sort(),
			dimensions_analyzed: obsList.length,
		});
	}

	return reports.sort((a, b) => a.operation_id.localeCompare(b.operation_id));
}

/** Render a human-readable migration-forensics report across all operations. */
export function renderMigrationForensicsReport(reports: MigrationForensicsReport[]): string {
	const lines: string[] = ["# Protocol-Deprecation Migration Forensics", ""];
	for (const report of reports) {
		lines.push(`## Operation '${report.operation_id}'`);
		lines.push(`dimensions_analyzed: ${report.dimensions_analyzed}`);
		if (report.migrated_cleanly.length > 0) {
			lines.push(`migrated_cleanly: ${report.migrated_cleanly.join(", ")}`);
		}
		for (const finding of report.findings) {
			lines.push(`- [${finding.dimension}] ${finding.attribution}: ${finding.detail}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
