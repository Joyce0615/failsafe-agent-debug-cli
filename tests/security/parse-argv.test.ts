import { describe, expect, test } from "bun:test";
import { parseToArgv } from "../../src/security/policy.js";

describe("parseToArgv", () => {
	test("parses a simple command into argv", () => {
		const r = parseToArgv("pytest tests/");
		expect(r.kind).toBe("argv");
		if (r.kind === "argv") expect(r.argv).toEqual(["pytest", "tests/"]);
	});

	test("respects double-quoted arguments", () => {
		const r = parseToArgv('pytest -k "test foo and bar"');
		expect(r.kind).toBe("argv");
		if (r.kind === "argv") expect(r.argv).toEqual(["pytest", "-k", "test foo and bar"]);
	});

	test("respects single-quoted arguments", () => {
		const r = parseToArgv("node -e 'console.log(1)'");
		expect(r.kind).toBe("argv");
		if (r.kind === "argv") expect(r.argv).toEqual(["node", "-e", "console.log(1)"]);
	});

	test("handles backslash escapes", () => {
		const r = parseToArgv("echo a\\ b");
		expect(r.kind).toBe("argv");
		if (r.kind === "argv") expect(r.argv).toEqual(["echo", "a b"]);
	});

	test("flags pipe as needing shell", () => {
		const r = parseToArgv("cat x | grep y");
		expect(r.kind).toBe("needs_shell");
		if (r.kind === "needs_shell") expect(r.reason).toContain("|");
	});

	test("flags && as needing shell", () => {
		const r = parseToArgv("a && b");
		expect(r.kind).toBe("needs_shell");
	});

	test("flags redirect as needing shell", () => {
		const r = parseToArgv("echo x > file");
		expect(r.kind).toBe("needs_shell");
	});

	test("flags variable expansion as needing shell", () => {
		const r = parseToArgv("echo $HOME");
		expect(r.kind).toBe("needs_shell");
		if (r.kind === "needs_shell") expect(r.reason).toContain("variable expansion");
	});

	test("flags variable expansion inside double quotes", () => {
		const r = parseToArgv('echo "$HOME/foo"');
		expect(r.kind).toBe("needs_shell");
	});

	test("does NOT flag $ inside single quotes", () => {
		const r = parseToArgv("echo '$HOME'");
		expect(r.kind).toBe("argv");
		if (r.kind === "argv") expect(r.argv).toEqual(["echo", "$HOME"]);
	});

	test("flags glob as needing shell", () => {
		const r = parseToArgv("rm *.tmp");
		expect(r.kind).toBe("needs_shell");
	});

	test("flags backtick as needing shell", () => {
		const r = parseToArgv("echo `date`");
		expect(r.kind).toBe("needs_shell");
	});

	test("flags unterminated quote", () => {
		const r = parseToArgv('echo "unterminated');
		expect(r.kind).toBe("needs_shell");
		if (r.kind === "needs_shell") expect(r.reason).toContain("Unterminated");
	});

	test("flags empty command", () => {
		const r = parseToArgv("   ");
		expect(r.kind).toBe("needs_shell");
	});
});
