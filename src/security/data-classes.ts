/**
 * Per-class capture policy for secrets, PII, prompts, and tool payloads
 * (item 62).
 *
 * `redaction.ts` removes secrets and `capture-policy.ts` gates telemetry
 * attributes. Neither distinguishes *why* a value is sensitive, and the four
 * reasons want different treatment:
 *
 * - **Secrets** must be destroyed. There is no analysis worth the risk of
 *   keeping a live credential, so the default is `drop`.
 * - **PII** usually wants to be *linkable but not readable*: knowing that the
 *   same user hit the same error twice is the whole diagnosis, and knowing who
 *   they are adds nothing. The default is a salted hash.
 * - **Prompts** are arbitrary user text with unbounded content and no reliable
 *   detector, so they are classified by *key* and dropped by default.
 * - **Tool payloads** are the most diagnostically valuable of the four and the
 *   hardest to justify dropping outright, so they are redacted and truncated
 *   rather than removed.
 *
 * Three decisions do the real work:
 *
 * 1. **A hash without a salt is not a hash.** An unsalted digest of an email
 *    address is reversible by anyone with a word list, so it offers the
 *    appearance of protection and none of the substance. When no salt is
 *    configured, the `hash` action *downgrades to `drop`* and says so in the
 *    report, rather than emitting a digest that will be treated as anonymized.
 *
 * 2. **Detection has to be specific enough to be worth having.** A sixteen-digit
 *    order number is not a credit card, and a policy that redacts every long
 *    number destroys the evidence it was meant to protect. Card candidates go
 *    through a Luhn check; a bare number that fails it is left alone.
 *
 * 3. **What cannot be detected is said out loud.** Personal names, free-text
 *    addresses, and account identifiers have no reliable pattern.
 *    `UNDETECTABLE_PII` names them, `classifyValue` never pretends to have
 *    found them, and the report carries the limitation so nobody reads "0 PII
 *    findings" as "no PII".
 *
 * Pure apart from reading the salt from the environment.
 */
import { createHash } from "node:crypto";
import { redactSecrets } from "./redaction.js";

