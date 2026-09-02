import { describe, expect, test } from "bun:test";
import {
	ACTION_STRICTNESS,
	CAPTURE_ACTIONS,
	DATA_CLASSES,
	DEFAULT_CLASS_POLICIES,
	MIN_SALT_LENGTH,
	PII_SALT_ENV,
	UNDETECTABLE_PII,
	applyDataPolicy,
	auditCapture,
	classifyValue,
	findPii,
	passesLuhn,
	pseudonym,
	saltState,
} from "../../src/security/data-classes.js";

const SALT = "a-sufficiently-long-deployment-salt";

describe("safe defaults", () => {
	test("no class defaults to allow", () => {
		for (const cls of DATA_CLASSES) {
			expect(DEFAULT_CLASS_POLICIES[cls].action).not.toBe("allow");
		}
	});

	test("secrets are destroyed, PII is linkable, prompts are dropped", () => {
		expect(DEFAULT_CLASS_POLICIES.secret.action).toBe("drop");
		expect(DEFAULT_CLASS_POLICIES.pii.action).toBe("hash");
		expect(DEFAULT_CLASS_POLICIES.prompt.action).toBe("drop");
		expect(DEFAULT_CLASS_POLICIES.tool_payload.action).toBe("truncate");
	});

	test("a value in no class is left alone", () => {
		const result = applyDataPolicy("count", "42 rows processed", { salt: SALT });
		expect(result.classes).toEqual([]);
		expect(result.action).toBe("allow");
		expect(result.value).toBe("42 rows processed");
	});
});

describe("credit-card detection is specific enough to be useful", () => {
	test("a valid card number passes Luhn and is detected", () => {
		// A standard test number.
		expect(passesLuhn("4111111111111111")).toBe(true);
		expect(findPii("card 4111111111111111 declined").map((f) => f.kind)).toEqual(["card"]);
	});

	test("a sixteen-digit order number that fails Luhn is left alone", () => {
		expect(passesLuhn("1234567812345678")).toBe(false);
		expect(findPii("order 1234567812345678 shipped")).toEqual([]);
	});

	test("separated card digits are still detected", () => {
		expect(findPii("4111 1111 1111 1111").map((f) => f.kind)).toEqual(["card"]);
	});

	test("numbers outside the card length range are not candidates", () => {
		expect(passesLuhn("42")).toBe(false);
		expect(passesLuhn("1".repeat(25))).toBe(false);
	});
});

describe("PII detection", () => {
	test("emails, phones, SSNs, and IPs are found", () => {
		const kinds = findPii(
			"contact a.user+tag@example.co.uk or 555-867-5309, ssn 123-45-6789, from 10.1.2.3",
		).map((f) => f.kind);
		expect(kinds).toContain("email");
		expect(kinds).toContain("phone");
		expect(kinds).toContain("ssn");
		expect(kinds).toContain("ip");
	});

	test("invalid SSN prefixes are not matched", () => {
		expect(findPii("000-12-3456").filter((f) => f.kind === "ssn")).toEqual([]);
		expect(findPii("123-00-4567").filter((f) => f.kind === "ssn")).toEqual([]);
	});

	test("a version string is not an IP address", () => {
		expect(findPii("version 1.2.3").filter((f) => f.kind === "ip")).toEqual([]);
	});

	test("overlapping matches do not double-count one span", () => {
		const findings = findPii("user@10.1.2.3.example.com");
		const spans = findings.map((f) => [f.start, f.start + f.value.length]);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
		}
	});

	test("clean text yields nothing", () => {
		expect(findPii("the build failed in 3.2 seconds")).toEqual([]);
	});

	test("what cannot be detected is enumerated, not implied", () => {
		expect(UNDETECTABLE_PII.length).toBeGreaterThan(0);
		expect(UNDETECTABLE_PII).toContain("personal names");
		// And the detector genuinely does not claim to find them.
		expect(findPii("the user Jane Doe reported the issue")).toEqual([]);
	});
});

