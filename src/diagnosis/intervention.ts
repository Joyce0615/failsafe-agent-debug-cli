/**
 * Active-intervention confirmation for low-confidence diagnoses (item 31).
 *
 * DESIGN §5.4 cites the Observability Gap — output-only feedback is ambiguous —
 * and DoVer's result that *active interventions* validate hypotheses. Failsafe
 * already emits `uncertainty[]` strings, but a passive "I'm not sure" gives an
 * agent nothing to do except patch and hope, which is exactly the loop item 23
 * detects after the fact.
 *
 * When the winning root cause lands in the low confidence band, this module
 * proposes ONE cheap, specific probe that would confirm or refute it before any
 * code is changed: a debugger breakpoint with concrete watch expressions where a
 * DAP adapter exists, and a single-assertion probe otherwise.
 *
 * Pure: no fs, network, or process access.
 */
import { detectRuntime } from "../debug/launch.js";
import { confidenceBand } from "../rules/confidence.js";
import type { SourceLocation } from "../types/common.js";
import type { ConfirmingIntervention } from "../types/diagnosis.js";
import type { ParsedError } from "../types/failure.js";

/** Runtimes with a real launch-guidance adapter (`failsafe debug` works). */
const DEBUGGABLE_RUNTIMES = new Set(["python", "node"]);

/** Never propose more watch expressions than an agent will actually read. */
const MAX_WATCH = 3;

/**
 * Patterns that name the exact symbol an error is complaining about. Each
 * capture group is a candidate watch expression — far more useful than
 * watching the whole frame.
 */
const SYMBOL_PATTERNS: RegExp[] = [
	/KeyError:\s*['"]([^'"]+)['"]/,
	/NameError:\s*name\s*['"]([^'"]+)['"]/,
	/AttributeError:\s*'[^']*'\s*object has no attribute\s*['"]([^'"]+)['"]/,
	/Cannot read propert(?:y|ies) (?:of|'[^']*' of) (?:undefined|null)(?:\s*\(reading\s*['"]([^'"]+)['"]\))?/,
	/['"]([A-Za-z_$][\w$]*)['"] is not defined/,
	/([A-Za-z_$][\w$]*) is not a function/,
	/ModuleNotFoundError:\s*No module named\s*['"]([^'"]+)['"]/,
	/Cannot find module\s*['"]([^'"]+)['"]/,
	/IndexError:\s*(\w+) index out of range/,
];

/**
 * Derive concrete watch expressions from the failure text: the key, attribute,
 * name, or symbol the error names, plus the failing frame's own symbol.
 */
export function deriveWatchExpressions(
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
): string[] {
	const watch: string[] = [];
	const add = (value?: string) => {
		if (!value) return;
		const trimmed = value.trim();
		if (trimmed.length === 0 || trimmed.length > 60) return;
		if (!watch.includes(trimmed)) watch.push(trimmed);
	};

	for (const err of errors) {
		for (const pattern of SYMBOL_PATTERNS) {
			const m = pattern.exec(err.message);
			if (m?.[1]) add(m[1]);
		}
		if (err.assertion_diff) {
			// The assertion's own operands are what must be observed.
			add(err.assertion_diff.actual);
		}
	}
	add(primaryLocation?.symbol);

	return watch.slice(0, MAX_WATCH);
}

export type InterventionInput = {
	failureId: string;
	command: string;
	errors: ParsedError[];
	primaryLocation?: SourceLocation;
	/** Calibrated root-cause confidence; `undefined` means nothing matched. */
	confidence?: number;
	/** A verified minimal repro command, when one exists (cheaper to probe). */
	reproCommand?: string;
	/** True when the diagnosis was downgraded as flaky. */
	flaky?: boolean;
};

/**
 * Build the cheapest probe that would confirm or refute a shaky diagnosis, or
 * null when the diagnosis is confident enough to act on.
 *
 * Triggers when the confidence is in the low band (< 0.6, per
 * `confidenceBand`) — including the "no rule matched at all" case, which is the
 * least confident state of all — AND a primary location exists to probe at.
 */
export function buildConfirmingIntervention(
	input: InterventionInput,
): ConfirmingIntervention | null {
	const { primaryLocation } = input;
	if (!primaryLocation) return null;
	// `undefined` confidence = nothing matched = maximally unconfirmed.
	const confidence = input.confidence ?? 0;
	if (confidenceBand(confidence) !== "low") return null;

	const at = `${primaryLocation.file}:${primaryLocation.line}`;
	const watch = deriveWatchExpressions(input.errors, primaryLocation);
	const runtime = detectRuntime(input.command);
	const probeCommand = input.reproCommand ?? input.command;

	const reason = input.flaky
		? `This signature is flaky, so its ${Math.round(confidence * 100)}% confidence reflects non-determinism, not a known cause. Confirm the state at ${at} before changing code.`
		: `Root-cause confidence is ${Math.round(confidence * 100)}% (low band). Output alone cannot distinguish the competing causes; one runtime observation at ${at} settles it.`;

	if (DEBUGGABLE_RUNTIMES.has(runtime)) {
		const watchFlag = watch.length > 0 ? ` --watch ${watch.join(",")}` : "";
		return {
			kind: "debugger_breakpoint",
			reason,
			confidence,
			command: `failsafe debug ${input.failureId} --break ${at}${watchFlag}`,
			location: at,
			watch,
			expected_observation:
				watch.length > 0
					? `At ${at}, inspect ${watch.join(", ")}. If the observed value matches the hypothesis, the diagnosis is confirmed; if not, the real cause is upstream of this frame.`
					: `Stop at ${at} and inspect the local frame. Confirm the hypothesized state actually holds before patching.`,
			cost: "one debugger run of the minimal repro",
		};
	}

	// No DAP adapter for this runtime: fall back to a single-assertion probe,
	// which needs nothing but the repro command.
	const subject = watch[0] ?? primaryLocation.symbol ?? "the failing value";
	return {
		kind: "assertion_probe",
		reason,
		confidence,
		command: probeCommand,
		location: at,
		watch,
		expected_observation: `No debug adapter exists for runtime '${runtime}'. Add ONE temporary assertion/print of ${subject} immediately before ${at}, re-run \`${probeCommand}\`, and read the observed value — then remove the probe. Confirm before patching.`,
		cost: "one re-run of the minimal repro with a single added assertion",
	};
}
