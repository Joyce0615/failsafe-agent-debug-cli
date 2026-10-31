/**
 * Time-travel state inspection over a debug trajectory (item 25).
 *
 * `debug/state.ts` captures a `StateSnapshot` at each stop and diffs it into a
 * `StateDelta` against the previous one, and `debug/controller.ts` keeps only
 * the LAST snapshot live in memory per session. Once a session steps past a
 * location, that state is gone — an operator who wants to go back and look at
 * what a variable held three steps ago has exactly one option: re-run the
 * target and step to the same place again. That is wrong twice over. It is
 * slow (a real re-run, with real I/O), and for anything with a side effect
 * (`console_events`, an exception that triggered a handler, any actual write
 * a step performed) it is not even the SAME execution — re-running advances
 * the effect a second time, which is corruption, not inspection.
 *
 * This module fixes both: :func:`checkpointSnapshot` content-addresses a
 * `StateSnapshot` into an immutable `Checkpoint` (never re-executed to
 * reconstruct), :class:`Timeline` holds an ordered sequence of checkpoints
 * linked by the `StateDelta` each step produced, and `forward`/`backward`
 * materialize ANY prior or later point as a plain read against that already-
 * captured sequence — no DAP client, no process, no re-run of a step that
 * might have logged, written a file, or re-fired a handler.
 *
 * Three decisions matter:
 *
 * 1. **Content addressing is for IDENTITY, not for storage dedup as the
 *    primary goal.** Two steps that happen to land on byte-identical state
 *    (a loop iterating with no net change) get the SAME checkpoint id, which
 *    is also how `jumpTo` can be handed a hash a caller computed independently
 *    (from a snapshot read elsewhere) and have it resolve, rather than only
 *    resolving a hash this module itself produced.
 * 2. **Missing state is reported, never invented.** A session that was only
 *    ever snapshotted at steps 1, 2, and 5 has no view of step 3 or 4. `at()`
 *    returns an explicit `{ found: false }` for a sequence number with no
 *    checkpoint rather than interpolating one from its neighbours — an
 *    interpolated variable value is a guess wearing the shape of a fact, and
 *    this file does not manufacture facts.
 * 3. **A step whose `StateDelta` carries evidence of a consequential effect
 *    (a console write, an exception) is marked, and `forward`/`backward`
 *    navigation NEVER re-executes anything to get there — it only replays the
 *    EVIDENCE already captured by `debug/state.ts` at record time.**
 *    `hasConsequentialEffect` names which steps those are so a caller
 *    rendering a time-travel view can warn "this step wrote to stdout /
 *    raised" without the navigation itself doing anything beyond reading the
 *    stored sequence.
 *
 * Pure: no fs, no network, no DAP client. Operates entirely on
 * already-captured `StateSnapshot`/`StateDelta` values (`types/debug.ts`),
 * the same inputs `debug/state.ts` produces live.
 */
import { createHash } from "node:crypto";
import type { StateDelta, StateSnapshot } from "../types/debug.js";

/** Canonical, key-sorted JSON encoding — matches `exchange/bundle.ts`'s own
 * `canonicalize`, so re-serialization never changes a checkpoint's identity. */
