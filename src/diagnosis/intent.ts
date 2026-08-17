/**
 * Design-intent extraction and comparison (item 46).
 *
 * Localization is a comparison between what the code does and what it was
 * *supposed* to do. The second half is usually implicit, and when a codebase
 * states it more than once — in a spec, a test, a type annotation, and a runtime
 * invariant — those statements routinely disagree. Silently preferring one is
 * how a "fix" ends up satisfying the test while violating the documented
 * contract.
 *
 * This module extracts intent statements from each source, normalizes them into
 * comparable claims, and reports disagreements. It deliberately does **not**
 * resolve them: `reconcile` returns conflicts with full provenance and an
 * explicitly advisory ordering, never a winner. Choosing between a spec and a
 * test is a judgement about what the software is for, and that is not a
 * decision a regex should be making.
 *
 * Extraction is deliberately conservative. A missed statement costs a little
 * evidence; a fabricated one produces a confident, wrong contract, so every
 * pattern here matches an explicit syntactic form rather than guessing from
 * prose.
 *
 * Pure: takes text, returns data. No fs, network, or clock.
 */
import type { IntentSource } from "./hypothesis.js";

/**
 * A normalized, comparable assertion about a subject.
 *
 * Two claims conflict when they share a subject and kind but disagree on value
 * or polarity — the only comparison that can be made mechanically without
 * understanding the domain.
 */
export type Claim = {
	/** The symbol the claim is about. */
	subject: string;
	kind: "returns" | "raises" | "nullable" | "param_type" | "equals";
	/** Normalized value: a type name, an exception name, a literal. */
	value: string;
	/** `asserts` = "this holds"; `denies` = "this does not hold". */
	polarity: "asserts" | "denies";
};

export type IntentStatement = {
	source: IntentSource;
	/** The statement as a human would read it. */
	statement: string;
	/** `file:line` it was read from. */
	location: string;
	claim: Claim;
};

export type ExtractOptions = {
	/** Path recorded in each statement's location. */
	path: string;
	/** Symbol to scope extraction to. When absent, everything in the text is extracted. */
	subject?: string;
};

function loc(path: string, index: number): string {
	return `${path}:${index + 1}`;
}

/** Normalize a type expression so `Optional[str]`, `str | None`, and `str?` compare equal. */
export function normalizeType(raw: string): string {
	let t = raw.trim().replace(/[;,)]+$/, "");
	const optional = /^Optional\[(.+)\]$/.exec(t);
	if (optional) return `${normalizeType(optional[1])}|none`;
	t = t
		.replace(/\s*\|\s*/g, "|")
		.replace(/\bNone\b/g, "none")
		.replace(/\bnull\b/g, "none")
		.replace(/\bundefined\b/g, "none");
	return t.toLowerCase();
}

function isNoneLike(value: string): boolean {
	return value === "none" || value.split("|").includes("none");
}

/**
 * Intent asserted by tests: what the test says the code must do.
 *
 * Handles pytest (`assert x == y`, `pytest.raises(E)`, `assertRaises(E)`) and
 * the Jest/Vitest/Bun family (`expect(x).toBe(y)`, `.toEqual`, `.toThrow(E)`,
 * `.toBeNull()`). A test asserting an exception and a test asserting a return
 * value are recorded as different claim kinds so they can conflict.
 */
