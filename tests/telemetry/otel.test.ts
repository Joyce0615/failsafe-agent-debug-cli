import { afterEach, describe, expect, test } from "bun:test";
import { isTelemetryEnabled, shutdownTelemetry, withSpan } from "../../src/telemetry/otel.js";

const ENDPOINT_VAR = "OTEL_EXPORTER_OTLP_ENDPOINT";

afterEach(async () => {
	delete process.env[ENDPOINT_VAR];
	await shutdownTelemetry(200);
});

describe("telemetry (disabled by default)", () => {
	test("isTelemetryEnabled is false without endpoint", () => {
		delete process.env[ENDPOINT_VAR];
		expect(isTelemetryEnabled()).toBe(false);
	});

	test("withSpan runs the fn and returns its value when disabled", async () => {
		delete process.env[ENDPOINT_VAR];
		let attrsCalled = false;
		const result = await withSpan("test.op", async (setAttrs) => {
			setAttrs({ foo: "bar" });
			attrsCalled = true;
			return 42;
		});
		expect(result).toBe(42);
		expect(attrsCalled).toBe(true);
	});

	test("withSpan propagates exceptions when disabled", async () => {
		delete process.env[ENDPOINT_VAR];
		await expect(
			withSpan("test.op", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});

describe("telemetry (enabled)", () => {
	test("isTelemetryEnabled is true with endpoint set", () => {
		process.env[ENDPOINT_VAR] = "http://localhost:4318/v1/traces";
		expect(isTelemetryEnabled()).toBe(true);
	});

	test("withSpan still returns fn value when enabled", async () => {
		process.env[ENDPOINT_VAR] = "http://localhost:4318/v1/traces";
		const result = await withSpan(
			"failsafe.run",
			async (setAttrs) => {
				setAttrs({ status: "failed", failure_type: "test_failure" });
				return "ok";
			},
			{ command: "pytest" },
		);
		expect(result).toBe("ok");
	});

	test("withSpan propagates exceptions when enabled", async () => {
		process.env[ENDPOINT_VAR] = "http://localhost:4318/v1/traces";
		await expect(
			withSpan("failsafe.run", async () => {
				throw new Error("kaboom");
			}),
		).rejects.toThrow("kaboom");
	});
});
