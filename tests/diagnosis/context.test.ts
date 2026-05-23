import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSourceSlice, extractTestSlice, extractRecentDiff } from "../../src/diagnosis/context.js";

describe("extractSourceSlice", () => {
	test("extracts lines around target line", async () => {
		const dir = join(tmpdir(), `failsafe-ctx-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "test.py");
		writeFileSync(file, "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");

		const slice = await extractSourceSlice({ file, line: 5 }, 2);
		expect(slice).not.toBeNull();
		expect(slice!.start_line).toBe(3);
		expect(slice!.end_line).toBe(7);
		expect(slice!.text).toContain("5: line5");
		rmSync(dir, { recursive: true });
	});

	test("returns null for nonexistent file", async () => {
		const slice = await extractSourceSlice({ file: "/nonexistent/file.py", line: 1 });
		expect(slice).toBeNull();
	});

	test("handles file at line 1", async () => {
		const dir = join(tmpdir(), `failsafe-ctx-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "test.py");
		writeFileSync(file, "first\nsecond\nthird\n");

		const slice = await extractSourceSlice({ file, line: 1 }, 2);
		expect(slice).not.toBeNull();
		expect(slice!.start_line).toBe(1);
		expect(slice!.text).toContain("1: first");
		rmSync(dir, { recursive: true });
	});
});

describe("extractTestSlice", () => {
	test("finds Python test function", async () => {
		const dir = join(tmpdir(), `failsafe-ctx-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "test_example.py");
		writeFileSync(
			file,
			'def test_foo():\n    assert True\n\ndef test_bar():\n    assert False\n',
		);

		const slice = await extractTestSlice(file, "test_foo");
		expect(slice).not.toBeNull();
		expect(slice!.text).toContain("test_foo");
		expect(slice!.text).not.toContain("test_bar");
		rmSync(dir, { recursive: true });
	});

	test("finds class-scoped test by method name", async () => {
		const dir = join(tmpdir(), `failsafe-ctx-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "test_example.py");
		writeFileSync(
			file,
			"class TestAuth:\n    def test_login(self):\n        assert True\n\n    def test_logout(self):\n        assert False\n",
		);

		const slice = await extractTestSlice(file, "TestAuth::test_login");
		expect(slice).not.toBeNull();
		expect(slice!.text).toContain("test_login");
		rmSync(dir, { recursive: true });
	});

	test("returns null for nonexistent file", async () => {
		const slice = await extractTestSlice("/nonexistent/test.py", "test_foo");
		expect(slice).toBeNull();
	});
});

describe("extractRecentDiff", () => {
	test("returns null for file not in git repo", async () => {
		const dir = join(tmpdir(), `failsafe-nogit-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "test.py");
		writeFileSync(file, "content\n");

		const diff = await extractRecentDiff(file);
		expect(diff).toBeNull();
		rmSync(dir, { recursive: true });
	});

	test("returns null for nonexistent file", async () => {
		const diff = await extractRecentDiff("/nonexistent/path/file.py");
		expect(diff).toBeNull();
	});

	test("handles relative paths in a git repo", async () => {
		// This runs against the actual failsafe repo
		// A committed file with no changes should return null (no diff)
		const diff = await extractRecentDiff("package.json");
		// Result depends on whether package.json has uncommitted changes
		// Just verify it doesn't throw
		expect(diff === null || typeof diff === "string").toBe(true);
	});
});