describe("classification", () => {
	test("prompt and tool-payload classes come from the key, not the content", () => {
		expect(classifyValue("gen_ai.prompt", "hello")).toContain("prompt");
		expect(classifyValue("tool.arguments", "{}")).toContain("tool_payload");
		expect(classifyValue("some.other.key", "hello")).toEqual([]);
	});

	test("key matching accepts a namespaced suffix but not a substring", () => {
		expect(classifyValue("vendor.llm.prompt", "x")).toContain("prompt");
		expect(classifyValue("promptness", "x")).toEqual([]);
	});

	test("a value can be in several classes at once", () => {
		const classes = classifyValue("gen_ai.prompt", "email me at a@b.com, key=sk-abcdefghijklmnopqrstuvwxyz12");
		expect(classes).toContain("prompt");
		expect(classes).toContain("pii");
		expect(classes).toContain("secret");
	});

	test("classes are returned in a stable declared order", () => {
		const classes = classifyValue("tool.arguments", "a@b.com");
		expect(classes).toEqual(DATA_CLASSES.filter((c) => classes.includes(c)));
	});
});

describe("the strictest applicable policy wins", () => {
	test("a prompt containing a credential is treated as a credential", () => {
		const result = applyDataPolicy("gen_ai.prompt", "use key AKIAIOSFODNN7EXAMPLE please", {
			policies: { prompt: { action: "allow" }, secret: { action: "drop" } },
			salt: SALT,
		});
		expect(result.action).toBe("drop");
		expect(result.value).toBeUndefined();
	});

	test("a tool payload containing PII is hashed, not merely truncated", () => {
		const result = applyDataPolicy("tool.result", "user a@b.com", {
			policies: { pii: { action: "hash" }, tool_payload: { action: "truncate" } },
			salt: SALT,
		});
		expect(result.action).toBe("hash");
	});

	test("the strictness order is drop < hash < redact < truncate < allow", () => {
		const ordered = [...CAPTURE_ACTIONS].sort(
			(a, b) => ACTION_STRICTNESS[a] - ACTION_STRICTNESS[b],
		);
		expect(ordered).toEqual(["drop", "hash", "redact", "truncate", "allow"]);
	});
});

describe("hashing requires a real salt", () => {
	test("a configured salt produces a stable, linkable pseudonym", () => {
		const a = pseudonym("user@example.com", SALT);
		const b = pseudonym("user@example.com", SALT);
		expect(a).toBe(b);
		expect(a).not.toContain("user@example.com");
		expect(pseudonym("other@example.com", SALT)).not.toBe(a);
	});

	test("a different salt yields a different pseudonym", () => {
		expect(pseudonym("user@example.com", SALT)).not.toBe(
			pseudonym("user@example.com", `${SALT}-two`),
		);
	});

	test("hashing replaces the PII in place, keeping the surrounding context", () => {
		const result = applyDataPolicy("msg", "failed for user@example.com on retry 3", {
			salt: SALT,
		});
		expect(result.action).toBe("hash");
		expect(result.value).toContain("failed for");
		expect(result.value).toContain("on retry 3");
		expect(result.value).not.toContain("user@example.com");
		expect(result.value).toContain("pii_");
	});

	test("the same value hashes identically across records, so it stays linkable", () => {
		const first = applyDataPolicy("a", "user@example.com", { salt: SALT });
		const second = applyDataPolicy("b", "seen user@example.com again", { salt: SALT });
		const token = first.value!;
		expect(second.value).toContain(token);
	});

	test("no salt downgrades hash to drop and says why", () => {
		const result = applyDataPolicy("msg", "user@example.com", { salt: "" });
		expect(result.action).toBe("drop");
		expect(result.downgraded_from).toBe("hash");
		expect(result.downgrade_reason).toContain(PII_SALT_ENV);
		expect(result.value).toBeUndefined();
	});

	test("a short salt is treated as no salt at all", () => {
		const state = saltState("short");
		expect(state.available).toBe(false);
		expect(state.reason).toContain(String(MIN_SALT_LENGTH));
		expect(applyDataPolicy("msg", "user@example.com", { salt: "short" }).action).toBe("drop");
	});

	test("a salt at the minimum length is accepted", () => {
		expect(saltState("x".repeat(MIN_SALT_LENGTH)).available).toBe(true);
	});
});

