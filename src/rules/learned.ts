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

	// Top frame file (relative path, no line number)
	const topFrame =
		primary.stack_frames && primary.stack_frames.length > 0 ? primary.stack_frames[0] : undefined;

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

// Store interface for learned rule operations
export type LearnedRuleStore = {
	getLearnedRuleByHash(hash: string): LearnedRule | null;
	saveLearnedRule(rule: LearnedRule): void;
	updateLearnedRule(ruleId: string, updates: Partial<LearnedRule>): void;
};

/**
 * Record a failure occurrence for learning purposes.
 * If a rule with this hash exists, increment its occurrence_count and update metadata.
 * Otherwise, create a new learned rule with initial values.
 */
export function recordFailureForLearning(
	store: LearnedRuleStore,
	signatureHash: string,
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
): void {
	const existing = store.getLearnedRuleByHash(signatureHash);
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
