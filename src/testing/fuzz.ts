/**
 * Property-based fuzz harness (item 87).
 *
 * Fuzzing that only asks "did it throw" finds the first missing guard clause
 * and then stops being useful. The interesting failures in this codebase are
 * not crashes: a parser that emits a negative line number, a timeline reducer
 * that returns more events than it was given, a causal graph with a cycle in
 * it, a bundle importer that accepts an unsigned bundle. Each of those returns
 * successfully and is wrong, and each is expressible as a property.
 *
 * Three commitments make the harness worth having:
 *
 * 1. **Properties, not crash-detection.** A property is a claim about every
 *    output — "the reduced set is never larger than the input", "no location
 *    has a line below 1". `runProperty` reports which claim failed, not merely
 *    that something did.
 *
 * 2. **Seeded and shrinking.** A failure reproduces from an integer, and the
 *    reported input is shrunk to something a person can read. An unshrunk
 *    counterexample from a fuzzer is usually four kilobytes of noise with one
 *    byte that matters, and nobody finds the byte.
 *
 * 3. **Structurally plausible garbage.** Random bytes exercise the first guard
 *    and nothing else. The generators here produce near-misses — a traceback
 *    with a line number of `-1`, a span whose parent is itself, a bundle with a
 *    valid signature over different content — because that is where the
 *    interesting behaviour lives.
 *
 * Pure: generators and the runner. The properties themselves live with the
 * modules they constrain.
 */
import { mulberry32, pick, randomInt } from "../utils/random.js";

export type Generator<T> = (rand: () => number) => T;

export type Property<T> = {
	name: string;
	generator: Generator<T>;
	/** `null` when the property holds; a message describing the violation otherwise. */
	check: (value: T) => string | null;
	/** Smaller candidates to try when a counterexample is found. */
	shrink?: (value: T) => T[];
};

export type PropertyFailure<T> = {
	seed: number;
	/** The generated counterexample, after shrinking. */
	input: T;
	/** The original, unshrunk counterexample. */
	original: T;
	message: string;
	shrink_steps: number;
};

export type PropertyResult<T> = {
	name: string;
	passed: boolean;
	runs: number;
	failure?: PropertyFailure<T>;
};

export const DEFAULT_RUNS = 200;
export const DEFAULT_SHRINK_STEPS = 100;

/**
 * Run a property over generated inputs.
 *
 * On failure, shrinks greedily: repeatedly try the smaller candidates and keep
 * the first that still violates the property. Greedy shrinking does not find
 * the globally minimal counterexample and is not trying to; it turns four
 * kilobytes into forty bytes, which is the difference between a report someone
 * acts on and one they close.
 */
export function runProperty<T>(
	property: Property<T>,
	opts: { runs?: number; seed?: number; shrink_steps?: number } = {},
): PropertyResult<T> {
	const runs = opts.runs ?? DEFAULT_RUNS;
	const baseSeed = opts.seed ?? 1;
	const maxShrink = opts.shrink_steps ?? DEFAULT_SHRINK_STEPS;

	for (let i = 0; i < runs; i++) {
		const seed = baseSeed + i;
		const input = property.generator(mulberry32(seed));
		const message = property.check(input);
		if (message === null) continue;

		let current = input;
		let steps = 0;
		if (property.shrink) {
			let improved = true;
			while (improved && steps < maxShrink) {
				improved = false;
				for (const candidate of property.shrink(current)) {
					if (property.check(candidate) !== null) {
						current = candidate;
						steps++;
						improved = true;
						break;
					}
				}
			}
		}

		return {
			name: property.name,
			passed: false,
			runs: i + 1,
			failure: {
				seed,
				input: current,
				original: input,
				message: property.check(current) ?? message,
				shrink_steps: steps,
			},
		};
	}

	return { name: property.name, passed: true, runs };
}

/** Shrink a string by halving and by dropping characters. */
export function shrinkString(value: string): string[] {
	if (value.length === 0) return [];
	const candidates = [
		value.slice(0, Math.floor(value.length / 2)),
		value.slice(1),
		value.slice(0, -1),
	];
	return [...new Set(candidates.filter((c) => c !== value))];
}

/** Shrink an array by halving and by dropping one element. */
export function shrinkArray<T>(value: T[]): T[][] {
	if (value.length === 0) return [];
	const candidates: T[][] = [value.slice(0, Math.floor(value.length / 2))];
	for (let i = 0; i < Math.min(value.length, 8); i++) {
		candidates.push([...value.slice(0, i), ...value.slice(i + 1)]);
	}
	return candidates.filter((c) => c.length < value.length);
}

/** Characters chosen to break naive parsers rather than to look random. */
const HOSTILE_CHARS = [
	"\n",
	"\r",
	"\t",
	"\u0000",
	"\u001b[31m",
	'"',
	"'",
	"\\",
	"`",
	"$",
	"{",
	"}",
	"…",
	"🙂",
	"\uFFFD",
];

