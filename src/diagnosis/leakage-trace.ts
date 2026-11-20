/**
 * Detect prompt-variable and structured-result leakage across every surface
 * a value can reach (item 46, module-header numbering: item 112, confirmed
 * next-free via `grep -rohE "item [0-9]+" src --include="*.ts" | sort -t'
 * ' -k2 -n -u`, highest prior being item 111 from item 45's
 * `spec-divergence.ts`).
 *
 * `security/data-classes.ts` (item 62) already decides, per key/value pair,
 * what a secret/PII/prompt/tool-payload value is ALLOWED to look like after
 * policy — `classifyValue` + `applyDataPolicy`, unmodified, is this
 * project's one authoritative "what should survive" answer, and this
 * module never re-derives it. What does not exist anywhere is a check that
 * the SAME value, as it passes through every surface the item names
 * (spans, logs, exceptions, caches, bundles, model-visible results),
 * actually got that SAME treatment everywhere it landed. `grep -rln
 * "classifyAttribute\|classifyValue\|applyDataPolicy" src --include="*.ts"`
 * shows five callers before this module (`capture-policy.ts` for spans,
 * `variable-privacy.ts` for debugger variables, `action-log.ts`,
 * `evidence-budget.ts`, `authority-privacy-reduction.ts`) and every one of
 * them applies the policy to ITS OWN surface in isolation — none compares
 * across surfaces, and three of the item's six named surfaces (logs,
 * caches, model-visible results) have no policy-enforcement caller at
 * all: `storage/sqlite.ts`'s `getCachedDiagnosis`/`saveCachedDiagnosis`
 * cache a `FailureDiagnosis` packet verbatim, `exchange/bundle.ts` only
 * runs `redactSecrets` (the `secret` class alone, not `pii`/`prompt`/
 * `tool_payload`), and nothing checks what a CLI/MCP caller's own
 * model-visible JSON output (`cli/format.ts`'s `outputResult`) actually
 * contains before it reaches a model.
 *
 * This module traces one already-known value (a prompt variable's value,
 * or a structured tool result's value — the two things the item names) as
 * it is RE-OBSERVED at each surface, and classifies each observation
 * against the ONE shared policy `applyDataPolicy` computes for it:
 *
 * - A `SurfaceCapture` with `kind: "schema_metadata"` is the item's own
 *   named exception: a surface that recorded only a fact ABOUT the value
 *   (its key name, its type, its length, a redacted placeholder) carries
 *   no content at all, and is unconditionally `schema_metadata_only` —
 *   this is the distinguishing axis the item's own wording asks for,
 *   named as its own verdict rather than folded into "compliant" (a
 *   caller auditing for over-permissive capture wants to see HOW a
 *   surface stayed safe, not just that it did).
 * - A `SurfaceCapture` with `kind: "content"` is compared, FIRST, against
 *   EXACTLY what `applyDataPolicy` says this value should look like after
 *   policy (its `drop`/`hash`/`redact`/`truncate` result, `""` standing in
 *   for `drop`'s `undefined`). An exact match is `compliant`: this surface
 *   applied the identical shared transform every other compliant surface
 *   applied — checked before the raw-value check because a transform like
 *   `truncate` can legitimately be a no-op on a short, pattern-free value,
 *   making the policy's own expected output IDENTICAL to the raw value;
 *   that is the policy working as designed, not a leak, so this ordering
 *   is not incidental.
 * - Failing that, if the surface's own recorded string still contains the
 *   raw value verbatim, that is `leaked` — UNLESS the policy's own action
 *   for this value is `allow`, in which case nothing is being withheld
 *   from anywhere and raw content reaching every surface is correct, not
 *   a violation.
 * - Anything else — not the raw value, not the shared policy's own output —
 *   is `inconsistent_transform`, not silently trusted as safe nor assumed
 *   to be a second kind of leak. A surface that redacted with a different
 *   scheme than the shared policy (a different truncation length, a
 *   locally-reimplemented hash) is a real finding — "this surface diverged
 *   from the one policy everywhere else agreed on" — but this module
 *   cannot know, from a captured string alone, whether that divergence
 *   under- or over-protects, so it refuses to guess which.
 *
 * `leaking_surfaces`/`first_leak` are reported in the item's OWN six-
 * surface listing order (span -> log -> exception -> cache -> bundle ->
 * model_visible_result), mirroring `programmatic-tool-failure.ts`'s
 * (item 43) and `spec-divergence.ts`'s (item 45) own fixed-pipeline-order
 * discipline for naming the first/primary finding deterministically.
 *
 * Pure: every value, surface observation, and policy is caller-supplied;
 * nothing here reads a span, a log, a cache, a bundle, or a model
 * response — a caller already captured those and supplies what each
 * surface actually recorded.
 */
import {
	type ApplyOptions,
	type CaptureAction,
	type DataClass,
	applyDataPolicy,
	classifyValue,
} from "../security/data-classes.js";

/** The item's own six named surfaces, in the order it names them. */
export const CAPTURE_SURFACES = [
	"span",
	"log",
	"exception",
	"cache",
	"bundle",
	"model_visible_result",
] as const;
export type CaptureSurface = (typeof CAPTURE_SURFACES)[number];

export type TrackedValue = {
	value_id: string;
	/** The attribute/field key this value originated under, feeding `classifyValue`'s key-based checks exactly as `data-classes.ts` already does for a span attribute. */
	key: string;
	/** The raw value being traced. Never echoed into the report. */
	value: string;
};

/**
 * One observation of a tracked value at one surface.
 *
 * `kind: "schema_metadata"` names a surface that recorded a fact ABOUT the
 * value (key, type, length, a placeholder) and no content at all —
 * distinct, by construction, from `kind: "content"`'s actual recorded
 * string.
 */
