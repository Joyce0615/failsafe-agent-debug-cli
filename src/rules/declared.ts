import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ParsedError } from "../types/failure.js";
import {
	type DeclaredRule,
	type MatchCriteria,
	type RuleMatchResult,
	RulesFileSchema,
} from "./types.js";

/**
 * Per-path cache of parsed declared rules, keyed by the rules file's mtime and
 * size. This lets long-lived processes (the MCP server, a future watch mode)
 * avoid re-parsing the YAML on every diagnosis while still picking up edits
 * without a restart: when the file changes on disk, its mtime or size changes
 * and the next load re-parses. See `reloadDeclaredRules` for an explicit hook.
 */
type RulesCacheEntry = { mtimeMs: number; size: number; rules: DeclaredRule[] };
const rulesCache = new Map<string, RulesCacheEntry>();

function parseRulesFile(rulesFilePath: string): DeclaredRule[] {
	const raw = readFileSync(rulesFilePath, "utf-8");
	const parsed = parseYaml(raw);
	const validated = RulesFileSchema.parse(parsed);
	return validated.rules;
}

/**
 * Load declared rules from a YAML file (typically `.failsafe/rules.yaml`).
 * Returns an empty array if the file does not exist.
 *
 * Results are cached per path and transparently hot-reloaded: if the file's
 * mtime or size has changed since the last load, the file is re-parsed so
 * edits take effect within the same process without a restart.
 */
export function loadDeclaredRules(rulesFilePath: string): DeclaredRule[] {
	if (!existsSync(rulesFilePath)) {
		rulesCache.delete(rulesFilePath);
		return [];
	}

	const stat = statSync(rulesFilePath);
	const cached = rulesCache.get(rulesFilePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.rules;
	}

	const rules = parseRulesFile(rulesFilePath);
	rulesCache.set(rulesFilePath, { mtimeMs: stat.mtimeMs, size: stat.size, rules });
	return rules;
}

/**
 * Force a re-read of the declared rules file, bypassing the mtime/size cache.
 * Backs `failsafe rules reload` and is useful when an edit must be picked up
 * immediately regardless of filesystem timestamp granularity. Returns the
 * freshly parsed rules (or an empty array if the file does not exist).
 */
export function reloadDeclaredRules(rulesFilePath: string): DeclaredRule[] {
	rulesCache.delete(rulesFilePath);
	return loadDeclaredRules(rulesFilePath);
}

/**
 * Clear the entire declared-rules cache. Primarily for tests and for callers
 * that change the rules file path at runtime.
 */
export function clearDeclaredRulesCache(): void {
	rulesCache.clear();
}

/**
 * Check whether any error in the list satisfies ALL specified criteria (AND logic).
 * Returns true if at least one error matches every criterion that is present.
 */
export function matchesCriteria(errors: ParsedError[], criteria: MatchCriteria): boolean {
	return errors.some((error) => {
		// error_type: exact match on ParsedError.error_type
		if (criteria.error_type !== undefined) {
			if (error.error_type !== criteria.error_type) {
				return false;
			}
		}

		// error_contains: string or array — error.message includes substring(s)
		if (criteria.error_contains !== undefined) {
			const needles = Array.isArray(criteria.error_contains)
				? criteria.error_contains
				: [criteria.error_contains];
			for (const needle of needles) {
				if (!error.message.includes(needle)) {
					return false;
				}
			}
		}

		// message_regex: test error.message against the regex
		if (criteria.message_regex !== undefined) {
			const re = new RegExp(criteria.message_regex);
			if (!re.test(error.message)) {
				return false;
			}
		}

		// file_matches: test against error.location?.file or error.test_file
		if (criteria.file_matches !== undefined) {
			const file = error.location?.file ?? error.test_file ?? "";
			const re = new RegExp(criteria.file_matches);
			if (!re.test(file)) {
				return false;
			}
		}

		return true;
	});
}

/**
 * Iterate declared rules and return the first match as a RuleMatchResult.
 * If a `message_regex` has named capture groups, they are substituted into
 * the explanation template using `{{groupName}}` placeholders.
 */
export function matchDeclaredRules(
	errors: ParsedError[],
	rules: DeclaredRule[],
): RuleMatchResult | null {
	for (const rule of rules) {
		if (rule.override === false) {
			// Treat `override: false` as disabled for matching purposes
			continue;
		}

		if (!matchesCriteria(errors, rule.pattern)) {
			continue;
		}

		let explanation = rule.diagnosis.explanation;

		// Named group substitution from message_regex
		if (rule.pattern.message_regex) {
			const re = new RegExp(rule.pattern.message_regex);
			for (const error of errors) {
				const m = re.exec(error.message);
				if (m?.groups) {
					for (const [name, value] of Object.entries(m.groups)) {
						if (value !== undefined) {
							explanation = explanation.replace(new RegExp(`\\{\\{${name}\\}\\}`, "g"), value);
						}
					}
					break;
				}
			}
		}

		return {
			rule_id: rule.id,
			rule_source: "declared",
			category: rule.diagnosis.category,
			summary: rule.diagnosis.explanation.substring(0, 200),
			explanation,
			confidence: rule.confidence,
			enforcement: rule.diagnosis.enforcement,
			fix: rule.diagnosis.fix,
			fix_commands: rule.diagnosis.fix_commands,
		};
	}

	return null;
}

export type ValidationError = { rule_id: string; message: string };

/**
 * Validate an array of declared rules for common issues:
 * - Duplicate rule IDs
 * - Invalid message_regex patterns
 * - Invalid file_matches patterns
 */
export function validateDeclaredRules(rules: DeclaredRule[]): ValidationError[] {
	const errors: ValidationError[] = [];
	const seenIds = new Set<string>();

	for (const rule of rules) {
		// Check duplicate IDs
		if (seenIds.has(rule.id)) {
			errors.push({
				rule_id: rule.id,
				message: `Duplicate rule ID: '${rule.id}'`,
			});
		}
		seenIds.add(rule.id);

		// Check message_regex compiles
		if (rule.pattern.message_regex !== undefined) {
			try {
				new RegExp(rule.pattern.message_regex);
			} catch (e) {
				errors.push({
					rule_id: rule.id,
					message: `Invalid message_regex: ${(e as Error).message}`,
				});
			}
		}

		// Check file_matches compiles as RegExp
		if (rule.pattern.file_matches !== undefined) {
			try {
				new RegExp(rule.pattern.file_matches);
			} catch (e) {
				errors.push({
					rule_id: rule.id,
					message: `Invalid file_matches: ${(e as Error).message}`,
				});
			}
		}
	}

	return errors;
}
