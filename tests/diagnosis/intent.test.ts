import { describe, expect, test } from "bun:test";
import {
	ADVISORY_PRECEDENCE,
	type IntentStatement,
	extractFromInvariants,
	extractFromSpec,
	extractFromTests,
	extractFromTypes,
	extractIntent,
	intentForSubject,
	normalizeType,
	reconcile,
} from "../../src/diagnosis/intent.js";

const PY_SOURCE = `
def lookup_email(payload: dict, strict: bool) -> Optional[str]:
    """Find the user's email.

    Returns: str
    Raises: KeyError
    """
    if not payload:
        raise ValueError("payload required")
    return payload.get("email")
`;

const PY_TEST = `
def test_lookup_email_missing():
    assert lookup_email({}, False) is None

def test_lookup_email_strict():
    with pytest.raises(KeyError):
        lookup_email({}, True)
`;

describe("type normalization", () => {
	test("Optional[T], T | None, and null all normalize to the same nullable form", () => {
		expect(normalizeType("Optional[str]")).toBe("str|none");
		expect(normalizeType("str | None")).toBe("str|none");
		expect(normalizeType("string | null")).toBe("string|none");
	});

	test("trailing punctuation and case are normalized away", () => {
		expect(normalizeType("  Str;  ")).toBe("str");
		expect(normalizeType("number,")).toBe("number");
	});
});

describe("type extraction", () => {
	test("reads a Python return annotation and its parameters", () => {
		const statements = extractFromTypes(PY_SOURCE, { path: "src/auth.py" });
		const returns = statements.find((s) => s.claim.kind === "returns");
		expect(returns?.claim.subject).toBe("lookup_email");
		expect(returns?.claim.value).toBe("str|none");
		expect(returns?.location).toBe("src/auth.py:2");
		expect(
			statements.find((s) => s.claim.subject === "lookup_email.strict")?.claim.value,
		).toBe("bool");
	});

	test("a nullable return also yields an explicit nullable claim", () => {
		const statements = extractFromTypes(PY_SOURCE, { path: "src/auth.py" });
		const nullable = statements.find((s) => s.claim.kind === "nullable");
		expect(nullable?.claim.polarity).toBe("asserts");
	});

	test("reads a TypeScript signature", () => {
		const statements = extractFromTypes(
			"export function findUser(id: string): User | null {\n}\n",
			{ path: "src/users.ts" },
		);
		expect(statements.find((s) => s.claim.kind === "returns")?.claim.value).toBe("user|none");
		expect(statements.some((s) => s.claim.kind === "nullable")).toBe(true);
	});

	test("an unannotated function yields nothing rather than a guess", () => {
		expect(extractFromTypes("def f(x):\n    return x\n", { path: "a.py" })).toEqual([]);
	});
});

describe("test extraction", () => {
	test("reads a pytest identity assertion as a nullable claim", () => {
		const statements = extractFromTests(PY_TEST, {
			path: "tests/test_auth.py",
			subject: "lookup_email",
		});
		const nullable = statements.find((s) => s.claim.kind === "nullable");
		expect(nullable?.claim.polarity).toBe("asserts");
		expect(nullable?.source).toBe("test");
	});

	test("reads pytest.raises as a raises claim", () => {
		const statements = extractFromTests(PY_TEST, {
			path: "tests/test_auth.py",
			subject: "lookup_email",
		});
		expect(statements.find((s) => s.claim.kind === "raises")?.claim.value).toBe("KeyError");
	});

	test("reads the Jest family", () => {
		const statements = extractFromTests(
			[
				'expect(findUser("1")).toBe(null);',
				"expect(total()).toEqual(42);",
				"expect(() => boom()).toThrow(TypeError);",
				"expect(maybe()).toBeUndefined();",
			].join("\n"),
			{ path: "tests/u.test.ts" },
		);
		expect(statements.map((s) => s.claim.kind).sort()).toEqual([
			"equals",
			"nullable",
			"nullable",
			"raises",
		]);
		expect(statements.find((s) => s.claim.kind === "equals")?.claim.value).toBe("42");
	});

	test("prose mentioning an exception is not mistaken for an assertion", () => {
		expect(
			extractFromTests("# this should raise KeyError eventually\n", { path: "t.py" }),
		).toEqual([]);
	});
});