export type SurfaceCapture =
	| { surface: CaptureSurface; location: string; kind: "schema_metadata" }
	| { surface: CaptureSurface; location: string; kind: "content"; captured: string };

export const SURFACE_VERDICTS = [
	"schema_metadata_only",
	"compliant",
	"leaked",
	"inconsistent_transform",
] as const;
export type SurfaceVerdict = (typeof SURFACE_VERDICTS)[number];

export type SurfaceObservation = {
	surface: CaptureSurface;
	location: string;
	verdict: SurfaceVerdict;
	detail: string;
};

export type ValueLeakageReport = {
	value_id: string;
	classes: DataClass[];
	expected_action: CaptureAction;
	observations: SurfaceObservation[];
	/** Unique surfaces carrying at least one `leaked` observation, in the item's own six-surface order. */
	leaking_surfaces: CaptureSurface[];
	/** The earliest-in-pipeline-order leaking surface, or `null` when nothing leaked. */
	first_leak: CaptureSurface | null;
};

/**
 * Classify one surface observation against the single shared policy
 * `applyDataPolicy` computes for this value.
 */
export function classifySurfaceCapture(
	value: TrackedValue,
	capture: SurfaceCapture,
	opts: ApplyOptions = {},
): SurfaceObservation {
	const base = { surface: capture.surface, location: capture.location };

	if (capture.kind === "schema_metadata") {
		return {
			...base,
			verdict: "schema_metadata_only",
			detail: `'${capture.location}' recorded only schema metadata (key/type/length), never the value's content`,
		};
	}

	const expected = applyDataPolicy(value.key, value.value, opts);

	if (expected.action === "allow") {
		return {
			...base,
			verdict: "compliant",
			detail: `the shared policy allows this value unrestricted; '${capture.location}' carrying it is not a violation`,
		};
	}

	// The policy's own output is checked FIRST: a transform like `truncate`
	// can legitimately be a no-op on a short, pattern-free value, which makes
	// the policy's own expected output IDENTICAL to the raw value — that is
	// the policy working as designed, not a leak, so an exact match against
	// what `applyDataPolicy` itself produced always wins before the raw-
	// substring check runs.
	const expectedCaptured = expected.value ?? "";
	if (capture.captured === expectedCaptured) {
		return {
			...base,
			verdict: "compliant",
			detail: `'${capture.location}' recorded exactly what the shared policy's '${expected.action}' action produces`,
		};
	}

	const rawPresent = value.value.length > 0 && capture.captured.includes(value.value);
	if (rawPresent) {
		return {
			...base,
			verdict: "leaked",
			detail: `'${capture.location}' recorded the raw value verbatim, but the shared policy requires '${expected.action}'`,
		};
	}

	return {
		...base,
		verdict: "inconsistent_transform",
		detail: `'${capture.location}' recorded neither the raw value nor the shared policy's own '${expected.action}' output; it applied some other transform this module cannot verify as safe`,
	};
}

/**
 * Trace one tracked value across every surface observation supplied,
 * against the single shared policy computed once for the value.
 */
export function traceValueLeakage(
	value: TrackedValue,
	captures: SurfaceCapture[],
	opts: ApplyOptions = {},
): ValueLeakageReport {
	const classes = classifyValue(value.key, value.value);
	const expected_action = applyDataPolicy(value.key, value.value, opts).action;
	const observations = captures.map((capture) => classifySurfaceCapture(value, capture, opts));

	const leakedSurfaceSet = new Set(
		observations.filter((o) => o.verdict === "leaked").map((o) => o.surface),
	);
	const leaking_surfaces = CAPTURE_SURFACES.filter((s) => leakedSurfaceSet.has(s));

	return {
		value_id: value.value_id,
		classes,
		expected_action,
		observations,
		leaking_surfaces,
		first_leak: leaking_surfaces[0] ?? null,
	};
}

export type TrackedValueCapture = { value: TrackedValue; captures: SurfaceCapture[] };

export type LeakageSweepReport = {
	reports: ValueLeakageReport[];
	/** `value_id`s with at least one `leaked` observation, in supplied order. */
	leaked_value_ids: string[];
};

/** Compose `traceValueLeakage` across many tracked values, exactly as a caller (CLI/MCP) would. */
export function sweepLeakage(
	valuesWithCaptures: TrackedValueCapture[],
	opts: ApplyOptions = {},
): LeakageSweepReport {
	const reports = valuesWithCaptures.map(({ value, captures }) =>
		traceValueLeakage(value, captures, opts),
	);
	const leaked_value_ids = reports.filter((r) => r.first_leak !== null).map((r) => r.value_id);
	return { reports, leaked_value_ids };
}

/** Render a human-readable summary of a leakage sweep report. */
export function renderLeakageSweepReport(report: LeakageSweepReport): string {
	const lines: string[] = ["# Prompt-Variable / Structured-Result Leakage Report", ""];
	for (const r of report.reports) {
		lines.push(`## ${r.value_id} (expected action: ${r.expected_action})`);
		lines.push(`classes: ${r.classes.length > 0 ? r.classes.join(", ") : "none"}`);
		for (const o of r.observations) {
			lines.push(`- [${o.verdict}] ${o.surface} '${o.location}': ${o.detail}`);
		}
		lines.push(
			r.first_leak
				? `First leak: ${r.first_leak} (also leaking: ${r.leaking_surfaces.filter((s) => s !== r.first_leak).join(", ") || "none"})`
				: "First leak: none found",
		);
		lines.push("");
	}
	lines.push(`Values with at least one leak: ${report.leaked_value_ids.length}`);
	for (const id of report.leaked_value_ids) lines.push(`- ${id}`);
	return lines.join("\n");
}