export function extractFromTests(text: string, opts: ExtractOptions): IntentStatement[] {
	const out: IntentStatement[] = [];
	const lines = text.split("\n");
	for (const [i, line] of lines.entries()) {
		const raises =
			/(?:pytest\.raises|assertRaises)\(\s*([A-Za-z_][\w.]*)/.exec(line) ??
			/\.(?:toThrow|toThrowError)\(\s*(?:new\s+)?([A-Za-z_][\w.]*)/.exec(line);
		if (raises) {
			out.push({
				source: "test",
				statement: `must raise ${raises[1]}`,
				location: loc(opts.path, i),
				claim: {
					subject: opts.subject ?? "(unspecified)",
					kind: "raises",
					value: raises[1],
					polarity: "asserts",
				},
			});
			continue;
		}

		// `.+?` rather than `[^)]+?`: the subject itself routinely contains
		// parentheses (`expect(findUser("1")).toBe(...)`), and a character class
		// that stops at the first `)` silently drops exactly those assertions.
		const expectNull = /expect\((.+?)\)\.(?:toBeNull|toBeUndefined)\(\s*\)/.exec(line);
		if (expectNull) {
			out.push({
				source: "test",
				statement: `${expectNull[1]} must be null/undefined`,
				location: loc(opts.path, i),
				claim: {
					subject: opts.subject ?? expectNull[1],
					kind: "nullable",
					value: "none",
					polarity: "asserts",
				},
			});
			continue;
		}

		const expectEq = /expect\((.+?)\)\.(?:toBe|toEqual|toStrictEqual)\(\s*(.+?)\s*\)\s*;?\s*$/.exec(
			line,
		);
		if (expectEq) {
			const value = expectEq[2];
			out.push({
				source: "test",
				statement: `${expectEq[1]} must equal ${value}`,
				location: loc(opts.path, i),
				claim: {
					subject: opts.subject ?? expectEq[1],
					kind: isNoneLike(normalizeType(value)) ? "nullable" : "equals",
					value: isNoneLike(normalizeType(value)) ? "none" : value,
					polarity: "asserts",
				},
			});
			continue;
		}

		const pyAssert = /^\s*assert\s+(.+?)\s*(==|is)\s*(.+?)\s*$/.exec(line);
		if (pyAssert) {
			const value = pyAssert[3].replace(/\s*,.*$/, "");
			const none = isNoneLike(normalizeType(value));
			out.push({
				source: "test",
				statement: `${pyAssert[1]} must ${pyAssert[2] === "is" ? "be" : "equal"} ${value}`,
				location: loc(opts.path, i),
				claim: {
					subject: opts.subject ?? pyAssert[1],
					kind: none ? "nullable" : "equals",
					value: none ? "none" : value,
					polarity: "asserts",
				},
			});
		}
	}
	return out;
}

/**
 * Intent encoded in type annotations: Python `def f(x: int) -> str:` and the
 * TypeScript equivalent. A nullable return is recorded as a `nullable` claim as
 * well as a `returns` claim, because "may return None" is the statement that
 * most often contradicts a test.
 */
export function extractFromTypes(text: string, opts: ExtractOptions): IntentStatement[] {
	const out: IntentStatement[] = [];
	for (const [i, line] of text.split("\n").entries()) {
		const py = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*?)\)\s*->\s*([^:]+):/.exec(line);
		const ts =
			/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\((.*?)\)\s*:\s*([^{]+)\{/.exec(
				line,
			);
		const match = py ?? ts;
		if (!match) continue;
		const [, name, params, returnType] = match;
		const normalized = normalizeType(returnType);
		out.push({
			source: "type",
			statement: `${name} returns ${returnType.trim()}`,
			location: loc(opts.path, i),
			claim: { subject: name, kind: "returns", value: normalized, polarity: "asserts" },
		});
		if (isNoneLike(normalized)) {
			out.push({
				source: "type",
				statement: `${name} may return None`,
				location: loc(opts.path, i),
				claim: { subject: name, kind: "nullable", value: "none", polarity: "asserts" },
			});
		}
		for (const param of params.split(",")) {
			const typed = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(.+?)\s*(?:=.*)?$/.exec(param);
			if (!typed) continue;
			out.push({
				source: "type",
				statement: `${name} parameter ${typed[1]} is ${typed[2].trim()}`,
				location: loc(opts.path, i),
				claim: {
					subject: `${name}.${typed[1]}`,
					kind: "param_type",
					value: normalizeType(typed[2]),
					polarity: "asserts",
				},
			});
		}
	}
	return out;
}

/**
 * Intent stated in prose: Python docstrings and JSDoc.
 *
 * Only the structured tags are read — `Returns:`, `Raises:`, `@returns`,
 * `@throws` — not arbitrary sentences. Parsing free prose into a contract is
 * exactly the kind of guess that produces a confident, wrong claim.
 */
export function extractFromSpec(text: string, opts: ExtractOptions): IntentStatement[] {
	const out: IntentStatement[] = [];
	const subject = opts.subject ?? "(unspecified)";
	for (const [i, line] of text.split("\n").entries()) {
		const raises = /(?:^|\s)(?:Raises:?|@throws)\s+([A-Za-z_][\w.]*)/.exec(line);
		if (raises) {
			out.push({
				source: "spec",
				statement: `documented to raise ${raises[1]}`,
				location: loc(opts.path, i),
				claim: { subject, kind: "raises", value: raises[1], polarity: "asserts" },
			});
			continue;
		}
		const returns = /(?:^|\s)(?:Returns:?|@returns?)\s+(?:\{([^}]+)\}|([A-Za-z_][\w.\[\]|]*))/.exec(
			line,
		);
		if (returns) {
			const value = normalizeType(returns[1] ?? returns[2]);
			out.push({
				source: "spec",
				statement: `documented to return ${returns[1] ?? returns[2]}`,
				location: loc(opts.path, i),
				claim: { subject, kind: "returns", value, polarity: "asserts" },
			});
			if (isNoneLike(value)) {
				out.push({
					source: "spec",
					statement: "documented to possibly return None",
					location: loc(opts.path, i),
					claim: { subject, kind: "nullable", value: "none", polarity: "asserts" },
				});
			}
		}
	}
	return out;
}

/**
 * Intent enforced at runtime: `assert`, explicit precondition raises, and
 * non-null guards in production code.
 *
 * A guard that raises on a missing value *denies* nullability — which is
 * precisely the claim that conflicts with a type saying `Optional[...]`.
 */
export function extractFromInvariants(text: string, opts: ExtractOptions): IntentStatement[] {
	const out: IntentStatement[] = [];
	const subject = opts.subject ?? "(unspecified)";
	const lines = text.split("\n");

	/**
	 * A guard and the raise it protects are usually on different lines in
	 * Python, so a same-line-only match would miss the common form entirely.
	 * Look ahead a couple of statements for the raise/throw.
	 */
	const raisesWithin = (start: number, span = 2): boolean => {
		let seen = 0;
		for (let j = start; j < lines.length && seen < span; j++) {
			const candidate = lines[j].trim();
			if (candidate.length === 0) continue;
			seen++;
			if (/^(?:raise|throw)\b/.test(candidate)) return true;
		}
		return false;
	};

	for (const [i, line] of lines.entries()) {
		const guardHead =
			/if\s*\(?\s*(?:not\s+([A-Za-z_$][\w$.]*)|!\s*([A-Za-z_$][\w$.]*)|([A-Za-z_$][\w$.]*)\s+is\s+None)/.exec(
				line,
			);
		const guard =
			guardHead && (/(?:raise|throw)\b/.test(line) || raisesWithin(i + 1)) ? guardHead : null;
		if (guard) {
			const name = guard[1] ?? guard[2] ?? guard[3];
			out.push({
				source: "invariant",
				statement: `${name} must not be None (guard raises)`,
				location: loc(opts.path, i),
				claim: { subject: name, kind: "nullable", value: "none", polarity: "denies" },
			});
			continue;
		}
		const assertion = /^\s*assert\s+([A-Za-z_$][\w$.]*)\s+is\s+not\s+None/.exec(line);
		if (assertion) {
			out.push({
				source: "invariant",
				statement: `${assertion[1]} is asserted non-None`,
				location: loc(opts.path, i),
				claim: {
					subject: assertion[1],
					kind: "nullable",
					value: "none",
					polarity: "denies",
				},
			});
			continue;
		}
		const raiseOnly = /^\s*raise\s+([A-Za-z_][\w.]*)/.exec(line);
		if (raiseOnly) {
			out.push({
				source: "invariant",
				statement: `raises ${raiseOnly[1]}`,
				location: loc(opts.path, i),
				claim: { subject, kind: "raises", value: raiseOnly[1], polarity: "asserts" },
			});
		}
	}
	return out;
}

/** Which extractor to run over a given piece of text. */
export type IntentInput = {
	kind: "test" | "type" | "spec" | "invariant";
	path: string;
	text: string;
	subject?: string;
};

const EXTRACTORS: Record<
	IntentInput["kind"],
	(text: string, opts: ExtractOptions) => IntentStatement[]
> = {
	test: extractFromTests,
	type: extractFromTypes,
	spec: extractFromSpec,
	invariant: extractFromInvariants,
};

/**
 * Run every requested extractor. The same file can legitimately be read by more
 * than one extractor — a module has both type annotations and invariants — so
 * inputs are independent rather than one-per-file.
 */
export function extractIntent(inputs: IntentInput[]): IntentStatement[] {
	return inputs.flatMap((input) =>
		EXTRACTORS[input.kind](input.text, {
			path: input.path,
			...(input.subject ? { subject: input.subject } : {}),
		}),
	);
}

export type IntentConflict = {
	subject: string;
	kind: Claim["kind"];
	detail: string;
	/** Every statement involved, with its provenance intact. */
	statements: IntentStatement[];
	/** Distinct sources that disagree. */
	sources: IntentSource[];
};

export type SubjectIntent = {
	subject: string;
	statements: IntentStatement[];
	conflicts: IntentConflict[];
	status: "consistent" | "conflicting";
};

export type IntentReport = {
	subjects: SubjectIntent[];
	conflicts: IntentConflict[];
	/**
	 * Source ordering offered for a human to consider — **advisory only**. This
	 * module never applies it: which source wins is a judgement about what the
	 * software is for, and the whole point of the item is to stop that judgement
	 * being made silently by whatever happened to be parsed first.
	 */
	advisory_precedence: IntentSource[];
	advisory_note: string;
};

/** Advisory ordering: the more binding a source usually is, the earlier it sits. */
export const ADVISORY_PRECEDENCE: IntentSource[] = [
	"spec",
	"invariant",
	"test",
	"type",
	"docstring",
	"commit_message",
	"inferred",
];

const ADVISORY_NOTE =
	"Precedence is advisory. Conflicting intent is reported, never resolved: deciding whether the spec or the test is authoritative is a judgement about what the software is for.";

function conflictDetail(kind: Claim["kind"], a: IntentStatement, b: IntentStatement): string {
	if (a.claim.polarity !== b.claim.polarity) {
		return `${a.source} asserts and ${b.source} denies ${kind} '${a.claim.value}'`;
	}
	return `${a.source} says ${kind} '${a.claim.value}' but ${b.source} says '${b.claim.value}'`;
}

/**
 * Group statements by subject and report disagreements.
 *
 * Two statements conflict when they share a subject and claim kind but differ in
 * polarity or value. Statements from the *same* source are not compared against
 * each other: a module with two `raise` sites is not contradicting itself, and
 * flagging that would bury the cross-source conflicts that matter.
 */
export function reconcile(statements: IntentStatement[]): IntentReport {
	const bySubject = new Map<string, IntentStatement[]>();
	for (const s of statements) {
		const existing = bySubject.get(s.claim.subject);
		if (existing) existing.push(s);
		else bySubject.set(s.claim.subject, [s]);
	}

	const subjects: SubjectIntent[] = [];
	const allConflicts: IntentConflict[] = [];

	for (const [subject, group] of [...bySubject.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		const conflicts: IntentConflict[] = [];
		const byKind = new Map<Claim["kind"], IntentStatement[]>();
		for (const s of group) {
			const existing = byKind.get(s.claim.kind);
			if (existing) existing.push(s);
			else byKind.set(s.claim.kind, [s]);
		}

		for (const [kind, kindGroup] of byKind) {
			for (let i = 0; i < kindGroup.length; i++) {
				for (let j = i + 1; j < kindGroup.length; j++) {
					const a = kindGroup[i];
					const b = kindGroup[j];
					if (a.source === b.source) continue;
					const disagrees =
						a.claim.polarity !== b.claim.polarity || a.claim.value !== b.claim.value;
					if (!disagrees) continue;
					const conflict: IntentConflict = {
						subject,
						kind,
						detail: conflictDetail(kind, a, b),
						statements: [a, b],
						sources: [a.source, b.source],
					};
					conflicts.push(conflict);
					allConflicts.push(conflict);
				}
			}
		}

		subjects.push({
			subject,
			statements: group,
			conflicts,
			status: conflicts.length > 0 ? "conflicting" : "consistent",
		});
	}

	return {
		subjects,
		conflicts: allConflicts,
		advisory_precedence: ADVISORY_PRECEDENCE,
		advisory_note: ADVISORY_NOTE,
	};
}

/**
 * Shape a subject's intent for attachment to a hypothesis (item 43).
 *
 * The primary statement is the highest-precedence source *present*, and every
 * other source that disagrees is carried in `conflicts` — so the hypothesis
 * records both what it assumed and what contradicted it, rather than a single
 * unattributed sentence.
 */
export function intentForSubject(
	report: IntentReport,
	subject: string,
): {
	source: IntentSource;
	statement: string;
	location?: string;
	conflicts: Array<{ source: IntentSource; statement: string }>;
} | null {
	const entry = report.subjects.find((s) => s.subject === subject);
	if (!entry || entry.statements.length === 0) return null;
	const ranked = [...entry.statements].sort(
		(a, b) =>
			ADVISORY_PRECEDENCE.indexOf(a.source) - ADVISORY_PRECEDENCE.indexOf(b.source) ||
			a.location.localeCompare(b.location),
	);
	const primary = ranked[0];
	const conflicts = entry.conflicts
		.flatMap((c) => c.statements)
		.filter((s) => s.source !== primary.source)
		.map((s) => ({ source: s.source, statement: s.statement }));
	// De-duplicate: one conflicting statement can appear in several pairs.
	const seen = new Set<string>();
	const unique = conflicts.filter((c) => {
		const key = `${c.source}::${c.statement}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		source: primary.source,
		statement: primary.statement,
		...(primary.location ? { location: primary.location } : {}),
		conflicts: unique,
	};
}
