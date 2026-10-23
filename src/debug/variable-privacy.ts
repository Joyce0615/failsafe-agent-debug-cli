/**
 * Privacy policy for debugger variable trees and evaluate responses (item
 * 19).
 *
 * `debug/state.ts` builds a `StateSnapshot` straight from the DAP `scopes` /
 * `variables` responses, and `debug/controller.ts#evaluate` returns the DAP
 * `evaluate` response, with nothing beyond a byte-length truncation in
 * between. Neither asks *what* a value is before it reaches the model or a
 * shared bundle: a password held in a local, a customer email captured by a
 * breakpoint, or a giant buffer dumped as a string all flow out unchanged.
 * `data-classes.ts` (item 62) already answers "what is this value and what
 * should happen to it" for telemetry attributes; this module applies the
 * same classify → redact/hash/drop decision to debugger values instead of
 * re-deriving it, so a secret found in a span attribute and a secret found
 * in a local variable are governed by one policy, not two.
 *
 * Four things happen to every variable/evaluate result before it leaves this
 * module, in this order:
 *
 * 1. **Classify** — `classifyValue` (from `data-classes.ts`) runs against the
 *    variable's *name* (as the key) and its *value*, so a variable literally
 *    named `password` is caught even when its value doesn't match a known
 *    secret pattern, and a value that matches a secret pattern is caught
 *    regardless of what the variable is called.
 * 2. **Redact** — the strictest matching class policy's action
 *    (drop/hash/redact/truncate/allow, via `applyDataPolicy`) is applied to
 *    the value itself.
 * 3. **Truncate** — independently of redaction, a byte ceiling bounds every
 *    surviving value so one huge buffer or array can't blow the response
 *    size; this applies even to values no class policy touched.
 * 4. **Capability-gate** — a `VariableExposureCapability` decides, before any
 *    of the above even runs, whether a *scope kind* is visible at all.
 *    `globals` and `closure` default to `summary` (name/type/child count,
 *    never a value) because a debugger that answers "what is the value of
 *    every global" by default hands over far more than a local breakpoint
 *    ever intended to expose; `locals` and `arguments` default to `full`
 *    (classify/redact/truncate still apply) because that is the data a step
 *    was taken to see. A caller can widen or narrow either explicitly.
 *
 * Pure: no fs, network, process, or clock. Operates on `VariableSnapshot` /
 * `ScopeSnapshot` / `StateSnapshot` (`types/debug.ts`) and the DAP
 * `evaluate` result shape, not on a live `DapClient` — callers apply this
 * after capture and before anything is returned to a model or written into
 * an exported bundle.
 */
import {
	ACTION_STRICTNESS,
	type ApplyResult,
	type CaptureAudit,
	type DataClass,
	applyDataPolicy,
	auditCapture,
} from "../security/data-classes.js";
import type {
	ScopeSnapshot,
	StateSnapshot,
	VariableChange,
	VariableSnapshot,
} from "../types/debug.js";

/**
 * How much of a scope's variables are exposed.
 *
 * - `none`: the scope is dropped entirely (not even names survive).
 * - `summary`: name, type, and whether the value is structured (has
 *   children) survive; the value itself does not.
 * - `full`: the value survives, subject to classify/redact/truncate.
 */
export const VARIABLE_EXPOSURE_LEVELS = ["none", "summary", "full"] as const;
export type VariableExposureLevel = (typeof VARIABLE_EXPOSURE_LEVELS)[number];

