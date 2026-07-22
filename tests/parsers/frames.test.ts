/**
 * Stack-frame collapse tests (item 25).
 *
 * `collapseFrames` folds contiguous dependency/internal runs into a single
 * `+N library frames` marker and dedupes repeats while preserving application
 * frames and their order, so long node_modules/traceback chains stop inflating
 * the evidence list. `detectAndParse` applies it to every parsed error.
 */
import { describe, expect, test } from "bun:test";
import { collapseFrames } from "../../src/parsers/frames.js";
import { detectAndParse } from "../../src/parsers/index.js";
import type { StackFrame } from "../../src/types/failure.js";

function libFrame(n: number): StackFrame {
	return { file: `node_modules/dep/index.js`, line: n, function: `dep${n}`, is_application: false };
}
function appFrame(n: number): StackFrame {
	return { file: `src/app.js`, line: n, function: `handler${n}`, is_application: true };
}

describe("collapseFrames", () => {
	test("folds one app frame buried under 12 library frames to app + one marker", () => {
		const frames: StackFrame[] = [
			...Array.from({ length: 12 }, (_, i) => libFrame(i + 1)),
			appFrame(42),
		];
		const collapsed = collapseFrames(frames);

		expect(collapsed).toHaveLength(2);
		// Order preserved: the folded library run precedes the app frame.
		expect(collapsed[0].is_application).toBe(false);
		expect(collapsed[0].collapsed).toBe(12);
		expect(collapsed[1]).toEqual(appFrame(42));
		// The single application frame is still discoverable.
		expect(collapsed.find((f) => f.is_application)?.line).toBe(42);
	});

	test("keeps application frames and folds only the non-app runs between them", () => {
		const frames: StackFrame[] = [appFrame(1), libFrame(1), libFrame(2), libFrame(3), appFrame(2)];
		const collapsed = collapseFrames(frames);
		expect(collapsed.map((f) => f.is_application)).toEqual([true, false, true]);
		expect(collapsed[1].collapsed).toBe(3);
		expect(collapsed[0]).toEqual(appFrame(1));
		expect(collapsed[2]).toEqual(appFrame(2));
	});

	test("a lone library frame is kept verbatim (no +1 marker noise)", () => {
		const frames: StackFrame[] = [appFrame(1), libFrame(9), appFrame(2)];
		const collapsed = collapseFrames(frames);
		expect(collapsed).toHaveLength(3);
		expect(collapsed[1].collapsed).toBeUndefined();
		expect(collapsed[1]).toEqual(libFrame(9));
	});

	test("dedupes consecutive identical frames", () => {
		const frames: StackFrame[] = [appFrame(1), appFrame(1), appFrame(2)];
		const collapsed = collapseFrames(frames);
		expect(collapsed).toHaveLength(2);
	});

	test("is a no-op for an all-application trace", () => {
		const frames: StackFrame[] = [appFrame(1), appFrame(2), appFrame(3)];
		expect(collapseFrames(frames)).toEqual(frames);
	});
});

describe("detectAndParse applies frame collapse", () => {
	test("a JS stack with a deep node_modules chain is folded in the parsed error", () => {
		const stderr = [
			"TypeError: Cannot read properties of undefined (reading 'x')",
			"    at Object.<anonymous> (node_modules/a/index.js:10:5)",
			"    at run (node_modules/b/index.js:20:5)",
			"    at load (node_modules/c/index.js:30:5)",
			"    at handler (src/app.js:42:9)",
			"",
		].join("\n");
		const [result] = detectAndParse("", stderr, "node app.js");
		const frames = result.errors[0].stack_frames ?? [];
		// The three consecutive node_modules frames collapse to one marker,
		// leaving the marker + the application frame.
		expect(frames).toHaveLength(2);
		expect(frames[0].collapsed).toBe(3);
		expect(frames[1].file).toBe("src/app.js");
		expect(frames[1].is_application).toBe(true);
	});
});
