import { createHash } from "node:crypto";
import type { SourceLocation } from "../types/common.js";
import type { FailsafeConfig } from "../types/config.js";
import type { ParsedError } from "../types/failure.js";
import { learnedRuleId } from "../utils/id.js";
import type { FixOutcome, LearnedRule, PromotionSuggestion } from "./types.js";

/**
 * Compute a stable signature hash for a set of errors and an optional primary location.
 * The hash captures the "shape" of the error (type, file, function, test) without
 * line numbers so that the same logical error produces the same hash even when
 * code shifts around.
 */
export function computeSignatureHash(
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
): string {
	const parts: Record<string, string> = {};

	// Use the first error for signature components
	const primary = errors[0];
	if (!primary) {
		return createHash("sha256").update("empty").digest("hex").substring(0, 16);
	}

	// error_type (lowercase)
	if (primary.error_type) {
		parts.error_type = primary.error_type.toLowerCase();
	}

	// Top frame file (relative path, no line number). Prefer the first
	// application frame (consistent with computeSignature and stable across the
	// item-25 frame collapse, which may replace a leading dependency frame with a
	// fold marker); fall back to the literal top frame only when no app frame
	// exists.
	const topFrame = primary.stack_frames?.find((f) => f.is_application) ?? primary.stack_frames?.[0];

	if (topFrame) {
		parts.top_frame_file = topFrame.file;
		if (topFrame.function) {
			parts.top_frame_function = topFrame.function;
		}
	} else if (primaryLocation) {
		parts.top_frame_file = primaryLocation.file;
		if (primaryLocation.symbol) {
			parts.top_frame_function = primaryLocation.symbol;
		}
	}

	// test_name
	if (primary.test_name) {
		parts.test_name = primary.test_name;
	}

	// compiler_code / lint_rule — encoded in error_type for TS errors (e.g. "TS2345")
	// or lint rules (e.g. "no-unused-vars", "@typescript-eslint/no-explicit-any")
	if (
		primary.error_type &&
		(primary.error_type.includes("/") ||
			primary.error_type.startsWith("@") ||
			/^TS\d+$/.test(primary.error_type))
	) {
		parts.lint_rule = primary.error_type;
	}

	// Remove undefined fields (already handled by only adding defined values)
	// Sort keys for deterministic ordering
	const sortedKeys = Object.keys(parts).sort();
	const canonical: Record<string, string> = {};
	for (const key of sortedKeys) {
		canonical[key] = parts[key];
	}

	const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
	return digest.substring(0, 16);
}

/**
 * Drain-style token normalization: replace the variable literals a log line
 * carries (UUIDs, hex, quoted strings, numbers) with stable placeholders so two
 * lines differing only in those literals map to the same template.
 */
export function normalizeToken(value: string): string {
	return value
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
		.replace(/\b0x[0-9a-f]+\b/gi, "<HEX>")
		.replace(/\b[0-9a-f]{16,}\b/gi, "<HEX>")
		.replace(/'[^']*'/g, "'<STR>'")
		.replace(/"[^"]*"/g, '"<STR>"')
		.replace(/\d+(?:\.\d+)?/g, "<NUM>");
}

/** Normalize a message into a template (token-normalized, whitespace-collapsed). */
export function normalizeMessage(message: string): string {
	return normalizeToken(message).replace(/\s+/g, " ").trim();
}

/**
 * Fuzzy (normalized) signature hash for grouping near-duplicate failures.
 *
 * Same structural components as {@link computeSignatureHash}, but the
 * file/function/test-name are token-normalized and a normalized `message`
 * template is folded in, so failures differing only by an embedded id, number,
 * quoted key, or hex token share this hash. Categorical codes (error_type,
 * lint_rule/TS code) are kept exact so genuinely different error classes never
 * collapse together. This is a *fallback* grouping key — the exact signature
 * hash remains the primary key.
 */