describe("redact and truncate", () => {
	test("redaction replaces PII with its kind, never its value", () => {
		const result = applyDataPolicy("tool.result", "wrote to a@b.com from 10.0.0.1", {
			policies: { pii: { action: "redact" }, tool_payload: { action: "redact" } },
			salt: SALT,
		});
		expect(result.value).toContain("[EMAIL]");
		expect(result.value).toContain("[IP]");
		expect(result.value).not.toContain("a@b.com");
	});

	test("truncation applies after redaction, so a long secret cannot survive the cut", () => {
		const long = `${"x".repeat(400)} AKIAIOSFODNN7EXAMPLE`;
		const result = applyDataPolicy("tool.result", long, {
			policies: { secret: { action: "truncate" }, tool_payload: { action: "truncate", max_bytes: 4096 } },
			salt: SALT,
		});
		expect(result.value).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	test("truncation respects the byte ceiling", () => {
		const result = applyDataPolicy("tool.arguments", "y".repeat(5000), {
			policies: { tool_payload: { action: "truncate", max_bytes: 64 } },
			salt: SALT,
		});
		expect(Buffer.byteLength(result.value ?? "", "utf8")).toBeLessThanOrEqual(64);
	});

	test("a value under the ceiling is not altered by truncation", () => {
		const result = applyDataPolicy("tool.arguments", "{\"n\":1}", {
			policies: { tool_payload: { action: "truncate", max_bytes: 512 } },
			salt: SALT,
		});
		expect(result.value).toBe("{\"n\":1}");
	});

	test("an explicit allow returns the value untouched", () => {
		const result = applyDataPolicy("tool.arguments", "plain text", {
			policies: { tool_payload: { action: "allow" } },
			salt: SALT,
		});
		expect(result.action).toBe("allow");
		expect(result.value).toBe("plain text");
	});
});

describe("auditing never echoes a value", () => {
	test("counts are reported by class, action, and PII kind", () => {
		const results = [
			applyDataPolicy("msg", "a@b.com", { salt: SALT }),
			applyDataPolicy("gen_ai.prompt", "hello there", { salt: SALT }),
			applyDataPolicy("tool.arguments", "{}", { salt: SALT }),
			applyDataPolicy("n", "nothing here", { salt: SALT }),
		];
		const audit = auditCapture(results);
		expect(audit.values_examined).toBe(4);
		expect(audit.by_class.pii).toBe(1);
		expect(audit.by_class.prompt).toBe(1);
		expect(audit.by_action.drop).toBe(1);
		expect(audit.pii_by_kind.email).toBe(1);
	});

	test("the audit contains no captured values", () => {
		const audit = auditCapture([applyDataPolicy("msg", "a@secret-domain.com", { salt: SALT })]);
		expect(JSON.stringify(audit)).not.toContain("secret-domain");
	});

	test("downgrades are grouped with their reason and a count", () => {
		const audit = auditCapture([
			applyDataPolicy("m1", "a@b.com", { salt: "" }),
			applyDataPolicy("m2", "c@d.com", { salt: "" }),
		]);
		expect(audit.downgrades).toHaveLength(1);
		expect(audit.downgrades[0].count).toBe(2);
		expect(audit.downgrades[0].from).toBe("hash");
		expect(audit.downgrades[0].to).toBe("drop");
	});

	test("every audit repeats what the detectors cannot see", () => {
		const audit = auditCapture([]);
		expect(audit.undetectable).toEqual(UNDETECTABLE_PII);
		expect(audit.values_examined).toBe(0);
		expect(audit.pii_by_kind).toEqual({});
	});
});