function canonicalize(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** Content-addressed identity of a `StateSnapshot`. Deterministic: the same
 * snapshot, re-serialized in any key order, always yields the same id. */
export function snapshotHash(snapshot: StateSnapshot): string {
	return createHash("sha256").update(canonicalize(snapshot)).digest("hex").slice(0, 32);
}

export type Checkpoint = {
	/** Content address of `snapshot`. */
	checkpoint_id: string;
	/** Position in the recorded trajectory, strictly increasing. */
	sequence: number;
	snapshot: StateSnapshot;
	/** The step that produced this checkpoint from the previous one. `null` for
	 * the first checkpoint, which has no prior step. */
	delta: StateDelta | null;
};

/**
 * Whether the step that produced `delta` had a consequential effect —
 * something that happened in the world beyond this process's own state and
 * therefore cannot be undone by navigating away from it: a console write, or
 * an exception (which may have already triggered a handler, a crash report,
 * or a retry).
 *
 * Variable mutation alone is NOT consequential by this definition: it is
 * exactly the in-process state this module already time-travels over safely.
 */
export function hasConsequentialEffect(delta: StateDelta | null): boolean {
	if (!delta) return false;
	return delta.console_events.length > 0 || delta.exceptions.length > 0;
}

/**
 * Build one immutable checkpoint from a snapshot and the step that produced
 * it. Pure: does not consult or mutate any store.
 */
export function checkpointSnapshot(
	sequence: number,
	snapshot: StateSnapshot,
	delta: StateDelta | null = null,
): Checkpoint {
	return { checkpoint_id: snapshotHash(snapshot), sequence, snapshot, delta };
}

export type TimelineLookup =
	| { found: true; checkpoint: Checkpoint }
	| { found: false; reason: string };

/**
 * An ordered, content-addressed sequence of checkpoints for one debug
 * session. Materializing any point in it is a read against this already-
 * captured sequence — never a re-run of a step.
 */
export class Timeline {
	private readonly checkpoints: Checkpoint[];
	private readonly bySequence: Map<number, Checkpoint>;
	private readonly byId: Map<string, Checkpoint[]>;

	constructor(checkpoints: Checkpoint[]) {
		// Defensive copy + sort by sequence: callers may append out of order
		// (e.g. assembled from a store query without an ORDER BY), and this
		// class's forward/backward semantics depend on sequence order, not
		// insertion order.
		this.checkpoints = [...checkpoints].sort((a, b) => a.sequence - b.sequence);
		this.bySequence = new Map(this.checkpoints.map((c) => [c.sequence, c]));
		this.byId = new Map();
		for (const c of this.checkpoints) {
			const existing = this.byId.get(c.checkpoint_id);
			if (existing) existing.push(c);
			else this.byId.set(c.checkpoint_id, [c]);
		}
	}

	get length(): number {
		return this.checkpoints.length;
	}

	/** All checkpoints, in sequence order. */
	all(): Checkpoint[] {
		return [...this.checkpoints];
	}

	/** The checkpoint recorded at exactly this sequence number, or an explicit
	 * miss — never interpolated from neighbours. */
	at(sequence: number): TimelineLookup {
		const checkpoint = this.bySequence.get(sequence);
		if (!checkpoint) {
			return {
				found: false,
				reason: `no checkpoint was recorded at sequence ${sequence}; the nearest recorded sequences are not a substitute for it`,
			};
		}
		return { found: true, checkpoint };
	}

	/** Every checkpoint sharing a content address — the same state recurring,
	 * e.g. a loop converging on an unchanged value across iterations. */
	byContent(checkpointId: string): Checkpoint[] {
		return [...(this.byId.get(checkpointId) ?? [])];
	}

	/**
	 * The checkpoint one step forward from `sequence`. A pure read: no step
	 * is executed, so a consequential effect recorded on that step is
	 * reported via its `delta`, never performed again.
	 */
	forward(sequence: number, count = 1): TimelineLookup {
		return this.at(sequence + Math.max(1, count));
	}

	/** The checkpoint one step backward from `sequence`. Equally a pure read. */
	backward(sequence: number, count = 1): TimelineLookup {
		return this.at(sequence - Math.max(1, count));
	}

	/**
	 * Jump directly to a checkpoint by its content address, independent of
	 * sequence — the point of content addressing: a caller holding a hash
	 * from anywhere (another tool, a prior run, a different query) can
	 * resolve it against this timeline without knowing a sequence number at
	 * all. Ambiguous (recurring) content resolves to the FIRST occurrence,
	 * reported in `reason` when there was a choice to make.
	 */
	jumpTo(checkpointId: string): TimelineLookup {
		const matches = this.byId.get(checkpointId);
		if (!matches || matches.length === 0) {
			return {
				found: false,
				reason: `no checkpoint in this timeline has content address ${checkpointId}`,
			};
		}
		return { found: true, checkpoint: matches[0] as Checkpoint };
	}

	/** Sequences whose step carried a consequential effect — console output or
	 * an exception — so a caller can warn before/while navigating near one. */
	consequentialSequences(): number[] {
		return this.checkpoints.filter((c) => hasConsequentialEffect(c.delta)).map((c) => c.sequence);
	}

	/**
	 * The ordered run of `StateDelta`s between two sequences (exclusive of the
	 * start, inclusive of the end), for rendering a range rather than jumping
	 * straight to the destination. Returns `null` if either endpoint has no
	 * recorded checkpoint, rather than silently truncating the range.
	 */
	deltasBetween(fromSequence: number, toSequence: number): StateDelta[] | null {
		if (!this.bySequence.has(fromSequence) || !this.bySequence.has(toSequence)) return null;
		const [lo, hi] =
			fromSequence <= toSequence ? [fromSequence, toSequence] : [toSequence, fromSequence];
		const deltas: StateDelta[] = [];
		for (const c of this.checkpoints) {
			if (c.sequence > lo && c.sequence <= hi && c.delta) deltas.push(c.delta);
		}
		return deltas;
	}
}

/**
 * Build a `Timeline` from the same (snapshot, delta) pairs
 * `debug/controller.ts` already produces live via `captureStateSnapshot`/
 * `computeStateDelta`. The first snapshot has no preceding delta.
 */
export function buildTimeline(
	steps: { snapshot: StateSnapshot; delta: StateDelta | null }[],
): Timeline {
	return new Timeline(steps.map((s, i) => checkpointSnapshot(i, s.snapshot, s.delta)));
}