export const DATA_CLASSES = ["secret", "pii", "prompt", "tool_payload"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const CAPTURE_ACTIONS = ["drop", "hash", "redact", "truncate", "allow"] as const;
export type CaptureAction = (typeof CAPTURE_ACTIONS)[number];

export type ClassPolicy = {
	action: CaptureAction;
	/** Byte ceiling applied when the action is `truncate`. */
	max_bytes?: number;
};

/**
 * Safe defaults.
 *
 * `allow` appears nowhere: every class starts restricted and is loosened
 * deliberately by an operator who has decided the trade is worth it, rather
 * than being open until somebody notices.
 */
export const DEFAULT_CLASS_POLICIES: Record<DataClass, ClassPolicy> = {
	secret: { action: "drop" },
	pii: { action: "hash" },
	prompt: { action: "drop" },
	tool_payload: { action: "truncate", max_bytes: 512 },
};

/** Environment variable holding the per-deployment PII hash salt. */
export const PII_SALT_ENV = "FAILSAFE_PII_SALT";
/** A salt shorter than this offers no real resistance to a dictionary attack. */
export const MIN_SALT_LENGTH = 16;

/**
 * PII this module cannot detect and does not claim to.
 *
 * Stated in the type system and repeated in every report, because the most
 * dangerous output a redaction tool can produce is a confident zero.
 */
export const UNDETECTABLE_PII = [
	"personal names",
	"free-text postal addresses",
	"account and customer identifiers",
	"dates of birth in ambiguous formats",
	"free-text health or financial narrative",
] as const;

/**
 * Attribute keys whose *value* is a prompt regardless of content.
 *
 * Prompts are arbitrary natural language; there is no content signature. The
 * only reliable signal is the field it arrived in.
 */
const PROMPT_KEYS = [
	"gen_ai.prompt",
	"gen_ai.completion",
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"llm.prompts",
	"llm.input_messages",
	"input.value",
	"output.value",
	"messages",
	"prompt",
	"completion",
	"system_prompt",
];

/** Attribute keys whose value is a tool call's arguments or result. */
const TOOL_PAYLOAD_KEYS = [
	"gen_ai.tool.call.arguments",
	"gen_ai.tool.call.result",
	"tool.arguments",
	"tool.result",
	"tool_input",
	"tool_output",
	"function.arguments",
	"arguments",
];

function keyMatches(key: string, candidates: string[]): boolean {
	const lower = key.toLowerCase();
	return candidates.some((c) => lower === c || lower.endsWith(`.${c}`));
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** E.164 and common national forms; deliberately requires a separator or +. */
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
/** 13-19 digits, optionally separated. Validated by Luhn before it counts. */
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const IPV4_RE =
	/\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

/**
 * Luhn check.
 *
 * The whole reason card detection is usable: without it, every order number,
 * batch id, and long timestamp in a log becomes "PII" and the report is noise.
 */
export function passesLuhn(digits: string): boolean {
	const clean = digits.replace(/\D/g, "");
	if (clean.length < 13 || clean.length > 19) return false;
	let sum = 0;
	let double = false;
	for (let i = clean.length - 1; i >= 0; i--) {
		let digit = clean.charCodeAt(i) - 48;
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return sum % 10 === 0;
}

export type PiiKind = "email" | "phone" | "ssn" | "card" | "ip";

export type PiiFinding = { kind: PiiKind; value: string; start: number };

/**
 * Find PII in text.
 *
 * Returns findings with offsets rather than a redacted string so a caller can
 * decide the action per class. Card candidates that fail Luhn are dropped
 * silently — a false positive here is not a safe default, it is destroyed
 * evidence.
 */
export function findPii(text: string): PiiFinding[] {
	const findings: PiiFinding[] = [];
	const scan = (re: RegExp, kind: PiiKind, validate?: (v: string) => boolean): void => {
		re.lastIndex = 0;
		let match: RegExpExecArray | null = re.exec(text);
		while (match !== null) {
			if (!validate || validate(match[0])) {
				findings.push({ kind, value: match[0], start: match.index });
			}
			match = re.exec(text);
		}
	};

	scan(EMAIL_RE, "email");
	scan(SSN_RE, "ssn");
	scan(CARD_CANDIDATE_RE, "card", passesLuhn);
	scan(PHONE_RE, "phone");
	scan(IPV4_RE, "ip");

	// Overlapping findings: keep the earliest-starting, longest match, so an
	// email is not also reported as a phone number inside its own digits.
	const sorted = [...findings].sort((a, b) => a.start - b.start || b.value.length - a.value.length);
	const kept: PiiFinding[] = [];
	let cursor = -1;
	for (const finding of sorted) {
		if (finding.start < cursor) continue;
		kept.push(finding);
		cursor = finding.start + finding.value.length;
	}
	return kept;
}

/**
 * Which classes a key/value pair falls into. A value can be in several.
 *
 * Key-based classes are checked first and do not depend on content, which is
 * the only way to catch a prompt that happens to contain nothing detectable.
 */
export function classifyValue(key: string, value: string): DataClass[] {
	const classes = new Set<DataClass>();
	if (keyMatches(key, PROMPT_KEYS)) classes.add("prompt");
	if (keyMatches(key, TOOL_PAYLOAD_KEYS)) classes.add("tool_payload");
	if (redactSecrets(value).matched.length > 0) classes.add("secret");
	if (findPii(value).length > 0) classes.add("pii");
	return DATA_CLASSES.filter((c) => classes.has(c));
}

export type SaltState = { available: boolean; reason?: string };

/** Whether a usable salt is configured. A weak salt counts as none. */
export function saltState(salt = process.env[PII_SALT_ENV]): SaltState {
	if (!salt) {
		return { available: false, reason: `${PII_SALT_ENV} is not set` };
	}
	if (salt.length < MIN_SALT_LENGTH) {
		return {
			available: false,
			reason: `${PII_SALT_ENV} is shorter than ${MIN_SALT_LENGTH} characters and offers no real resistance to a dictionary attack`,
		};
	}
	return { available: true };
}

/** Stable pseudonym for a value: linkable across records, not reversible. */
export function pseudonym(value: string, salt: string): string {
	return `pii_${createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 16)}`;
}

function truncateBytes(value: string, maxBytes: number): string {
	const buf = Buffer.from(value, "utf8");
	if (buf.length <= maxBytes) return value;
	return `${buf
		.subarray(0, Math.max(0, maxBytes - 3))
		.toString("utf8")
		.replace(/\uFFFD+$/, "")}...`;
}

export type ApplyResult = {
	/** The value to keep, or `undefined` when the policy dropped it. */
	value?: string;
	classes: DataClass[];
	/** The action actually taken, which may differ from the configured one. */
	action: CaptureAction;
	/** Set when the action taken differs from the configured one. */
	downgraded_from?: CaptureAction;
	downgrade_reason?: string;
	/** PII kinds found, by count. Values are never echoed here. */
	pii_counts: Partial<Record<PiiKind, number>>;
	secret_patterns: number;
};

export type ApplyOptions = {
	policies?: Partial<Record<DataClass, ClassPolicy>>;
	salt?: string;
};

/**
 * The strictest action wins when a value falls into several classes.
 *
 * A prompt containing a credential is a credential. Ordering the actions and
 * taking the minimum is what prevents the looser of two applicable policies
 * from being the one that runs.
 */
export const ACTION_STRICTNESS: Record<CaptureAction, number> = {
	drop: 0,
	hash: 1,
	redact: 2,
	truncate: 3,
	allow: 4,
};

/**
 * Apply the per-class policy to one key/value pair.
 *
 * `hash` downgrades to `drop` without a usable salt, and the downgrade is
 * reported rather than performed quietly — a digest that is treated as
 * anonymized when it is not is worse than no data at all.
 */
export function applyDataPolicy(key: string, value: string, opts: ApplyOptions = {}): ApplyResult {
	const policies = { ...DEFAULT_CLASS_POLICIES, ...(opts.policies ?? {}) };
	const classes = classifyValue(key, value);
	const pii = findPii(value);
	const piiCounts: Partial<Record<PiiKind, number>> = {};
	for (const finding of pii) piiCounts[finding.kind] = (piiCounts[finding.kind] ?? 0) + 1;
	const secrets = redactSecrets(value).matched.length;

	if (classes.length === 0) {
		return { value, classes, action: "allow", pii_counts: {}, secret_patterns: 0 };
	}

	const applicable = classes.map((c) => policies[c]);
	const chosen = applicable.reduce((strictest, p) =>
		ACTION_STRICTNESS[p.action] < ACTION_STRICTNESS[strictest.action] ? p : strictest,
	);

	let action = chosen.action;
	let downgradedFrom: CaptureAction | undefined;
	let downgradeReason: string | undefined;

	if (action === "hash") {
		const state = saltState(opts.salt ?? process.env[PII_SALT_ENV]);
		if (!state.available) {
			downgradedFrom = "hash";
			downgradeReason = state.reason;
			action = "drop";
		}
	}

	const base = {
		classes,
		action,
		...(downgradedFrom ? { downgraded_from: downgradedFrom } : {}),
		...(downgradeReason ? { downgrade_reason: downgradeReason } : {}),
		pii_counts: piiCounts,
		secret_patterns: secrets,
	};

	switch (action) {
		case "drop":
			return base;
		case "hash":
			return { ...base, value: hashPii(value, opts.salt ?? process.env[PII_SALT_ENV] ?? "") };
		case "redact":
			return { ...base, value: redactAll(value) };
		case "truncate":
			return {
				...base,
				value: truncateBytes(redactAll(value), chosen.max_bytes ?? 512),
			};
		case "allow":
			return { ...base, value };
	}
}

/** Replace every PII finding in `value` with a stable pseudonym. */
function hashPii(value: string, salt: string): string {
	let out = value;
	for (const finding of findPii(value)) {
		out = out.split(finding.value).join(pseudonym(finding.value, salt));
	}
	return redactSecrets(out).redacted;
}

/** Secrets removed outright; PII replaced with its kind, not its value. */
function redactAll(value: string): string {
	let out = redactSecrets(value).redacted;
	for (const finding of findPii(out)) {
		out = out.split(finding.value).join(`[${finding.kind.toUpperCase()}]`);
	}
	return out;
}

export type CaptureAudit = {
	values_examined: number;
	by_class: Record<DataClass, number>;
	by_action: Record<CaptureAction, number>;
	pii_by_kind: Partial<Record<PiiKind, number>>;
	downgrades: Array<{ from: CaptureAction; to: CaptureAction; reason: string; count: number }>;
	/**
	 * Repeated verbatim on every audit. A zero in `pii_by_kind` means the
	 * detectors found nothing, not that there is nothing to find.
	 */
	undetectable: readonly string[];
};

/** Summarize a batch of applications without echoing a single value. */
export function auditCapture(results: ApplyResult[]): CaptureAudit {
	const byClass = Object.fromEntries(DATA_CLASSES.map((c) => [c, 0])) as Record<DataClass, number>;
	const byAction = Object.fromEntries(CAPTURE_ACTIONS.map((a) => [a, 0])) as Record<
		CaptureAction,
		number
	>;
	const piiByKind: Partial<Record<PiiKind, number>> = {};
	const downgrades = new Map<
		string,
		{ from: CaptureAction; to: CaptureAction; reason: string; count: number }
	>();

	for (const result of results) {
		for (const c of result.classes) byClass[c]++;
		byAction[result.action]++;
		for (const [kind, count] of Object.entries(result.pii_counts)) {
			piiByKind[kind as PiiKind] = (piiByKind[kind as PiiKind] ?? 0) + (count ?? 0);
		}
		if (result.downgraded_from) {
			const key = `${result.downgraded_from}->${result.action}:${result.downgrade_reason ?? ""}`;
			const entry = downgrades.get(key) ?? {
				from: result.downgraded_from,
				to: result.action,
				reason: result.downgrade_reason ?? "unspecified",
				count: 0,
			};
			entry.count++;
			downgrades.set(key, entry);
		}
	}

	return {
		values_examined: results.length,
		by_class: byClass,
		by_action: byAction,
		pii_by_kind: piiByKind,
		downgrades: [...downgrades.values()].sort((a, b) => b.count - a.count),
		undetectable: UNDETECTABLE_PII,
	};
}
