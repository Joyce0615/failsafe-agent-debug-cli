import { describe, expect, test } from "bun:test";
import { checkRuntimeCapability } from "../../src/debug/adapters/index.js";
import { detectRuntime } from "../../src/debug/launch.js";

describe("checkRuntimeCapability", () => {
	test("python is supported", () => {
		const result = checkRuntimeCapability("python");
		expect(result.supported).toBe(true);
		if (result.supported) {
			expect(result.runtime).toBe("python");
			expect(result.adapter.name).toBe("debugpy");
		}
	});

	test("node is recognized but adapter not yet available", () => {
		const result = checkRuntimeCapability("node", "fail_123");
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.runtime).toBe("node");
			expect(result.reason).toContain("not yet available");
			expect(result.future_debugger).toBe("@vscode/js-debug");
			expect(result.install_hint).toContain("js-debug");
			expect(result.next_best.length).toBeGreaterThan(0);
		}
	});

	test("go is recognized but unsupported", () => {
		const result = checkRuntimeCapability("go", "fail_123");
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.runtime).toBe("go");
			expect(result.reason).toContain("not yet available");
			expect(result.future_debugger).toBe("Delve");
			expect(result.install_hint).toContain("dlv");
			expect(result.next_best.length).toBeGreaterThan(0);
			expect(result.next_best[0].command).toContain("diagnose");
		}
	});

	test("rust is recognized but unsupported", () => {
		const result = checkRuntimeCapability("rust");
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.runtime).toBe("rust");
			expect(result.future_debugger).toBe("LLDB / CodeLLDB");
		}
	});

	test("java is recognized but unsupported", () => {
		const result = checkRuntimeCapability("java");
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.future_debugger).toBe("JDI");
		}
	});

	test("dotnet is recognized but unsupported", () => {
		const result = checkRuntimeCapability("dotnet");
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.future_debugger).toBe("netcoredbg");
		}
	});

	test("unknown runtime gives generic message", () => {
		const result = checkRuntimeCapability("unknown");
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.reason).toContain("Could not detect");
			expect(result.future_debugger).toBeUndefined();
		}
	});

	test("next_best includes failureId when provided", () => {
		const result = checkRuntimeCapability("go", "fail_abc");
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.next_best.some((n) => n.command.includes("fail_abc"))).toBe(true);
		}
	});
});

describe("detectRuntime", () => {
	test("detects python", () => {
		expect(detectRuntime("pytest tests/")).toBe("python");
		expect(detectRuntime("python3 -m pytest")).toBe("python");
	});

	test("detects node", () => {
		expect(detectRuntime("jest tests/")).toBe("node");
		expect(detectRuntime("npx vitest")).toBe("node");
		expect(detectRuntime("bun test")).toBe("node");
	});

	test("detects go", () => {
		expect(detectRuntime("go test ./...")).toBe("go");
	});

	test("detects rust", () => {
		expect(detectRuntime("cargo test")).toBe("rust");
	});

	test("detects java", () => {
		expect(detectRuntime("mvn test")).toBe("java");
		expect(detectRuntime("gradle test")).toBe("java");
	});

	test("returns unknown for unrecognized", () => {
		expect(detectRuntime("some-random-command")).toBe("unknown");
	});
});