export function computeNormalizedSignatureHash(
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
): string {
	const primary = errors[0];
	if (!primary) {
		return createHash("sha256").update("empty").digest("hex").substring(0, 16);
	}

	const parts: Record<string, string> = {};
	if (primary.error_type) parts.error_type = primary.error_type.toLowerCase();

	const topFrame = primary.stack_frames?.find((f) => f.is_application) ?? primary.stack_frames?.[0];
	if (topFrame) {
		parts.top_frame_file = normalizeToken(topFrame.file);
		if (topFrame.function) parts.top_frame_function = normalizeToken(topFrame.function);
	} else if (primaryLocation) {
		parts.top_frame_file = normalizeToken(primaryLocation.file);
		if (primaryLocation.symbol) parts.top_frame_function = normalizeToken(primaryLocation.symbol);
	}

	if (primary.test_name) parts.test_name = normalizeToken(primary.test_name);
	if (
		primary.error_type &&
		(primary.error_type.includes("/") ||
			primary.error_type.startsWith("@") ||
			/^TS\d+$/.test(primary.error_type))
	) {
		parts.lint_rule = primary.error_type;
	}
	if (primary.message) parts.message_template = normalizeMessage(primary.message);

	const canonical: Record<string, string> = {};
	for (const key of Object.keys(parts).sort()) canonical[key] = parts[key];
	// Namespace-prefix so a normalized hash can never collide with an exact one.
	const digest = createHash("sha256")
		.update(`norm|${JSON.stringify(canonical)}`)
		.digest("hex");
	return digest.substring(0, 16);
}

// Store interface for learned rule operations
export type LearnedRuleStore = {
	getLearnedRuleByHash(hash: string): LearnedRule | null;
	/**
	 * Optional fuzzy-grouping lookup by normalized signature hash. When present,
	 * `recordFailureForLearning` coalesces literal-only variants into one rule.
	 */
	getLearnedRuleByNormalizedHash?(normalizedHash: string): LearnedRule | null;
	saveLearnedRule(rule: LearnedRule): void;
	updateLearnedRule(ruleId: string, updates: Partial<LearnedRule>): void;
	hasRecordedLearning(failureId: string): boolean;
	markLearningRecorded(failureId: string, signatureHash: string): void;
};

/**
 * Record a failure occurrence for learning purposes — idempotent per failure_id.
 *
 * Each distinct failure_id contributes at most one occurrence. Re-diagnosing
 * the same failure does not inflate occurrence_count. If a rule with this hash
 * exists, increment its occurrence_count; otherwise create a new learned rule.
 *
 * @returns true if a new occurrence was recorded, false if already counted.
 */
export function recordFailureForLearning(
	store: LearnedRuleStore,
	signatureHash: string,
	failureId: string,
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
): boolean {
	// Idempotency guard: this failure_id has already been counted.
	if (store.hasRecordedLearning(failureId)) {
		return false;
	}

	// Primary grouping is the exact signature hash; fall back to the Drain-style
	// normalized hash so failures differing only by an embedded id/number/literal
	// aggregate into one rule (raising occurrence_count / earlier promotion).
	const normalizedHash = computeNormalizedSignatureHash(errors, primaryLocation);
	const existing =
		store.getLearnedRuleByHash(signatureHash) ??
		store.getLearnedRuleByNormalizedHash?.(normalizedHash) ??
		null;
	const now = new Date().toISOString();

	if (existing) {
		// Compute distinct_files: count unique files across the error set
		const fileSet = new Set<string>();
		for (const err of errors) {
			if (err.location?.file) fileSet.add(err.location.file);
			if (err.test_file) fileSet.add(err.test_file);
		}
		// Merge with existing distinct_files (take the max since we can't track individual files)
		const newDistinctFiles = Math.max(existing.distinct_files, fileSet.size);

		store.updateLearnedRule(existing.rule_id, {
			occurrence_count: existing.occurrence_count + 1,
			last_seen_at: now,
			distinct_files: newDistinctFiles,
		});
	} else {
		// Compute initial distinct_files
		const fileSet = new Set<string>();
		for (const err of errors) {
			if (err.location?.file) fileSet.add(err.location.file);
			if (err.test_file) fileSet.add(err.test_file);
		}

		const primary = errors[0];
		const newRule: LearnedRule = {
			rule_id: learnedRuleId(),
			signature_hash: signatureHash,
			normalized_hash: normalizedHash,
			error_type: primary?.error_type,
			error_pattern: primary?.message.substring(0, 200),
			file_pattern: primaryLocation?.file ?? primary?.location?.file ?? primary?.test_file,
			category: categorizeError(primary),
			explanation: primary?.message ?? "Unknown error",
			occurrence_count: 1,
			success_count: 0,
			distinct_files: Math.max(fileSet.size, 1),
			confidence: 0,
			lifecycle: "active",
			first_seen_at: now,
			last_seen_at: now,
		};

		store.saveLearnedRule(newRule);
	}

	// Mark this failure_id as counted so re-diagnosis is idempotent.
	store.markLearningRecorded(failureId, signatureHash);
	return true;
}

/**
 * Boost confidence for a learned rule after a successful fix.
 * Confidence = success_count / occurrence_count + min(0.05 * success_count, 0.15),
 * capped at 1.0.
 */
