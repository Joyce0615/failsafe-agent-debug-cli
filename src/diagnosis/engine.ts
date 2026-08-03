import { loadDeclaredRules } from "../rules/declared.js";
import { evaluateRules } from "../rules/engine.js";
import { checkFlaky } from "../rules/flaky.js";
import { computeSignatureHash, recordFailureForLearning } from "../rules/learned.js";
import type { DeclaredRule, LearnedRule } from "../rules/types.js";
import type { SourceLocation } from "../types/common.js";
import { SCHEMA_VERSION } from "../types/common.js";
import { DEFAULT_CONFIG, resolveConfigPaths } from "../types/config.js";
import type { FailsafeConfig } from "../types/config.js";
import type {
	ContextSlice,
	DiagnosisCategory,
	EvidenceItem,
	FailureDiagnosis,
	Severity,
} from "../types/diagnosis.js";
import type { FailureRecord, ParsedError } from "../types/failure.js";
import type { FailureSignature } from "../types/repro.js";
import { diagnosisId } from "../utils/id.js";
import { computeTokenBudget } from "../utils/tokens.js";
import { diagnosisCacheKey } from "./cache.js";
import { extractRecentDiff, extractSourceSlice, extractTestSlice } from "./context.js";
import { TEMPLATES } from "./templates.js";

/**
 * Confidence ceiling applied to a flaky signature's root cause. A recurring-
 * after-fix failure is non-deterministic, so even a strong template/rule match
 * is capped into the "low" band (< 0.6, see src/rules/confidence.ts) to stop an
 * agent from acting on it with false certainty.
 */
const FLAKY_CONFIDENCE_CEILING = 0.3;

/**
 * Confidence for a root cause recovered by Drain-style template mining
 * (item 27) rather than by a parser or a rule. Structure was inferred from
 * unstructured text, so this deliberately sits in the low band (< 0.6) — the
 * agent should confirm before acting on it.
 */
const TEMPLATE_MINING_CONFIDENCE = 0.25;

type StoreInterface = {
	findSimilarFailures(
		signature: FailureSignature,
	): Array<{ failure_id: string; similarity: number }>;
	getRawOutput(failureId: string, kind: "stdout" | "stderr"): string | null;
	getLearnedRuleByHash(hash: string): LearnedRule | null;
	saveLearnedRule(rule: LearnedRule): void;
	updateLearnedRule(ruleId: string, updates: Partial<LearnedRule>): void;
	hasRecordedLearning(failureId: string): boolean;
	markLearningRecorded(failureId: string, signatureHash: string): void;
	getLatestSuccessfulFix(signatureHash: string): { resolved_at: string } | null;
	countUnresolvedAfterDate(signatureHash: string, afterDate: string): number;
	getFlakySignature(hash: string): import("../rules/types.js").FlakyRecord | null;
	upsertFlakySignature(record: import("../rules/types.js").FlakyRecord): void;
	listFlakySignatures(): import("../rules/types.js").FlakyRecord[];
	// Optional diagnosis cache keyed by signature hash + rule/schema fingerprint.
	// When present, an identical signature can be served without re-running the
	// expensive context-extraction, git-diff, and rule-evaluation steps.
	getCachedDiagnosis?(cacheKey: string): FailureDiagnosis | null;
	saveCachedDiagnosis?(cacheKey: string, diagnosis: FailureDiagnosis): void;
};

