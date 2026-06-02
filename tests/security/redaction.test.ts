import { describe, expect, test } from "bun:test";
import { redactEnvVars, redactSecrets } from "../../src/security/redaction.js";

describe("redactSecrets", () => {
	test("redacts OpenAI API keys", () => {
		const { redacted, matched } = redactSecrets("key is sk-abc123def456ghijklmnopqrs");
		expect(redacted).not.toContain("sk-abc123");
		expect(redacted).toContain("[REDACTED]");
		expect(matched.length).toBeGreaterThan(0);
	});

	test("redacts GitHub tokens", () => {
		const { redacted } = redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
		expect(redacted).toContain("[REDACTED]");
	});

	test("redacts Bearer tokens", () => {
		const { redacted } = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test");
		expect(redacted).toContain("[REDACTED]");
	});

	test("leaves clean text unchanged", () => {
		const { redacted, matched } = redactSecrets("This is clean output with no secrets");
		expect(redacted).toBe("This is clean output with no secrets");
		expect(matched.length).toBe(0);
	});
});

describe("redactEnvVars", () => {
	test("redacts known sensitive keys", () => {
		const env = {
			PATH: "/usr/bin",
			OPENAI_API_KEY: "sk-secret123",
			HOME: "/home/user",
		};
		const result = redactEnvVars(env);
		expect(result.OPENAI_API_KEY).toBe("[REDACTED]");
		expect(result.PATH).toBe("/usr/bin");
		expect(result.HOME).toBe("/home/user");
	});

	test("redacts keys containing SECRET", () => {
		const env = {
			MY_SECRET_VALUE: "very-secret",
			NORMAL_KEY: "normal",
		};
		const result = redactEnvVars(env);
		expect(result.MY_SECRET_VALUE).toBe("[REDACTED]");
		expect(result.NORMAL_KEY).toBe("normal");
	});
});