describe("spec extraction", () => {
	test("reads structured Returns/Raises tags", () => {
		const statements = extractFromSpec(PY_SOURCE, {
			path: "src/auth.py",
			subject: "lookup_email",
		});
		expect(statements.some((s) => s.claim.kind === "raises" && s.claim.value === "KeyError")).toBe(
			true,
		);
		expect(statements.some((s) => s.claim.kind === "returns")).toBe(true);
	});

	test("reads JSDoc tags", () => {
		const statements = extractFromSpec(
			" * @returns {User} the user\n * @throws NotFoundError\n",
			{ path: "src/u.ts", subject: "findUser" },
		);
		expect(statements.map((s) => s.claim.kind).sort()).toEqual(["raises", "returns"]);
	});

	test("free prose is not parsed into a contract", () => {
		expect(
			extractFromSpec("This function should probably return a user object.\n", { path: "a.ts" }),
		).toEqual([]);
	});
});

describe("invariant extraction", () => {
	test("a guard that raises denies nullability", () => {
		const statements = extractFromInvariants(PY_SOURCE, { path: "src/auth.py" });
		const guard = statements.find((s) => s.claim.kind === "nullable");
		expect(guard?.claim.subject).toBe("payload");
		expect(guard?.claim.polarity).toBe("denies");
	});

	test("an explicit non-None assertion denies nullability", () => {
		const statements = extractFromInvariants("    assert user is not None\n", { path: "a.py" });
		expect(statements[0].claim.polarity).toBe("denies");
		expect(statements[0].claim.subject).toBe("user");
	});

	test("a bare raise is recorded as a raises claim", () => {
		const statements = extractFromInvariants("    raise ValueError('x')\n", {
			path: "a.py",
			subject: "f",
		});
		expect(statements[0].claim).toMatchObject({ kind: "raises", value: "ValueError" });
	});

	test("a TypeScript null guard is recognized", () => {
		const statements = extractFromInvariants(
			"  if (!user) { throw new Error('missing'); }\n",
			{ path: "a.ts" },
		);
		expect(statements[0].claim.polarity).toBe("denies");
	});
});

describe("reconciliation", () => {
	function statementsForAuth(): IntentStatement[] {
		return extractIntent([
			{ kind: "type", path: "src/auth.py", text: PY_SOURCE },
			{ kind: "spec", path: "src/auth.py", text: PY_SOURCE, subject: "lookup_email" },
			{ kind: "test", path: "tests/test_auth.py", text: PY_TEST, subject: "lookup_email" },
		]);
	}

	test("a docstring promising str and a type saying Optional[str] is a conflict", () => {
		const report = reconcile(statementsForAuth());
		const subject = report.subjects.find((s) => s.subject === "lookup_email");
		expect(subject?.status).toBe("conflicting");
		expect(
			report.conflicts.some(
				(c) => c.kind === "returns" && c.sources.includes("spec") && c.sources.includes("type"),
			),
		).toBe(true);
	});

	test("sources that agree about the raised exception are not flagged", () => {
		const report = reconcile(statementsForAuth());
		expect(report.conflicts.some((c) => c.kind === "raises")).toBe(false);
	});

	test("a conflict names both sources and keeps both locations", () => {
		const report = reconcile([
			{
				source: "type",
				statement: "f returns str|none",
				location: "src/a.py:1",
				claim: { subject: "f", kind: "returns", value: "str|none", polarity: "asserts" },
			},
			{
				source: "spec",
				statement: "f returns str",
				location: "docs/a.md:9",
				claim: { subject: "f", kind: "returns", value: "str", polarity: "asserts" },
			},
		]);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0].sources.sort()).toEqual(["spec", "type"]);
		expect(report.conflicts[0].statements.map((s) => s.location).sort()).toEqual([
			"docs/a.md:9",
			"src/a.py:1",
		]);
	});

	test("opposite polarity on the same value is a conflict", () => {
		const report = reconcile([
			{
				source: "type",
				statement: "may be None",
				location: "a.py:1",
				claim: { subject: "user", kind: "nullable", value: "none", polarity: "asserts" },
			},
			{
				source: "invariant",
				statement: "guard raises on None",
				location: "a.py:9",
				claim: { subject: "user", kind: "nullable", value: "none", polarity: "denies" },
			},
		]);
		expect(report.conflicts[0].detail).toContain("asserts and");
		expect(report.conflicts[0].detail).toContain("denies");
	});

	test("two statements from the same source are not treated as self-contradiction", () => {
		const report = reconcile([
			{
				source: "invariant",
				statement: "raises ValueError",
				location: "a.py:3",
				claim: { subject: "f", kind: "raises", value: "ValueError", polarity: "asserts" },
			},
			{
				source: "invariant",
				statement: "raises KeyError",
				location: "a.py:7",
				claim: { subject: "f", kind: "raises", value: "KeyError", polarity: "asserts" },
			},
		]);
		expect(report.conflicts).toEqual([]);
		expect(report.subjects[0].status).toBe("consistent");
	});

	test("agreeing sources produce no conflict", () => {
		const report = reconcile([
			{
				source: "type",
				statement: "returns str",
				location: "a.py:1",
				claim: { subject: "f", kind: "returns", value: "str", polarity: "asserts" },
			},
			{
				source: "spec",
				statement: "returns str",
				location: "a.py:2",
				claim: { subject: "f", kind: "returns", value: "str", polarity: "asserts" },
			},
		]);
		expect(report.conflicts).toEqual([]);
	});

	test("different claim kinds about one subject do not collide", () => {
		const report = reconcile([
			{
				source: "type",
				statement: "returns str",
				location: "a.py:1",
				claim: { subject: "f", kind: "returns", value: "str", polarity: "asserts" },
			},
			{
				source: "test",
				statement: "raises KeyError",
				location: "t.py:1",
				claim: { subject: "f", kind: "raises", value: "KeyError", polarity: "asserts" },
			},
		]);
		expect(report.conflicts).toEqual([]);
	});

	test("precedence is offered but never applied", () => {
		const report = reconcile(statementsForAuth());
		expect(report.advisory_precedence[0]).toBe("spec");
		expect(report.advisory_note).toContain("advisory");
		expect(report.advisory_note).toContain("never resolved");
		// No field anywhere declares a winner.
		expect(Object.keys(report)).not.toContain("resolved");
		expect(Object.keys(report)).not.toContain("winner");
	});

	test("subjects are ordered deterministically", () => {
		const report = reconcile([
			{
				source: "type",
				statement: "z",
				location: "a:1",
				claim: { subject: "zeta", kind: "returns", value: "str", polarity: "asserts" },
			},
			{
				source: "type",
				statement: "a",
				location: "a:2",
				claim: { subject: "alpha", kind: "returns", value: "str", polarity: "asserts" },
			},
		]);
		expect(report.subjects.map((s) => s.subject)).toEqual(["alpha", "zeta"]);
	});

	test("no statements yields an empty, non-throwing report", () => {
		const report = reconcile([]);
		expect(report.subjects).toEqual([]);
		expect(report.conflicts).toEqual([]);
		expect(ADVISORY_PRECEDENCE).toContain("inferred");
	});
});