export async function diagnose(
	failure: FailureRecord,
	store: StoreInterface,
	config?: FailsafeConfig,
): Promise<FailureDiagnosis> {
	// Step 1: Collect all parsed errors
	const allErrors: ParsedError[] = failure.parsed.flatMap((p) => p.errors);
	const failureType = failure.parsed[0]?.failure_type ?? "unknown";

	// Step 2: Primary location is already on the record
	const primaryLocation = failure.primary_location;

	// Compute the signature up front so an identical, non-flaky signature can
	// short-circuit the expensive context/git-diff/rule steps.
	const signatureHash = computeSignatureHash(allErrors, primaryLocation);
	const rulesFilePath = `${failure.cwd}/${config?.rules?.rules_file ?? ".failsafe/rules.yaml"}`;
	const declaredRules = loadDeclaredRules(rulesFilePath);

	// Record for learning first (idempotent via the learning ledger) so a cache
	// hit below does not stop occurrence counts from growing.
	if (config?.rules?.auto_learn !== false) {
		recordFailureForLearning(store, signatureHash, failure.failure_id, allErrors, primaryLocation);
	}

	// Build the cache key AFTER learning is recorded so it reflects the learned
	// state `evaluateRules` will use. Folding the learned-rule fingerprint means a
	// promotion/boost for this signature invalidates a stale cached packet rather
	// than masking the now-stronger learned diagnosis.
	const learnedRule = store.getLearnedRuleByHash(signatureHash);
	const cacheKey = diagnosisCacheKey(signatureHash, declaredRules, learnedRule);

	// A signature that recurs after a prior fix is non-deterministic; such
	// failures are never served from (or written to) the cache so their packet
	// always reflects current flaky state.
	const isFlaky = checkFlaky(store, signatureHash, config?.rules?.flaky_recurrence_threshold ?? 3);

	// Loop detection (DESIGN §11.3): count unresolved recurrences of this
	// signature and, past a threshold, steer the agent away from another blind
	// patch toward runtime confirmation. Computed outside the cache (recurrence
	// grows over time) and overlaid on both the cached and fresh packets.
	const loopThreshold = config?.rules?.loop_warning_threshold ?? 3;
	const recurrenceCount = store.countUnresolvedAfterDate(signatureHash, "1970-01-01T00:00:00.000Z");
	const loopWarning: FailureDiagnosis["loop_warning"] =
		recurrenceCount >= loopThreshold
			? {
					detected: true,
					occurrences: recurrenceCount,
					reason: `This failure signature has recurred unresolved ${recurrenceCount} times; repeated patches are not converging.`,
					recommendation: `Stop patching blind — confirm the root cause at runtime: run 'failsafe debug ${failure.failure_id} --break primary', then step/inspect the failing state before the next fix.`,
				}
			: undefined;

	if (!isFlaky) {
		const cached = store.getCachedDiagnosis?.(cacheKey);
		if (cached) {
			// Re-stamp the cached packet for this specific failure; everything else
			// is signature-determined and therefore identical. Overlay the current
			// loop_warning so a stale cache entry never hides a fresh loop signal.
			// Cached packets are stored loop_warning-free, so only add it here.
			const packet: FailureDiagnosis = { ...cached, failure_id: failure.failure_id };
			if (loopWarning) packet.loop_warning = loopWarning;
			return packet;
		}
	}

	// Step 3: Extract source context at primary location
	const contextSlices: ContextSlice[] = [];
	if (primaryLocation) {
		const slice = await extractSourceSlice(primaryLocation);
		if (slice) contextSlices.push(slice);
	}

	// Step 4: Extract test context if applicable
	for (const err of allErrors) {
		if (err.test_file && err.test_name) {
			const testSlice = await extractTestSlice(err.test_file, err.test_name);
			if (
				testSlice &&
				!contextSlices.some(
					(s) => s.file === testSlice.file && s.start_line === testSlice.start_line,
				)
			) {
				contextSlices.push(testSlice);
			}
		}
	}

	// Step 5: Get recent git diff for affected files
	const evidence: EvidenceItem[] = [];
	const diffFiles = new Set<string>();
	if (primaryLocation) diffFiles.add(primaryLocation.file);
	for (const err of allErrors) {
		if (err.location) diffFiles.add(err.location.file);
		if (err.test_file) diffFiles.add(err.test_file);
	}
	for (const file of diffFiles) {
		const diff = await extractRecentDiff(file);
		if (diff) {
			evidence.push({
				kind: "git_diff",
				location: file,
				value: diff.substring(0, 500),
			});
		}
	}

	// Step 6: Check failure history for similar signatures
	const signature = computeSimpleSignature(allErrors, primaryLocation);
	const similar = store.findSimilarFailures(signature);
	if (similar.length > 0) {
		evidence.push({
			kind: "history_match",
			value: `${similar.length} similar failure(s) found: ${similar.map((s) => s.failure_id).join(", ")}`,
		});
	}

	// Step 7: Evaluate rules in tiered order
	const ruleMatch = evaluateRules(allErrors, contextSlices, signatureHash, store, declaredRules);

	let summary = allErrors[0]?.message ?? "Unknown failure";
	let rootCause: FailureDiagnosis["root_cause"];
	let uncertainty: string[] = ["No specific diagnosis template matched"];
	const templateEvidence: EvidenceItem[] = [];

	let ruleSource: string | undefined;
	let ruleId: string | undefined;
	let enforcement: string | undefined;

	if (ruleMatch) {
		summary = ruleMatch.summary || ruleMatch.explanation;
		rootCause = {
			category: ruleMatch.category as DiagnosisCategory,
			explanation: ruleMatch.explanation,
			confidence: ruleMatch.confidence,
		};
		if (ruleMatch.uncertainty) uncertainty = ruleMatch.uncertainty as string[];
		if (ruleMatch.evidence) templateEvidence.push(...(ruleMatch.evidence as EvidenceItem[]));
		ruleSource = ruleMatch.rule_source;
		ruleId = ruleMatch.rule_id;
		enforcement = ruleMatch.enforcement;

		// Surface precedence conflicts: if lower tiers also matched, note that
		// the winning tier shadowed them so the choice is auditable.
		if (ruleMatch.shadowed_matches && ruleMatch.shadowed_matches.length > 0) {
			const shadowedDesc = ruleMatch.shadowed_matches
				.map((s) => `${s.rule_source}:${s.category}`)
				.join(", ");
			uncertainty = [
				...uncertainty,
				`Winning tier '${ruleMatch.rule_source}' (${ruleMatch.rule_id}) shadowed lower-tier match(es): ${shadowedDesc}.`,
			];
		}
	}

	// Step 7b: Drain-style fallback (item 27). When no registered parser matched,
	// `detectAndParse` mined a log template from the raw output. If no rule tier
	// produced a diagnosis either, promote that template to a templated summary
	// plus a deliberately low-confidence root cause, and always record the
	// template + its concrete line as evidence so the agent can see both the
	// generalized shape and the exact text.
	const mined = allErrors.find((e) => e.log_template);
	if (mined?.log_template) {
		const { template, occurrences, scanned_lines } = mined.log_template;
		templateEvidence.push({
			kind: "log_template",
			location: mined.location ? `${mined.location.file}:${mined.location.line}` : undefined,
			value: `${template} (mined from ${occurrences}/${scanned_lines} unrecognized output line(s))`,
		});
		templateEvidence.push({ kind: "error_message", value: mined.message });
		if (!ruleMatch) {
			summary = template;
			rootCause = {
				category: "unknown",
				explanation: `No parser recognized this tool's output. The most failure-like log template ("${template}") matched ${occurrences} of ${scanned_lines} scanned line(s); a representative line is: ${mined.message}`,
				confidence: TEMPLATE_MINING_CONFIDENCE,
			};
			uncertainty = [
				"Diagnosis came from log-template mining, not a language/tool parser — treat the location and cause as candidates, not facts.",
				...uncertainty.filter((u) => u !== "No specific diagnosis template matched"),
			];
		}
	}

	// Step 8: Build suggested next actions
	const nextActions = buildNextActions(
		failure.failure_id,
		failureType,
		primaryLocation,
		failure.command,
	);

	// Determine severity
	let severity = determineSeverity(failureType, allErrors);

	// Compute token budget
	const rawStdout = store.getRawOutput(failure.failure_id, "stdout") ?? "";
	const rawStderr = store.getRawOutput(failure.failure_id, "stderr") ?? "";
	const rawBytes = Buffer.byteLength(rawStdout) + Buffer.byteLength(rawStderr);

	// Flaky downgrade (isFlaky computed up front). A signature that recurs after
	// a prior fix is unreliable, so beyond flagging severity we (1) cap any
	// root-cause confidence into the low band and (2) prepend an uncertainty note
	// steering the agent to re-run before trusting or "fixing" it.
	if (isFlaky) {
		severity = "flaky";
		if (rootCause) {
			rootCause = {
				...rootCause,
				confidence: Math.min(rootCause.confidence, FLAKY_CONFIDENCE_CEILING),
			};
		}
		uncertainty = [
			"This signature recurred after a previous fix (flaky). Re-run the command a few times to confirm it reproduces deterministically before trusting this diagnosis or applying a fix.",
			...uncertainty.filter((u) => u !== "No specific diagnosis template matched"),
		];
	}

	const diagnosis: FailureDiagnosis = {
		schema_version: SCHEMA_VERSION,
		diagnosis_id: diagnosisId(),
		failure_id: failure.failure_id,
		failure_type: failureType as FailureDiagnosis["failure_type"],
		severity,
		summary,
		root_cause: rootCause,
		evidence: [...templateEvidence, ...evidence],
		uncertainty,
		minimal_context: contextSlices,
		suggested_next_actions: nextActions,
		rule_source: ruleSource as FailureDiagnosis["rule_source"],
		rule_id: ruleId,
		enforcement: enforcement as FailureDiagnosis["enforcement"],
	};

	const diagBytes = Buffer.byteLength(JSON.stringify(diagnosis));
	diagnosis.token_budget = computeTokenBudget(rawBytes, diagBytes);

	// Cache the freshly computed packet (loop_warning-free — recurrence is
	// time-varying) for identical, non-flaky signatures, then overlay the
	// current loop_warning on the returned packet.
	if (!isFlaky) {
		store.saveCachedDiagnosis?.(cacheKey, diagnosis);
	}
	if (loopWarning) diagnosis.loop_warning = loopWarning;

	return diagnosis;
}

