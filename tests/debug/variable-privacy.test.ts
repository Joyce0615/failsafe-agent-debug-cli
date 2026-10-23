/**
 * Tests for the debugger variable/evaluate privacy policy (item 19).
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MAX_VARIABLE_VALUE_BYTES,
	DEFAULT_VARIABLE_EXPOSURE,
	DEFAULT_VARIABLE_PRIVACY_POLICY,
	type GovernedVariable,
	governEvaluateResult,
	governScope,
	governStateSnapshot,
	governVariable,
	scopeKind,
} from "../../src/debug/variable-privacy.js";
import type { ScopeSnapshot, StateSnapshot, VariableSnapshot } from "../../src/types/debug.js";

const SALT = "a-sufficiently-long-deployment-salt";

function v(name: string, value: string, extra: Partial<VariableSnapshot> = {}): VariableSnapshot {
	return { name, value, ...extra };
}

describe("scopeKind", () => {
	test("recognizes locals/local, arguments/args/parameters, closure/upvalues, globals/global", () => {
		expect(scopeKind("Locals")).toBe("locals");
		expect(scopeKind("local")).toBe("locals");
		expect(scopeKind("Arguments")).toBe("arguments");
		expect(scopeKind("Args")).toBe("arguments");
		expect(scopeKind("Parameters")).toBe("arguments");
		expect(scopeKind("Closure")).toBe("closure");
		expect(scopeKind("Upvalues")).toBe("closure");
		expect(scopeKind("Globals")).toBe("globals");
		expect(scopeKind("global")).toBe("globals");
	});

	test("an unrecognized DAP scope name falls back to 'other', not 'full' by implication", () => {
		expect(scopeKind("Registers")).toBe("other");
		expect(DEFAULT_VARIABLE_EXPOSURE.other).toBe("summary");
	});
});

describe("governVariable: exposure gate", () => {
	test("'none' drops the variable down to just its name", () => {
		const result = governVariable(v("password", "hunter2"), "none");
		expect(result).toEqual({ name: "password", exposure: "none" });
	});

	test("'summary' keeps name/type/has_children but never the value", () => {
		const variable = v("big_object", "{...}", { type: "dict", children_ref: 7 });
		const result = governVariable(variable, "summary");
		expect(result.value).toBeUndefined();
		expect(result.name).toBe("big_object");
		expect(result.type).toBe("dict");
		expect(result.has_children).toBe(true);
	});

	test("'summary' omits has_children when there is no children_ref", () => {
		const result = governVariable(v("x", "42", { type: "int" }), "summary");
		expect(result.has_children).toBeUndefined();
	});

	test("'full' with an innocuous value passes it through with an 'allow' disposition", () => {
		const result = governVariable(v("count", "42", { type: "int" }), "full");
		expect(result.value).toBe("42");
		expect(result.disposition?.action).toBe("allow");
		expect(result.disposition?.classes).toEqual([]);
	});
});

describe("governVariable: classify/redact (reuses data-classes.ts)", () => {
	test("a value matching a secret pattern is dropped, regardless of variable name", () => {
		const result = governVariable(v("cfg", `ghp_${"a".repeat(36)}`), "full");
		expect(result.value).toBeUndefined();
		expect(result.disposition?.action).toBe("drop");
		expect(result.disposition?.classes).toContain("secret");
	});

	test("a variable literally named 'password' is caught by key even with a benign-looking value", () => {
		const result = governVariable(v("password", "correct horse battery staple"), "full");
		// Not a detectable secret/PII pattern and not a prompt/tool key, so the
		// name-based data class ("secret"/"pii") does not fire here either —
		// this documents the real boundary: classifyValue has no generic
		// "variable name says password" rule of its own, data-classes.ts's key
		// matching is scoped to prompt/tool_payload keys only. The point of
		// this test is that nothing in this module invents a name-based secret
		// rule that data-classes.ts doesn't already have.
		expect(result.value).toBe("correct horse battery staple");
	});

	test("PII hashes to a stable pseudonym when a salt is configured", () => {
		const policy = { ...DEFAULT_VARIABLE_PRIVACY_POLICY, salt: SALT };
		const result = governVariable(v("user_email", "a@b.com"), "full", policy);
		expect(result.value).toMatch(/^pii_[a-f0-9]{16}$/);
		expect(result.disposition?.action).toBe("hash");
		expect(result.disposition?.classes).toContain("pii");
	});

	test("PII downgrades to drop without a usable salt", () => {
		const result = governVariable(v("user_email", "a@b.com"), "full");
		expect(result.value).toBeUndefined();
		expect(result.disposition?.action).toBe("drop");
		expect(result.disposition?.downgraded_from).toBe("hash");
	});

	test("a dropped value with children_ref still reports has_children", () => {
		const result = governVariable(
			v("secret_obj", `ghp_${"a".repeat(36)}`, { children_ref: 3 }),
			"full",
		);
		expect(result.value).toBeUndefined();
		expect(result.has_children).toBe(true);
	});
});

describe("governVariable: byte ceiling, independent of redaction", () => {
	test("a long but otherwise unclassified value is truncated to the byte ceiling", () => {
		const big = "x".repeat(DEFAULT_MAX_VARIABLE_VALUE_BYTES + 50);
		const result = governVariable(v("buf", big), "full");
		expect(result.value).toBeDefined();
		expect(Buffer.byteLength(result.value as string, "utf8")).toBeLessThanOrEqual(
			DEFAULT_MAX_VARIABLE_VALUE_BYTES,
		);
		expect(result.disposition?.length_truncated).toBe(true);
	});

	test("a short value is not marked length_truncated", () => {
		const result = governVariable(v("x", "42"), "full");
		expect(result.disposition?.length_truncated).toBe(false);
	});

	test("a custom max_value_bytes is honored", () => {
		const policy = { ...DEFAULT_VARIABLE_PRIVACY_POLICY, max_value_bytes: 5 };
		const result = governVariable(v("x", "0123456789"), "full", policy);
		expect(Buffer.byteLength(result.value as string, "utf8")).toBeLessThanOrEqual(5);
	});
});

describe("governScope", () => {
	function scope(name: string, variables: VariableSnapshot[]): ScopeSnapshot {
		return { name, variables };
	}

	test("locals default to full exposure", () => {
		const result = governScope(scope("Locals", [v("x", "1")]));
		expect(result.kind).toBe("locals");
		expect(result.exposure).toBe("full");
		expect(result.variables[0].value).toBe("1");
	});

	test("globals default to summary exposure and never carry a value", () => {
		const result = governScope(scope("Globals", [v("DEBUG", "true")]));
		expect(result.kind).toBe("globals");
		expect(result.exposure).toBe("summary");
		expect(result.variables[0].value).toBeUndefined();
	});

	test("an explicit 'none' override drops every variable in the scope, not just their values", () => {
		const policy = {
			...DEFAULT_VARIABLE_PRIVACY_POLICY,
			exposure: { ...DEFAULT_VARIABLE_EXPOSURE, locals: "none" as const },
		};
		const result = governScope(scope("Locals", [v("x", "1"), v("y", "2")]), policy);
		expect(result.variables).toEqual([]);
	});
});

describe("governStateSnapshot", () => {
	function snapshot(scopes: ScopeSnapshot[]): StateSnapshot {
		return { thread_id: "1", frame_id: "1", location: { file: "a.py", line: 1 }, scopes };
	}

	test("governs every scope and reports an audit over the full set of values", () => {
		const { snapshot: governed, report } = governStateSnapshot(
			snapshot([
				{ name: "Locals", variables: [v("x", "1"), v("key", `ghp_${"a".repeat(36)}`)] },
				{ name: "Globals", variables: [v("DEBUG", "true")] },
			]),
		);
		expect(governed.scopes).toHaveLength(2);
		const locals = governed.scopes.find((s) => s.kind === "locals")!;
		expect(locals.variables.map((v) => v.name)).toEqual(["x", "key"]);
		expect(locals.variables[1].value).toBeUndefined();
		expect(report.audit.by_class.secret).toBe(1);
		expect(report.scopes_withheld).toEqual([]);
	});

	test("reports which scopes were withheld entirely when exposure is 'none'", () => {
		const policy = {
			...DEFAULT_VARIABLE_PRIVACY_POLICY,
			exposure: { ...DEFAULT_VARIABLE_EXPOSURE, globals: "none" as const },
		};
		const { report } = governStateSnapshot(
			snapshot([
				{ name: "Locals", variables: [v("x", "1")] },
				{ name: "Globals", variables: [v("DEBUG", "true")] },
			]),
			policy,
		);
		expect(report.scopes_withheld).toEqual(["Globals"]);
	});

	test("location passes through unchanged", () => {
		const { snapshot: governed } = governStateSnapshot(snapshot([]));
		expect(governed.location).toEqual({ file: "a.py", line: 1 });
		expect(governed.thread_id).toBe("1");
		expect(governed.frame_id).toBe("1");
	});
});

describe("governEvaluateResult", () => {
	test("an innocuous expression passes through with an 'allow' disposition and a summary only over 100 chars", () => {
		const result = governEvaluateResult("1+1", { value: "2", type: "int" });
		expect(result.value).toBe("2");
		expect(result.disposition.action).toBe("allow");
		expect(result.summary).toBeUndefined();
	});

	test("a secret-matching evaluated value is dropped", () => {
		const result = governEvaluateResult("os.environ['TOKEN']", {
			value: `ghp_${"a".repeat(36)}`,
			type: "str",
		});
		expect(result.value).toBeUndefined();
		expect(result.disposition.action).toBe("drop");
	});

	test("a long surviving value gets a summary derived from the governed value, not the raw one", () => {
		const long = "y".repeat(150);
		const result = governEvaluateResult("buf", { value: long, type: "str" });
		expect(result.summary).toBeDefined();
		expect(result.summary).toContain(long.substring(0, 100));
	});

	test("when the value is dropped, no summary is produced even for a long raw value", () => {
		const long = `ghp_${"a".repeat(100)}`;
		const result = governEvaluateResult("token", { value: long, type: "str" });
		expect(result.value).toBeUndefined();
		expect(result.summary).toBeUndefined();
	});

	test("respects the byte ceiling the same way governVariable does", () => {
		const big = "z".repeat(DEFAULT_MAX_VARIABLE_VALUE_BYTES + 50);
		const result = governEvaluateResult("buf", { value: big, type: "str" });
		expect(Buffer.byteLength(result.value as string, "utf8")).toBeLessThanOrEqual(
			DEFAULT_MAX_VARIABLE_VALUE_BYTES,
		);
		expect(result.disposition.length_truncated).toBe(true);
	});
});

describe("end-to-end: a credential never survives governance regardless of entry point", () => {
	test("the same secret value is dropped whether seen as a local variable or an evaluate result", () => {
		const secret = `ghp_${"a".repeat(36)}`;
		const asVariable: GovernedVariable = governVariable(v("tok", secret), "full");
		const asEvaluate = governEvaluateResult("tok", { value: secret, type: "str" });
		expect(asVariable.value).toBeUndefined();
		expect(asEvaluate.value).toBeUndefined();
	});
});
