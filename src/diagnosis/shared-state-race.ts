/**
 * Reconstruct shared-state read/write races (item 53, module-header
 * numbering: item 118, confirmed next-free via `grep -rohE "item [0-9]+"
 * src --include="*.ts" | sort -t' ' -k2 -n -u | tail`, highest prior
 * being item 117 from item 52's `mcp-subscription.ts`).
 *
 * `grep -rln "write.skew\|stale.read\|lost.update\|linearization\|
 * read.write.set\|readset\|writeset" src --include="*.ts" -i` before
 * this module matched only `async-lifecycle-race.ts`'s (item 47) own
 * prose explaining that its reconstructed task schedule is "ONE valid
 * linearization, not THE schedule" -- no module modeled versioned reads
 * and writes against shared files, artifacts, or resources at all.
 *
 * Four distinct anomalies, kept separate because each needs different
 * evidence and implies a different fix:
 *
 * 1. **Stale read.** A read observing version `v` on a resource, when
 *    the resource's NEAREST later-committed write (version `v' > v`)
 *    is known via `partial-order.ts`'s (item 8) `happensBefore` to have
 *    committed causally before the read. Reusing `happensBefore`/
 *    `concurrent` UNMODIFIED as the one source of ordering truth, same
 *    discipline `async-lifecycle-race.ts` already established. When the
 *    read and that nearest write are instead `concurrent()` (order
 *    genuinely undetermined), whether the read is stale depends on
 *    which legal linearization you pick -- under one it is a real bug,
 *    under the other nothing happened at all. This module does not
 *    report a finding for that pair at all (not "finding with
 *    blame=null" -- genuinely no finding), and instead names the pair
 *    in `abstained_pairs`, mirroring `authorization-drift.ts`'s
 *    (item 44) `lost_policy_source` and `mcp-subscription.ts`'s
 *    (item 52) `transport_uncertain_subscriptions` discipline of giving
 *    an honest "cannot tell" its own bucket rather than forcing a verdict.
 * 2. **Lost update.** A write's `based_on_version` is the version it
 *    actually computed its new value from. A write whose
 *    `based_on_version` is older than another write that ALREADY
 *    committed on the same resource (before this write's own version)
 *    proves -- from version numbers alone, no causal-order evidence
 *    needed -- that this write silently discarded the intervening
 *    write's change. Version assignment for a single resource is
 *    itself a serialization point (you cannot be assigned version N
 *    without version N-1 already existing), so this is a DEFINITE
 *    finding with unambiguous blame (the later write), never abstained.
 * 3. **Write skew.** The classic cross-resource anti-dependency cycle
 *    (Adya's G2 anomaly): group g1 reads resource X (missing g2's
 *    later write to X) and writes resource Y; group g2 reads resource Y
 *    (missing g1's later write to Y) and writes resource X. Each
 *    group's own decision was locally valid given what it had read;
 *    the anomaly only exists in the combination. `blamed_actor_id` is
 *    ALWAYS `null` for this kind -- this is the literature's own
 *    framing of write skew, and inventing a single actor to blame here
 *    would misattribute a structural interaction as one party's fault.
 * 4. **Structural race.** Two writes to the SAME resource with no
 *    read-modify-write relationship to compare (so lost-update's check
 *    does not apply) that are nonetheless `concurrent()` per the
 *    partial order -- i.e. nothing in the supplied evidence explains
 *    how a definite commit order was assigned between them.
 *    `blamed_actor_id` is `null`: the evidence cannot say which write
 *    "should" have won.
 *
 * Pure: no fs/network/process. The caller supplies already-captured
 * `ResourceOperation[]` and an already-reconstructed `PartialOrderResult`
 * (typically from `partial-order.ts`'s `reconstructPartialOrder`); this
 * module never re-derives causal ordering itself.
 */
import type { PartialOrderResult } from "./partial-order.js";

export type ResourceOperation = {
	id: string;
	actor_id: string;
	resource_id: string;
	/**
	 * Groups a read with the write it informed -- e.g. the same tool
	 * call or transaction. Required for write-skew detection; a read or
	 * write with no `group_id` is simply never considered as half of a
	 * write-skew pair (there is no evidence it was part of the same
	 * decision as any write/read elsewhere).
	 */
	group_id?: string;
	kind: "read" | "write";
	/**
	 * Read: the version this operation observed. Write: the NEW version
	 * number this write commits (caller-assigned, monotonically
	 * increasing per resource -- this is what "versioned" means here).
	 */
	version: number;
	/**
	 * Write only: the version this write's value was computed from --
	 * what this actor last read on this resource before issuing the
	 * write. Absent means an unconditional overwrite with no
	 * read-modify-write basis, so it is never a lost-update candidate
	 * (there is nothing to compare it against).
	 */
	based_on_version?: number;
};

