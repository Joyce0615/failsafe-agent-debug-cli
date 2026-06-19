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

	// One assertion per supported pattern — each real secret must be redacted.
	const patternCases: Array<[string, string]> = [
		["Anthropic API Key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"],
		["GitHub PAT", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"],
		["GitHub OAuth", "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"],
		["AWS Access Key ID", "AKIAIOSFODNN7EXAMPLE"],
		["AWS Secret", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12"],
		["Hugging Face", "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"],
		["GitLab PAT", "glpat-aBcDeFgHiJkLmNoPqRsT"],
		["Google API Key", "AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
		["Slack token", "xoxb-1234567890-abcdefghij"],
		["JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123"],
		["env PASSWORD", "PASSWORD=hunter2supersecret"],
		["generic api_key", 'api_key: "abcdef0123456789abcdef0123456789abcd"'],
	];

	for (const [name, secret] of patternCases) {
		test(`redacts ${name}`, () => {
			const { redacted } = redactSecrets(`prefix ${secret} suffix`);
			expect(redacted).toContain("[REDACTED]");
			expect(redacted).not.toContain(secret);
		});
	}

	test("redacts a PEM private key block", () => {
		const pem = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEpAIBAAKCAQEAabc123",
			"deadbeef456",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");
		const { redacted } = redactSecrets(`before\n${pem}\nafter`);
		expect(redacted).toContain("[REDACTED]");
		expect(redacted).not.toContain("MIIEpAIBAAKCAQEA");
		expect(redacted).toContain("before");
		expect(redacted).toContain("after");
	});

	describe("near-miss regressions (avoid false positives)", () => {
		test("a too-short sk- fragment is not treated as a key", () => {
			const { matched } = redactSecrets("the sk-abc token reference");
			expect(matched).not.toContain("OpenAI API Key");
		});

		test("a key split across two lines is not redacted as one secret", () => {
			// A real contiguous key is needed; a line break breaks the match.
			const split = "ghp_ABCDEFGHIJKLMNOPQRST\nUVWXYZabcdefghij";
			const { redacted } = redactSecrets(split);
			expect(redacted).toBe(split);
		});

		test("ordinary prose with the word secret is not redacted", () => {
			const text = "The secret to good tests is determinism.";
			const { redacted } = redactSecrets(text);
			expect(redacted).toBe(text);
		});
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