describe("intent for a hypothesis", () => {
	test("picks the highest-precedence source present and carries the rest as conflicts", () => {
		const report = reconcile([
			{
				source: "type",
				statement: "returns str|none",
				location: "a.py:1",
				claim: { subject: "f", kind: "returns", value: "str|none", polarity: "asserts" },
			},
			{
				source: "spec",
				statement: "returns str",
				location: "a.py:2",
				claim: { subject: "f", kind: "returns", value: "str", polarity: "asserts" },
			},
		]);
		const intent = intentForSubject(report, "f");
		expect(intent?.source).toBe("spec");
		expect(intent?.conflicts).toEqual([{ source: "type", statement: "returns str|none" }]);
	});

	test("a consistent subject carries no conflicts", () => {
		const report = reconcile([
			{
				source: "test",
				statement: "returns str",
				location: "t.py:1",
				claim: { subject: "f", kind: "returns", value: "str", polarity: "asserts" },
			},
		]);
		expect(intentForSubject(report, "f")?.conflicts).toEqual([]);
	});

	test("a conflicting statement appearing in several pairs is listed once", () => {
		const report = reconcile([
			{
				source: "spec",
				statement: "returns str",
				location: "a:1",
				claim: { subject: "f", kind: "returns", value: "str", polarity: "asserts" },
			},
			{
				source: "type",
				statement: "returns int",
				location: "a:2",
				claim: { subject: "f", kind: "returns", value: "int", polarity: "asserts" },
			},
			{
				source: "test",
				statement: "returns bool",
				location: "a:3",
				claim: { subject: "f", kind: "returns", value: "bool", polarity: "asserts" },
			},
		]);
		const intent = intentForSubject(report, "f");
		expect(intent?.conflicts).toHaveLength(2);
	});

	test("an unknown subject returns null rather than inventing intent", () => {
		expect(intentForSubject(reconcile([]), "nope")).toBeNull();
	});
});