/**
 * Text that looks like tool output and is not.
 *
 * Half the point is the shape: prefixes real parsers key on, followed by
 * something that will not parse. Uniformly random bytes never reach the second
 * branch of anything.
 */
export function garbledOutput(rand: () => number): string {
	const prefixes = [
		"Traceback (most recent call last):",
		'  File "',
		"    at ",
		"FAILED ",
		"error[E0308]: ",
		"--- FAIL: ",
		"%Error: ",
		"UVM_ERROR ",
		"",
	];
	const lines = randomInt(rand, 1, 12);
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		const prefix = pick(rand, prefixes);
		const tail = Array.from({ length: randomInt(rand, 0, 20) }, () =>
			rand() < 0.3 ? pick(rand, HOSTILE_CHARS) : String.fromCharCode(randomInt(rand, 32, 126)),
		).join("");
		out.push(prefix + tail);
	}
	return out.join("\n");
}

/**
 * A file:line reference with a line number that may be nonsensical.
 *
 * Negative, zero, absurd, and non-numeric line numbers all appear in real
 * output — from truncation, from locale formatting, from tools that print an
 * offset where a line belongs — and each of them has produced a bad location at
 * some point in some parser.
 */
export function hostileLocation(rand: () => number): string {
	const lines = ["-1", "0", "1", "999999999999", "NaN", "1e10", "", "٣", "12.5"];
	const files = ["a.py", "../../../etc/passwd", "C:\\x\\y.ts", "", "a b.rs", "很长的名字.go"];
	return `${pick(rand, files)}:${pick(rand, lines)}`;
}

export type FuzzEvent = {
	id: string;
	ts_ms: number;
	label: string;
	parent?: string;
};

/**
 * Events with the pathologies a timeline must survive: duplicate ids, a
 * self-parent, a parent that does not exist, identical timestamps, and
 * timestamps outside any plausible range.
 */
export function hostileEvents(rand: () => number): FuzzEvent[] {
	const count = randomInt(rand, 0, 12);
	const events: FuzzEvent[] = [];
	for (let i = 0; i < count; i++) {
		const id = rand() < 0.2 && events.length > 0 ? pick(rand, events).id : `e${i}`;
		const timestamps = [0, -1, 1_700_000_000_000, Number.MAX_SAFE_INTEGER, 1, 1];
		const parentChoices = [undefined, id, `e${randomInt(rand, 0, count + 5)}`, "ghost"];
		events.push({
			id,
			ts_ms: pick(rand, timestamps),
			label: rand() < 0.3 ? pick(rand, HOSTILE_CHARS) : `event ${i}`,
			parent: pick(rand, parentChoices),
		});
	}
	return events;
}

export type FuzzEdge = { from: string; to: string };

/**
 * A graph likely to contain cycles, self-loops, and dangling endpoints.
 *
 * Generated over a deliberately small node set so cycles are common: a fuzzer
 * over a large node space produces sparse graphs and almost never exercises the
 * cycle-breaking path, which is the one worth testing.
 */
export function hostileGraph(rand: () => number): { nodes: string[]; edges: FuzzEdge[] } {
	const nodeCount = randomInt(rand, 1, 5);
	const nodes = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
	const edgeCount = randomInt(rand, 0, 12);
	const edges: FuzzEdge[] = [];
	for (let i = 0; i < edgeCount; i++) {
		edges.push({
			from: rand() < 0.15 ? "missing" : pick(rand, nodes),
			to: rand() < 0.15 ? "missing" : pick(rand, nodes),
		});
	}
	return { nodes, edges };
}

/**
 * Mutations that a bundle importer must reject.
 *
 * Named rather than random: each corresponds to a specific attack — re-signing
 * different content, reordering fields to change meaning under a naive
 * canonicalizer, appending a section after signing, moving a clock forward.
 */
export const BUNDLE_MUTATIONS = [
	"flip_signature_byte",
	"truncate_signature",
	"swap_field_order",
	"append_section",
	"advance_clock_past_expiry",
	"replace_payload_keep_signature",
] as const;
export type BundleMutation = (typeof BUNDLE_MUTATIONS)[number];

export function hostileMutation(rand: () => number): BundleMutation {
	return pick(rand, BUNDLE_MUTATIONS);
}

export type FuzzSummary = {
	properties: number;
	passed: number;
	failed: Array<{ name: string; seed: number; message: string }>;
	total_runs: number;
};

/** Run several properties and summarize. Every failure keeps its seed. */
export function runProperties(
	properties: Array<Property<unknown>>,
	opts: { runs?: number; seed?: number } = {},
): FuzzSummary {
	const results = properties.map((property) => runProperty(property, opts));
	return {
		properties: results.length,
		passed: results.filter((r) => r.passed).length,
		failed: results
			.filter((r) => !r.passed)
			.map((r) => ({
				name: r.name,
				seed: r.failure!.seed,
				message: r.failure!.message,
			})),
		total_runs: results.reduce((sum, r) => sum + r.runs, 0),
	};
}
