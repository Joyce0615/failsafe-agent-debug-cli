import { nanoid } from "nanoid";

export function failureId(): string {
	return `fail_${nanoid(12)}`;
}

export function diagnosisId(): string {
	return `diag_${nanoid(12)}`;
}

export function reproId(): string {
	return `repro_${nanoid(12)}`;
}

export function debugId(): string {
	return `dbg_${nanoid(12)}`;
}

export function learnedRuleId(): string {
	return `lrule_${nanoid(12)}`;
}

/** Id for an exported diagnostic bundle (item 49). */
export function bundleId(): string {
	return `bundle_${nanoid(12)}`;
}

/** Id for a durable Detect→Attribute→Recover→Rerun remediation run (item 96). */
export function remediationRunId(): string {
	return `rr_${nanoid(12)}`;
}
