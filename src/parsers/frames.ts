import type { StackFrame } from "../types/failure.js";

/**
 * Fold a raw stack trace for agent consumption (item 25).
 *
 * Mirrors Sentry's grouping normalization: (1) drop consecutive duplicate
 * frames, then (2) replace each contiguous run of two-or-more non-application
 * (dependency/internal) frames with a single fold marker
 * (`is_application:false`, `collapsed:N`). Application frames and their order
 * are always preserved, so `find(f => f.is_application)` and the first-app-frame
 * location extraction keep working unchanged; only the noisy
 * `node_modules`/`node:internal`/traceback runs are compressed. A lone
 * non-application frame is kept verbatim (folding one frame would lose signal
 * without saving anything meaningful).
 */
export function collapseFrames(frames: StackFrame[]): StackFrame[] {
	if (frames.length === 0) return frames;

	// 1. Drop consecutive duplicate frames.
	const deduped: StackFrame[] = [];
	for (const f of frames) {
		const prev = deduped[deduped.length - 1];
		if (
			prev &&
			prev.file === f.file &&
			prev.line === f.line &&
			prev.function === f.function &&
			prev.is_application === f.is_application
		) {
			continue;
		}
		deduped.push(f);
	}

	// 2. Fold contiguous non-application runs of length >= 2 into one marker.
	const out: StackFrame[] = [];
	let i = 0;
	while (i < deduped.length) {
		if (deduped[i].is_application) {
			out.push(deduped[i]);
			i++;
			continue;
		}
		let j = i;
		while (j < deduped.length && !deduped[j].is_application) j++;
		const runLength = j - i;
		if (runLength === 1) {
			out.push(deduped[i]);
		} else {
			out.push({
				file: `(${runLength} library frames)`,
				line: 0,
				is_application: false,
				collapsed: runLength,
			});
		}
		i = j;
	}

	return out;
}

/** Apply {@link collapseFrames} to every error's `stack_frames` in place-free copies. */
export function collapseFramesInResults<
	T extends { errors: Array<{ stack_frames?: StackFrame[] }> },
>(results: T[]): T[] {
	for (const result of results) {
		for (const error of result.errors) {
			if (error.stack_frames && error.stack_frames.length > 0) {
				error.stack_frames = collapseFrames(error.stack_frames);
			}
		}
	}
	return results;
}