export const RACE_FINDING_KINDS = [
	"stale_read",
	"lost_update",
	"write_skew",
	"structural_race",
] as const;
export type RaceFindingKind = (typeof RACE_FINDING_KINDS)[number];

export type RaceFinding = {
	kind: RaceFindingKind;
	resource_ids: string[];
	evidence_ids: string[];
	/** The actor at fault, or `null` when the evidence genuinely cannot assign blame to one party (write skew: always; structural race: always). */
	blamed_actor_id: string | null;
	detail: string;
};

export type AbstainedPair = {
	read_id: string;
	write_id: string;
	reason: string;
};

export type RaceDiagnosis = {
	findings: RaceFinding[];
	/** Read/write pairs where a stale-read pattern is CANDIDATE but relative timing is genuinely undetermined -- reporting a finding for either side would pick a linearization. */
	abstained_pairs: AbstainedPair[];
};

function byResource(operations: ResourceOperation[]): Map<string, ResourceOperation[]> {
	const groups = new Map<string, ResourceOperation[]>();
	for (const op of operations) {
		const group = groups.get(op.resource_id);
		if (group) group.push(op);
		else groups.set(op.resource_id, [op]);
	}
	return groups;
}

function byGroup(operations: ResourceOperation[]): Map<string, ResourceOperation[]> {
	const groups = new Map<string, ResourceOperation[]>();
	for (const op of operations) {
		if (op.group_id === undefined) continue;
		const group = groups.get(op.group_id);
		if (group) group.push(op);
		else groups.set(op.group_id, [op]);
	}
	return groups;
}

function detectStaleReads(
	operations: ResourceOperation[],
	order: PartialOrderResult,
): { findings: RaceFinding[]; abstained: AbstainedPair[] } {
	const findings: RaceFinding[] = [];
	const abstained: AbstainedPair[] = [];
	const resourceGroups = byResource(operations);

	for (const [resourceId, ops] of resourceGroups) {
		const reads = ops.filter((o) => o.kind === "read");
		const writes = ops.filter((o) => o.kind === "write").sort((a, b) => a.version - b.version);

		for (const read of reads) {
			const nextWrite = writes.find((w) => w.version > read.version);
			if (!nextWrite) continue;

			if (order.happensBefore(nextWrite.id, read.id)) {
				findings.push({
					kind: "stale_read",
					resource_ids: [resourceId],
					evidence_ids: [read.id, nextWrite.id],
					blamed_actor_id: null,
					detail: `read '${read.id}' on resource '${resourceId}' observed version ${read.version}, but write '${nextWrite.id}' committed version ${nextWrite.version} causally before this read -- the read missed a committed update`,
				});
			} else if (order.concurrent(nextWrite.id, read.id)) {
				abstained.push({
					read_id: read.id,
					write_id: nextWrite.id,
					reason: `read '${read.id}' observed version ${read.version} on resource '${resourceId}'; write '${nextWrite.id}' committed version ${nextWrite.version}, but the two are concurrent -- whether the read is stale depends on which legal linearization is chosen, so no finding is reported`,
				});
			}
			// happensBefore(read, nextWrite): the read genuinely preceded this
			// and every later write -- not stale, nothing to report.
		}
	}

	return { findings, abstained };
}

function detectLostUpdates(operations: ResourceOperation[]): RaceFinding[] {
	const findings: RaceFinding[] = [];
	const resourceGroups = byResource(operations);

	for (const [resourceId, ops] of resourceGroups) {
		const writes = ops.filter((o) => o.kind === "write").sort((a, b) => a.version - b.version);

		for (const write of writes) {
			if (write.based_on_version === undefined) continue;
			const intervening = writes.filter(
				(w) =>
					w !== write &&
					w.version > (write.based_on_version as number) &&
					w.version < write.version,
			);
			if (intervening.length === 0) continue;
			findings.push({
				kind: "lost_update",
				resource_ids: [resourceId],
				evidence_ids: [write.id, ...intervening.map((w) => w.id)],
				blamed_actor_id: write.actor_id,
				detail: `write '${write.id}' on resource '${resourceId}' committed version ${write.version} based on version ${write.based_on_version}, discarding intervening committed version(s) ${intervening.map((w) => w.version).join(", ")} from write(s) ${intervening.map((w) => `'${w.id}'`).join(", ")}`,
			});
		}
	}

	return findings;
}