export function boostConfidence(
	store: LearnedRuleStore,
	signatureHash: string,
	outcome: FixOutcome,
): void {
	const rule = store.getLearnedRuleByHash(signatureHash);
	if (!rule) {
		return;
	}

	const newSuccessCount = rule.success_count + 1;
	const baseConfidence = newSuccessCount / rule.occurrence_count;
	const boost = Math.min(0.05 * newSuccessCount, 0.15);
	const confidence = Math.min(baseConfidence + boost, 1.0);

	const updates: Partial<LearnedRule> = {
		success_count: newSuccessCount,
		confidence,
		last_success_at: outcome.resolved_at,
	};

	if (outcome.fix_summary) {
		updates.fix_summary = outcome.fix_summary;
	}
	if (outcome.fix_commands) {
		updates.fix_commands = outcome.fix_commands;
	}

	store.updateLearnedRule(rule.rule_id, updates);
}

/**
 * Check whether a learned rule is eligible for promotion to a declared rule.
 * Promotion requires meeting thresholds for occurrence count, success rate,
 * and distinct file count.
 */
export function checkPromotionEligibility(
	rule: LearnedRule,
	config: FailsafeConfig,
): PromotionSuggestion | null {
	// Default promotion thresholds
	const occurrenceThreshold = 3;
	const successRateThreshold = 0.7;
	const distinctFilesThreshold = 1;

	const successRate = rule.occurrence_count > 0 ? rule.success_count / rule.occurrence_count : 0;

	if (
		rule.occurrence_count < occurrenceThreshold ||
		successRate < successRateThreshold ||
		rule.distinct_files < distinctFilesThreshold
	) {
		return null;
	}

	// Generate YAML snippet for rules.yaml
	const yamlSnippet = buildPromotionYaml(rule);

	return {
		rule: rule,
		yaml_snippet: yamlSnippet,
		success_rate: successRate,
	};
}

// ---- Internal helpers ----

function categorizeError(error: ParsedError | undefined): string {
	if (!error) return "unknown";
	const msg = error.message;
	const type = error.error_type ?? "";

	if (/TypeError.*(?:undefined|null|Cannot read propert)/i.test(msg) || /NoneType/i.test(msg)) {
		return "null_reference";
	}
	if (/KeyError/i.test(msg) || /KeyError/i.test(type)) return "key_error";
	if (/AttributeError/i.test(msg) || /AttributeError/i.test(type)) return "attribute_error";
	if (/(?:ModuleNotFoundError|ImportError|Cannot find module)/i.test(msg)) return "import_error";
	if (/AssertionError/i.test(msg) || error.assertion_diff) return "assertion_mismatch";
	if (/^TS\d+$/.test(type)) return "type_error";
	if (/SyntaxError/i.test(msg) || /SyntaxError/i.test(type)) return "syntax_error";
	if (/IndexError|RangeError.*index/i.test(msg)) return "index_error";
	if (type.includes("/") || type.startsWith("@")) return "lint_violation";
	if (/timed? ?out|timeout/i.test(msg)) return "timeout";
	if (/PermissionError|EACCES|EPERM|Permission denied/i.test(msg)) return "permission_error";
	if (/ConnectionError|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg))
		return "connection_error";

	return "unknown";
}

function buildPromotionYaml(rule: LearnedRule): string {
	const lines: string[] = [];
	lines.push(`- id: "${rule.rule_id}"`);

	lines.push("  pattern:");
	if (rule.error_type) {
		lines.push(`    error_type: "${rule.error_type}"`);
	}
	if (rule.error_pattern) {
		// Escape the error pattern for use as a regex
		const escaped = rule.error_pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		lines.push(`    message_regex: "${escaped}"`);
	}
	if (rule.file_pattern) {
		const escaped = rule.file_pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		lines.push(`    file_matches: "${escaped}"`);
	}

	lines.push("  diagnosis:");
	lines.push(`    category: "${rule.category}"`);
	lines.push(`    explanation: "${rule.explanation.replace(/"/g, '\\"').substring(0, 300)}"`);
	if (rule.fix_summary) {
		lines.push(`    fix: "${rule.fix_summary.replace(/"/g, '\\"').substring(0, 300)}"`);
	}
	if (rule.fix_commands && rule.fix_commands.length > 0) {
		lines.push("    fix_commands:");
		for (const cmd of rule.fix_commands) {
			lines.push(`      - "${cmd.replace(/"/g, '\\"')}"`);
		}
	}
	lines.push(`    enforcement: "suggest"`);

	lines.push(`  confidence: ${Math.round(rule.confidence * 100) / 100}`);

	return lines.join("\n");
}