function computeSimpleSignature(
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
): FailureSignature {
	const first = errors[0];
	if (!first) return {};

	const topAppFrame = first.stack_frames?.find((f) => f.is_application);
	return {
		exception_type: first.error_type,
		top_frame_file: topAppFrame?.file ?? primaryLocation?.file,
		top_frame_line: topAppFrame?.line ?? primaryLocation?.line,
		top_frame_function: topAppFrame?.function ?? primaryLocation?.symbol,
		test_name: first.test_name,
		file: primaryLocation?.file,
		line: primaryLocation?.line,
	};
}

function determineSeverity(failureType: string, errors: ParsedError[]): Severity {
	if (failureType === "build_error" || failureType === "type_error") return "blocker";
	if (failureType === "lint_error") return "warning";
	if (errors.some((e) => /SyntaxError/i.test(e.error_type ?? ""))) return "blocker";
	return "error";
}

function buildNextActions(
	failureId: string,
	failureType: string,
	primaryLocation?: SourceLocation,
	command?: string,
): Array<{ command: string; reason: string }> {
	const actions: Array<{ command: string; reason: string }> = [];

	if (failureType === "test_failure") {
		actions.push({
			command: `failsafe repro ${failureId}`,
			reason: "Create a minimal reproduction with just the failing test",
		});
	}

	// Only suggest debug when the runtime is Python (only supported DAP adapter)
	// and the failure has a primary location to break at.
	if (primaryLocation && command && /python3?|pytest|python\s+-m/.test(command)) {
		actions.push({
			command: `failsafe debug ${failureId} --break primary`,
			reason: "Inspect runtime state at the failure location (experimental, requires debugpy)",
		});
	}

	actions.push({
		command: `failsafe history --similar ${failureId}`,
		reason: "Check if this failure has been seen and resolved before",
	});

	return actions;
}
