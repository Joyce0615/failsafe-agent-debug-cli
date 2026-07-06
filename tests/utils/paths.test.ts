/**
 * Path-normalization unit tests.
 *
 * `normalizePath`/`normalizeLocation` canonicalize tool/compiler-emitted paths
 * into a stable POSIX-style form so Windows agents get usable, comparable
 * `primary_location` values. Covers Windows separators, drive-letter casing,
 * redundant-slash collapsing (and UNC preservation), and that already-POSIX
 * paths and the other location fields pass through untouched.
 */
import { describe, expect, test } from "bun:test";
import { normalizeLocation, normalizePath } from "../../src/utils/paths.js";

describe("normalizePath", () => {
	test("converts Windows backslashes to forward slashes", () => {
		expect(normalizePath("src\\cli\\ci.ts")).toBe("src/cli/ci.ts");
	});

	test("upper-cases a Windows drive letter and converts separators", () => {
		expect(normalizePath("c:\\Users\\dev\\app.ts")).toBe("C:/Users/dev/app.ts");
	});

	test("collapses redundant separators", () => {
		expect(normalizePath("src//cli///ci.ts")).toBe("src/cli/ci.ts");
		expect(normalizePath("a\\\\b\\c")).toBe("a/b/c");
	});

	test("preserves a leading UNC double-slash", () => {
		expect(normalizePath("\\\\server\\share\\file.ts")).toBe("//server/share/file.ts");
	});

	test("leaves already-POSIX paths unchanged", () => {
		expect(normalizePath("/var/cache/app.ts")).toBe("/var/cache/app.ts");
		expect(normalizePath("src/index.ts")).toBe("src/index.ts");
	});

	test("returns empty input unchanged", () => {
		expect(normalizePath("")).toBe("");
	});
});

describe("normalizeLocation", () => {
	test("normalizes the file and preserves the other fields", () => {
		const out = normalizeLocation({
			file: "C:\\proj\\src\\mod.ts",
			line: 12,
			column: 3,
			symbol: "doThing",
		});
		expect(out).toEqual({
			file: "C:/proj/src/mod.ts",
			line: 12,
			column: 3,
			symbol: "doThing",
		});
	});
});