/** Scope kinds this policy distinguishes, matched case-insensitively against `ScopeSnapshot.name`. */
export const SCOPE_KINDS = ["locals", "arguments", "closure", "globals", "other"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** Per-scope-kind exposure, keyed by {@link ScopeKind}. */
export type VariableExposureCapability = Record<ScopeKind, VariableExposureLevel>;

/**
 * Defaults. `locals`/`arguments` are `full` — a breakpoint exists to show
 * them. `closure`/`globals` are `summary` — process-wide state is exactly
 * the thing a default should not hand over wholesale. `other` (an adapter's
 * scope name this module doesn't recognize) is `summary`, the conservative
 * middle, rather than silently inheriting `full`.
 */
export const DEFAULT_VARIABLE_EXPOSURE: VariableExposureCapability = {
	locals: "full",
	arguments: "full",
	closure: "summary",
	globals: "summary",
	other: "summary",
};

/** Classify a DAP scope name into one of {@link SCOPE_KINDS}. */
export function scopeKind(name: string): ScopeKind {
	const lower = name.toLowerCase();
	if (lower === "locals" || lower === "local") return "locals";
	if (lower === "arguments" || lower === "args" || lower === "parameters") return "arguments";
	if (lower === "closure" || lower === "upvalues") return "closure";
	if (lower === "globals" || lower === "global") return "globals";
	return "other";
}

/** Byte ceiling applied to every surviving value, independent of redaction. */
export const DEFAULT_MAX_VARIABLE_VALUE_BYTES = 256;

export type VariablePrivacyPolicy = {
	exposure: VariableExposureCapability;
	max_value_bytes: number;
	salt?: string;
};

export const DEFAULT_VARIABLE_PRIVACY_POLICY: VariablePrivacyPolicy = {
	exposure: DEFAULT_VARIABLE_EXPOSURE,
	max_value_bytes: DEFAULT_MAX_VARIABLE_VALUE_BYTES,
};

/**
 * Build a policy from `FailsafeConfig.debug_variable_privacy`.
 *
 * Takes the config's exposure/byte-ceiling fields directly; the PII salt is
 * deliberately not sourced from config (it comes from `data-classes.ts`'s
 * own `FAILSAFE_PII_SALT` environment lookup inside `applyDataPolicy`, same
 * as every other caller of that policy) so there is exactly one place that
 * decides whether a salt is usable.
 */
export function resolveVariablePrivacyPolicy(config?: {
	debug_variable_privacy: {
		locals: VariableExposureLevel;
		arguments: VariableExposureLevel;
		closure: VariableExposureLevel;
		globals: VariableExposureLevel;
		other: VariableExposureLevel;
		max_value_bytes: number;
	};
}): VariablePrivacyPolicy {
	if (!config) return { ...DEFAULT_VARIABLE_PRIVACY_POLICY };
	const c = config.debug_variable_privacy;
	return {
		exposure: {
			locals: c.locals,
			arguments: c.arguments,
			closure: c.closure,
			globals: c.globals,
			other: c.other,
		},
		max_value_bytes: c.max_value_bytes,
	};
}

function truncateBytes(value: string, maxBytes: number): string {
	const buf = Buffer.from(value, "utf8");
	if (buf.length <= maxBytes) return value;
	return `${buf
		.subarray(0, Math.max(0, maxBytes - 3))
		.toString("utf8")
		.replace(/\uFFFD+$/, "")}...`;
}

export type PrivacyDisposition = {
	/** `drop` | `hash` | `redact` | `truncate` | `allow`, as decided by `applyDataPolicy`. */
	action: ApplyResult["action"];
	classes: DataClass[];
	downgraded_from?: ApplyResult["downgraded_from"];
	/** Set when the byte ceiling shortened the surviving value further. */
	length_truncated: boolean;
};

export type GovernedVariable = {
	name: string;
	type?: string;
	/** `undefined` when the exposure level or class policy dropped the value. */
	value?: string;
	children_ref?: number;
	/** Present only when `value` is withheld but the variable is structured. */
	has_children?: boolean;
	exposure: VariableExposureLevel;
	disposition?: PrivacyDisposition;
};

/**
 * Apply the privacy policy to one variable, having already decided the
 * scope's {@link VariableExposureLevel}.
 */
export function governVariable(
	variable: VariableSnapshot,
	exposure: VariableExposureLevel,
	policy: VariablePrivacyPolicy = DEFAULT_VARIABLE_PRIVACY_POLICY,
): GovernedVariable {
	if (exposure === "none") {
		return { name: variable.name, exposure };
	}

	if (exposure === "summary") {
		return {
			name: variable.name,
			type: variable.type,
			exposure,
			...(variable.children_ref !== undefined ? { has_children: true } : {}),
		};
	}

	// exposure === "full": classify/redact, then an independent byte ceiling.
	const applied = applyDataPolicy(variable.name, variable.value, { salt: policy.salt });
	let value = applied.value;
	let lengthTruncated = false;
	if (value !== undefined && Buffer.byteLength(value, "utf8") > policy.max_value_bytes) {
		value = truncateBytes(value, policy.max_value_bytes);
		lengthTruncated = true;
	}

	return {
		name: variable.name,
		type: variable.type,
		value,
		exposure,
		children_ref: variable.children_ref,
		...(value === undefined && variable.children_ref !== undefined ? { has_children: true } : {}),
		disposition: {
			action: applied.action,
			classes: applied.classes,
			...(applied.downgraded_from ? { downgraded_from: applied.downgraded_from } : {}),
			length_truncated: lengthTruncated,
		},
	};
}

export type GovernedScope = {
	name: string;
	kind: ScopeKind;
	exposure: VariableExposureLevel;
	variables: GovernedVariable[];
};

/** Apply the privacy policy to one scope's variables. */
export function governScope(
	scope: ScopeSnapshot,
	policy: VariablePrivacyPolicy = DEFAULT_VARIABLE_PRIVACY_POLICY,
): GovernedScope {
	const kind = scopeKind(scope.name);
	const exposure = policy.exposure[kind];
	return {
		name: scope.name,
		kind,
		exposure,
		variables:
			exposure === "none" ? [] : scope.variables.map((v) => governVariable(v, exposure, policy)),
	};
}

export type GovernedStateSnapshot = {
	thread_id: string;
	frame_id: string;
	location: StateSnapshot["location"];
	scopes: GovernedScope[];
};

export type PrivacyReport = {
	policy: VariablePrivacyPolicy;
	values_examined: number;
	audit: CaptureAudit;
	/** Scopes present in the input whose exposure level is `none`. */
	scopes_withheld: string[];
};

/**
 * Apply the privacy policy to every scope/variable in a captured snapshot,
 * before it is returned to a model or written into a bundle/export.
 */
export function governStateSnapshot(
	snapshot: StateSnapshot,
	policy: VariablePrivacyPolicy = DEFAULT_VARIABLE_PRIVACY_POLICY,
): { snapshot: GovernedStateSnapshot; report: PrivacyReport } {
	const scopes = snapshot.scopes.map((s) => governScope(s, policy));
	const results: ApplyResult[] = [];
	const scopesWithheld: string[] = [];

	for (const scope of scopes) {
		if (scope.exposure === "none") scopesWithheld.push(scope.name);
		for (const v of scope.variables) {
			if (v.disposition) {
				results.push({
					value: v.value,
					classes: v.disposition.classes,
					action: v.disposition.action,
					downgraded_from: v.disposition.downgraded_from,
					pii_counts: {},
					secret_patterns: 0,
				});
			}
		}
	}

	return {
		snapshot: {
			thread_id: snapshot.thread_id,
			frame_id: snapshot.frame_id,
			location: snapshot.location,
			scopes,
		},
		report: {
			policy,
			values_examined: results.length,
			audit: auditCapture(results),
			scopes_withheld: scopesWithheld,
		},
	};
}

export type RawEvaluateResult = { value: string; type?: string; summary?: string };

export type GovernedEvaluateResult = {
	/** `undefined` when the class policy dropped the evaluated value. */
	value?: string;
	type?: string;
	summary?: string;
	disposition: PrivacyDisposition;
};

/**
 * Apply the privacy policy to an `evaluate` result.
 *
 * `evaluate` has no scope, so there is no exposure-level gate here (an
 * expression the caller chose to run is treated as the `full` exposure a
 * `locals` variable would get) — but the same classify/redact/truncate
 * treatment applies, keyed on the expression text as the "name" so a secret
 * fetched by `expr os.environ["API_KEY"]` is still caught by `data-classes.ts`
 * even though the literal *value* might not match a pattern on its own
 * (e.g. the raw secret bytes), and a variable whose *expression* names a
 * known-sensitive key is redacted regardless of what it evaluates to.
 */
export function governEvaluateResult(
	expression: string,
	result: RawEvaluateResult,
	policy: VariablePrivacyPolicy = DEFAULT_VARIABLE_PRIVACY_POLICY,
): GovernedEvaluateResult {
	const applied = applyDataPolicy(expression, result.value, { salt: policy.salt });
	let value = applied.value;
	let lengthTruncated = false;
	if (value !== undefined && Buffer.byteLength(value, "utf8") > policy.max_value_bytes) {
		value = truncateBytes(value, policy.max_value_bytes);
		lengthTruncated = true;
	}

	// The summary is derived from the (possibly already-governed) value, never
	// from `result.summary`/`result.value` directly, so a redacted/hashed
	// evaluate result can't leak its original content back out through the
	// one-line summary. A dropped value has no summary either.
	const summary =
		value !== undefined && value.length > 100
			? `${result.type ?? "value"}: ${value.substring(0, 100)}...`
			: undefined;

	return {
		value,
		type: result.type,
		summary,
		disposition: {
			action: applied.action,
			classes: applied.classes,
			...(applied.downgraded_from ? { downgraded_from: applied.downgraded_from } : {}),
			length_truncated: lengthTruncated,
		},
	};
}

export type GovernedVariableChange = {
	name: string;
	/** `undefined` when the policy dropped the before/after values. */
	before?: string;
	after?: string;
	note?: string;
	disposition: PrivacyDisposition;
};

/**
 * Apply the privacy policy to one `computeStateDelta` entry.
 *
 * `before` and `after` are classified/redacted/truncated independently
 * (the "before" value governs its own disposition and "after" governs its
 * own) because a variable can cross a sensitivity boundary mid-step — e.g.
 * `None` becoming a freshly-fetched credential — and governing both halves
 * together would either expose the later value by inheriting the earlier
 * half's clearance, or needlessly hide the earlier half because of what the
 * later one turned out to be. The disposition reported is the stricter of
 * the two (by `data-classes.ts`'s `ACTION_STRICTNESS`), so a report can't
 * read "allow" when either half was actually redacted.
 */
export function governVariableChange(
	change: VariableChange,
	policy: VariablePrivacyPolicy = DEFAULT_VARIABLE_PRIVACY_POLICY,
): GovernedVariableChange {
	const sentinels = new Set(["<not in scope>", "<out of scope>"]);
	const govern = (value: string): { value?: string; disposition: PrivacyDisposition } => {
		if (sentinels.has(value)) {
			return { value, disposition: { action: "allow", classes: [], length_truncated: false } };
		}
		const applied = applyDataPolicy(change.name, value, { salt: policy.salt });
		let out = applied.value;
		let lengthTruncated = false;
		if (out !== undefined && Buffer.byteLength(out, "utf8") > policy.max_value_bytes) {
			out = truncateBytes(out, policy.max_value_bytes);
			lengthTruncated = true;
		}
		return {
			value: out,
			disposition: {
				action: applied.action,
				classes: applied.classes,
				...(applied.downgraded_from ? { downgraded_from: applied.downgraded_from } : {}),
				length_truncated: lengthTruncated,
			},
		};
	};

	const before = govern(change.before);
	const after = govern(change.after);
	const stricter =
		ACTION_STRICTNESS[before.disposition.action] <= ACTION_STRICTNESS[after.disposition.action]
			? before.disposition
			: after.disposition;

	return {
		name: change.name,
		before: before.value,
		after: after.value,
		note: change.note,
		disposition: stricter,
	};
}