function detectWriteSkew(operations: ResourceOperation[]): RaceFinding[] {
	const findings: RaceFinding[] = [];
	const groups = byGroup(operations);
	const groupIds = [...groups.keys()];

	for (let i = 0; i < groupIds.length; i++) {
		for (let j = i + 1; j < groupIds.length; j++) {
			const g1 = groups.get(groupIds[i]) as ResourceOperation[];
			const g2 = groups.get(groupIds[j]) as ResourceOperation[];
			const g1Writes = g1.filter((o) => o.kind === "write");
			const g2Writes = g2.filter((o) => o.kind === "write");
			const g1Reads = g1.filter((o) => o.kind === "read");
			const g2Reads = g2.filter((o) => o.kind === "read");

			for (const writeY of g1Writes) {
				for (const writeX of g2Writes) {
					if (writeX.resource_id === writeY.resource_id) continue;
					const readX1 = g1Reads.find((r) => r.resource_id === writeX.resource_id);
					const readY2 = g2Reads.find((r) => r.resource_id === writeY.resource_id);
					if (!readX1 || !readY2) continue;
					const g1MissedWriteX = readX1.version < writeX.version;
					const g2MissedWriteY = readY2.version < writeY.version;
					if (g1MissedWriteX && g2MissedWriteY) {
						findings.push({
							kind: "write_skew",
							resource_ids: [writeX.resource_id, writeY.resource_id].sort(),
							evidence_ids: [readX1.id, writeX.id, readY2.id, writeY.id],
							blamed_actor_id: null,
							detail: `group '${groupIds[i]}' read resource '${writeX.resource_id}' at version ${readX1.version} (missing group '${groupIds[j]}''s later write '${writeX.id}' at version ${writeX.version}) and wrote resource '${writeY.resource_id}'; group '${groupIds[j]}' read resource '${writeY.resource_id}' at version ${readY2.version} (missing group '${groupIds[i]}''s later write '${writeY.id}' at version ${writeY.version}) and wrote resource '${writeX.resource_id}' -- each decision was locally valid, the conflict only exists in combination`,
						});
					}
				}
			}
		}
	}

	return findings;
}

function detectStructuralRaces(
	operations: ResourceOperation[],
	order: PartialOrderResult,
	lostUpdateEvidenceIds: Set<string>,
): RaceFinding[] {
	const findings: RaceFinding[] = [];
	const resourceGroups = byResource(operations);

	for (const [resourceId, ops] of resourceGroups) {
		const writes = ops.filter((o) => o.kind === "write").sort((a, b) => a.version - b.version);

		for (let i = 0; i < writes.length; i++) {
			for (let j = i + 1; j < writes.length; j++) {
				const w1 = writes[i];
				const w2 = writes[j];
				// Already explained as a lost update -- do not also report a
				// structural race for the same pair.
				if (lostUpdateEvidenceIds.has(w1.id) && lostUpdateEvidenceIds.has(w2.id)) continue;
				if (!order.concurrent(w1.id, w2.id)) continue;
				findings.push({
					kind: "structural_race",
					resource_ids: [resourceId],
					evidence_ids: [w1.id, w2.id],
					blamed_actor_id: null,
					detail: `writes '${w1.id}' (version ${w1.version}) and '${w2.id}' (version ${w2.version}) on resource '${resourceId}' are concurrent with no read-modify-write basis to compare -- nothing in the evidence explains how their commit order was decided`,
				});
			}
		}
	}

	return findings;
}

/**
 * Diagnose every shared-state race across `operations`: stale reads, lost
 * updates, write skew, and structural races. `order` must already relate
 * every operation id this module needs to compare (typically via
 * `partial-order.ts`'s `reconstructPartialOrder` over the same events).
 */
export function diagnoseSharedStateRaces(
	operations: ResourceOperation[],
	order: PartialOrderResult,
): RaceDiagnosis {
	const { findings: staleReadFindings, abstained } = detectStaleReads(operations, order);
	const lostUpdateFindings = detectLostUpdates(operations);
	const lostUpdateEvidenceIds = new Set(lostUpdateFindings.flatMap((f) => f.evidence_ids));
	const writeSkewFindings = detectWriteSkew(operations);
	const structuralRaceFindings = detectStructuralRaces(operations, order, lostUpdateEvidenceIds);

	return {
		findings: [
			...staleReadFindings,
			...lostUpdateFindings,
			...writeSkewFindings,
			...structuralRaceFindings,
		],
		abstained_pairs: abstained,
	};
}

/** Render a human-readable shared-state race diagnosis report. */
export function renderSharedStateRaceReport(report: RaceDiagnosis): string {
	const lines: string[] = ["# Shared-State Read/Write Race Report", ""];
	lines.push("## Findings");
	if (report.findings.length === 0) lines.push("None.");
	for (const f of report.findings) {
		lines.push(
			`- [${f.kind}] resource(s) ${f.resource_ids.join(", ")}${f.blamed_actor_id ? ` (blamed: ${f.blamed_actor_id})` : " (blame: unattributable)"}: ${f.detail}`,
		);
	}
	lines.push("");
	lines.push("## Abstained pairs (blame depends on linearization choice; no finding reported)");
	if (report.abstained_pairs.length === 0) lines.push("None.");
	for (const p of report.abstained_pairs) {
		lines.push(`- read '${p.read_id}' / write '${p.write_id}': ${p.reason}`);
	}
	return lines.join("\n");
}
