import type { ContextSlice, DiagnosisCategory, EvidenceItem } from "../types/diagnosis.js";
import type { ParsedError } from "../types/failure.js";

/** Helper: check message OR error_type against a pattern */
function msgOrType(e: ParsedError, pattern: RegExp): boolean {
	return pattern.test(e.message) || pattern.test(e.error_type ?? "");
}

export type DiagnosisTemplate = {
	id: string;
	category: DiagnosisCategory;
	match: (errors: ParsedError[]) => boolean;
	diagnose: (
		errors: ParsedError[],
		context: ContextSlice[],
	) => {
		summary: string;
		explanation: string;
		confidence: number;
		evidence: EvidenceItem[];
		uncertainty: string[];
	};
};

const isNullRef = (e: ParsedError) =>
	/TypeError.*(?:undefined|null|Cannot read propert)/i.test(e.message) ||
	/NoneType/i.test(e.message) ||
	msgOrType(e, /TypeError/i);

const nullReference: DiagnosisTemplate = {
	id: "null_reference",
	category: "null_reference",
	match: (errors) => errors.some(isNullRef),
	diagnose: (errors, context) => {
		const err = errors.find(isNullRef)!;
		const loc = err.location ? `${err.location.file}:${err.location.line}` : "unknown";
		const evidence: EvidenceItem[] = [{ kind: "error_message", value: err.message }];
		if (err.location) {
			evidence.push({ kind: "stack_frame", location: loc, value: err.message });
		}
		if (context.length > 0) {
			evidence.push({
				kind: "source_slice",
				location: `${context[0].file}:${context[0].start_line}-${context[0].end_line}`,
				value: context[0].text.substring(0, 500),
			});
		}
		return {
			summary: `Null/undefined access: ${err.message}`,
			explanation: `Code accesses a property or method on a null/undefined value at ${loc}`,
			confidence: 0.8,
			evidence,
			uncertainty: ["Need to confirm the runtime value of the variable at failure point"],
		};
	},
};

