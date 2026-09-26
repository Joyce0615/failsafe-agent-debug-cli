/**
 * Seeded pseudorandom generation.
 *
 * Shared by the benchmark corpus generator (item 53) and the fuzz harness
 * (item 87), both of which need the same property for the same reason: a
 * result must be reproducible from an integer rather than from a captured
 * input file. A crypto-quality generator would be worse here, since the whole
 * point is that the sequence can be replayed.
 */

/** Deterministic 32-bit PRNG (mulberry32) returning values in [0, 1). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Random integer in `[min, max]`. */
export function randomInt(rand: () => number, min: number, max: number): number {
	return min + Math.floor(rand() * (max - min + 1));
}

/** Uniform choice from a non-empty list. */
export function pick<T>(rand: () => number, values: readonly T[]): T {
	return values[Math.floor(rand() * values.length)];
}