const keyError: DiagnosisTemplate = {
	id: "key_error",
	category: "key_error",
	match: (errors) => errors.some((e) => msgOrType(e, /KeyError/i)),
	diagnose: (errors, context) => {
		const err = errors.find((e) => msgOrType(e, /KeyError/i))!;
		const keyMatch = err.message.match(/KeyError:\s*['"]?(.+?)['"]?\s*$/);
		const key = keyMatch?.[1] ?? "unknown";
		const loc = err.location ? `${err.location.file}:${err.location.line}` : "unknown";
		const evidence: EvidenceItem[] = [{ kind: "error_message", value: err.message }];
		if (err.location) {
			evidence.push({ kind: "stack_frame", location: loc, value: `Missing key: ${key}` });
		}
		return {
			summary: `KeyError: missing key '${key}'`,
			explanation: `Dictionary/object access with key '${key}' failed because the key does not exist at ${loc}`,
			confidence: 0.85,
			evidence,
			uncertainty: ["Need to inspect the actual dictionary/object contents at runtime"],
		};
	},
};

const attributeError: DiagnosisTemplate = {
	id: "attribute_error",
	category: "attribute_error",
	match: (errors) => errors.some((e) => msgOrType(e, /AttributeError/i)),
	diagnose: (errors, context) => {
		const err = errors.find((e) => msgOrType(e, /AttributeError/i))!;
		const attrMatch = err.message.match(/has no attribute\s+'(.+?)'/);
		const attr = attrMatch?.[1] ?? "unknown";
		const loc = err.location ? `${err.location.file}:${err.location.line}` : "unknown";
		return {
			summary: `AttributeError: missing attribute '${attr}'`,
			explanation: `Object does not have attribute '${attr}' at ${loc}`,
			confidence: 0.82,
			evidence: [
				{ kind: "error_message", value: err.message },
				...(err.location
					? [{ kind: "stack_frame" as const, location: loc, value: `Missing attribute: ${attr}` }]
					: []),
			],
			uncertainty: [
				"Need to check the actual type of the object at runtime",
				"The attribute might be misspelled or the wrong object is being accessed",
			],
		};
	},
};

const importError: DiagnosisTemplate = {
	id: "import_error",
	category: "import_error",
	match: (errors) =>
		errors.some(
			(e) =>
				/(?:ModuleNotFoundError|ImportError|Cannot find module|Module not found)/i.test(
					e.message,
				) || /(?:ModuleNotFoundError|ImportError)/i.test(e.error_type ?? ""),
		),
	diagnose: (errors) => {
		const err = errors.find(
			(e) =>
				/(?:ModuleNotFoundError|ImportError|Cannot find module|Module not found)/i.test(
					e.message,
				) || /(?:ModuleNotFoundError|ImportError)/i.test(e.error_type ?? ""),
		)!;
		const modMatch =
			err.message.match(/No module named\s+'(.+?)'/) ||
			err.message.match(/Cannot find module\s+'(.+?)'/) ||
			err.message.match(/Module not found.*'(.+?)'/);
		const mod = modMatch?.[1] ?? "unknown";
		return {
			summary: `Import error: module '${mod}' not found`,
			explanation: `The module '${mod}' cannot be imported. It may not be installed, or the import path may be wrong.`,
			confidence: 0.9,
			evidence: [{ kind: "error_message", value: err.message }],
			uncertainty: [
				`Check if '${mod}' is in dependencies/requirements`,
				"The module name or path may be misspelled",
			],
		};
	},
};

const isAssertionMismatch = (e: ParsedError) =>
	e.assertion_diff !== undefined ||
	msgOrType(e, /AssertionError/i) ||
	/Expected.*Received/i.test(e.message) ||
	/\bassert\b/i.test(e.message);

const assertionMismatch: DiagnosisTemplate = {
	id: "assertion_mismatch",
	category: "assertion_mismatch",
	match: (errors) => errors.some(isAssertionMismatch),
	diagnose: (errors, context) => {
		const err = errors.find(isAssertionMismatch)!;
		const loc = err.location ? `${err.location.file}:${err.location.line}` : "unknown";
		const evidence: EvidenceItem[] = [{ kind: "error_message", value: err.message }];
		if (err.assertion_diff) {
			evidence.push({
				kind: "assertion_diff",
				location: loc,
				value: `Expected: ${err.assertion_diff.expected ?? "?"} | Actual: ${err.assertion_diff.actual ?? "?"}`,
			});
		}
		if (err.test_name) {
			evidence.push({
				kind: "test_input",
				location: err.test_file,
				value: `Test: ${err.test_name}`,
			});
		}
		return {
			summary: `Assertion failed${err.test_name ? ` in ${err.test_name}` : ""}: ${err.message.substring(0, 120)}`,
			explanation: `Test assertion failed at ${loc}. The actual value does not match the expected value.`,
			confidence: 0.75,
			evidence,
			uncertainty: [
				"Need to inspect why the actual value differs from expected",
				"Check if the test expectations are correct or if the code behavior changed",
			],
		};
	},
};

const typeError: DiagnosisTemplate = {
	id: "type_error",
	category: "type_error",
	match: (errors) =>
		errors.some(
			(e) =>
				/^TS\d+$/.test(e.error_type ?? "") ||
				(e.error_type === "type_error" && /error TS\d+/i.test(e.message)),
		),
	diagnose: (errors) => {
		const typeErrors = errors.filter(
			(e) => /^TS\d+$/.test(e.error_type ?? "") || /error TS\d+/i.test(e.message),
		);
		const first = typeErrors[0];
		const loc = first.location ? `${first.location.file}:${first.location.line}` : "unknown";
		return {
			summary: `TypeScript error${typeErrors.length > 1 ? `s (${typeErrors.length})` : ""}: ${first.message.substring(0, 120)}`,
			explanation: `TypeScript compiler found type error(s). First error at ${loc}: ${first.message}`,
			confidence: 0.95,
			evidence: typeErrors.slice(0, 5).map((e) => ({
				kind: "error_message" as const,
				location: e.location ? `${e.location.file}:${e.location.line}` : undefined,
				value: `${e.error_type}: ${e.message}`,
			})),
			uncertainty:
				typeErrors.length > 5 ? [`${typeErrors.length - 5} additional type errors not shown`] : [],
		};
	},
};

const syntaxError: DiagnosisTemplate = {
	id: "syntax_error",
	category: "syntax_error",
	match: (errors) => errors.some((e) => msgOrType(e, /SyntaxError/i)),
	diagnose: (errors) => {
		const err = errors.find((e) => msgOrType(e, /SyntaxError/i))!;
		const loc = err.location ? `${err.location.file}:${err.location.line}` : "unknown";
		return {
			summary: `Syntax error at ${loc}`,
			explanation: `Code has a syntax error at ${loc}: ${err.message}`,
			confidence: 0.95,
			evidence: [{ kind: "error_message", value: err.message }],
			uncertainty: [],
		};
	},
};

const indexError: DiagnosisTemplate = {
	id: "index_error",
	category: "index_error",
	match: (errors) =>
		errors.some((e) => msgOrType(e, /IndexError/i) || /RangeError.*index/i.test(e.message)),
	diagnose: (errors) => {
		const err = errors.find(
			(e) => msgOrType(e, /IndexError/i) || /RangeError.*index/i.test(e.message),
		)!;
		const loc = err.location ? `${err.location.file}:${err.location.line}` : "unknown";
		return {
			summary: `Index out of range at ${loc}`,
			explanation: `Array/list index is out of bounds at ${loc}: ${err.message}`,
			confidence: 0.85,
			evidence: [{ kind: "error_message", value: err.message }],
			uncertainty: ["Need to check the collection size and the index value at runtime"],
		};
	},
};

const lintViolation: DiagnosisTemplate = {
	id: "lint_violation",
	category: "lint_violation",
	match: (errors) =>
		errors.some(
			(e) =>
				e.error_type !== undefined && (e.error_type.includes("/") || e.error_type.startsWith("@")),
		),
	diagnose: (errors) => {
		const lintErrors = errors.filter(
			(e) =>
				e.error_type !== undefined && (e.error_type.includes("/") || e.error_type.startsWith("@")),
		);
		const first = lintErrors[0];
		return {
			summary: `Lint violation${lintErrors.length > 1 ? `s (${lintErrors.length})` : ""}: ${first.error_type}`,
			explanation: `Linter found ${lintErrors.length} violation(s). First: ${first.error_type} — ${first.message}`,
			confidence: 0.95,
			evidence: lintErrors.slice(0, 5).map((e) => ({
				kind: "error_message" as const,
				location: e.location ? `${e.location.file}:${e.location.line}` : undefined,
				value: `${e.error_type}: ${e.message}`,
			})),
			uncertainty: [],
		};
	},
};

const timeout: DiagnosisTemplate = {
	id: "timeout",
	category: "timeout",
	match: (errors) => errors.some((e) => /timed? ?out/i.test(e.message) || msgOrType(e, /timeout/i)),
	diagnose: (errors) => {
		const err = errors.find((e) => /timed? ?out/i.test(e.message) || msgOrType(e, /timeout/i))!;
		return {
			summary: "Command timed out",
			explanation: `The command exceeded its timeout limit: ${err.message}`,
			confidence: 0.9,
			evidence: [{ kind: "error_message", value: err.message }],
			uncertainty: [
				"The command may need more time, or it may be hanging",
				"Check for infinite loops or blocking I/O",
			],
		};
	},
};

const permissionError: DiagnosisTemplate = {
	id: "permission_error",
	category: "permission_error",
	match: (errors) =>
		errors.some(
			(e) =>
				/PermissionError|EACCES|EPERM|Permission denied/i.test(e.message) ||
				msgOrType(e, /PermissionError/i),
		),
	diagnose: (errors) => {
		const err = errors.find(
			(e) =>
				/PermissionError|EACCES|EPERM|Permission denied/i.test(e.message) ||
				msgOrType(e, /PermissionError/i),
		)!;
		return {
			summary: `Permission denied: ${err.message.substring(0, 100)}`,
			explanation: `The operation was denied due to insufficient permissions: ${err.message}`,
			confidence: 0.9,
			evidence: [{ kind: "error_message", value: err.message }],
			uncertainty: ["Check file/directory permissions and ownership"],
		};
	},
};

const connectionError: DiagnosisTemplate = {
	id: "connection_error",
	category: "connection_error",
	match: (errors) =>
		errors.some((e) =>
			/ConnectionError|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e.message),
		),
	diagnose: (errors) => {
		const err = errors.find((e) =>
			/ConnectionError|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e.message),
		)!;
		return {
			summary: `Connection error: ${err.message.substring(0, 100)}`,
			explanation: `A network connection failed: ${err.message}`,
			confidence: 0.85,
			evidence: [{ kind: "error_message", value: err.message }],
			uncertainty: [
				"Check if the target service is running",
				"Verify network connectivity and firewall rules",
			],
		};
	},
};

export const TEMPLATES: DiagnosisTemplate[] = [
	nullReference,
	keyError,
	attributeError,
	importError,
	assertionMismatch,
	typeError,
	syntaxError,
	indexError,
	lintViolation,
	timeout,
	permissionError,
	connectionError,
];
