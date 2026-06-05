/**
 * Command safety policy.
 * Validates commands against allow/deny lists before execution.
 *
 * Splits compound shell commands (&&, ||, ;, |) and validates every
 * sub-command independently. Blocks dangerous shell metacharacters
 * like backticks and $(...) subshells.
 */

import type { FailsafeConfig } from "../types/config.js";

export type CommandPolicy = {
	allow_commands: string[];
	deny_patterns: RegExp[];
	timeout_seconds: number;
};

/**
 * Constructs a CommandPolicy from a FailsafeConfig's security section.
 */
export function loadPolicy(config: FailsafeConfig): CommandPolicy {
	const security = config.security;
	return {
		allow_commands: [...security.allow_commands],
		deny_patterns: security.deny_patterns.map((p) => new RegExp(p)),
		timeout_seconds: security.timeout_seconds,
	};
}

/**
 * Returns the default command policy with common safe commands allowed
 * and dangerous patterns denied.
 */
export function getDefaultPolicy(): CommandPolicy {
	return {
		allow_commands: [
			"npm",
			"npx",
			"bun",
			"bunx",
			"node",
			"python",
			"python3",
			"pytest",
			"cargo",
			"go",
			"jest",
			"vitest",
			"tsc",
			"eslint",
			"biome",
			"make",
		],
		deny_patterns: [/rm -rf \//, /rm -rf \/\*/, /curl.*\|.*sh/, /sudo/, /> \/dev\/sd/],
		timeout_seconds: 120,
	};
}

/** Shell metacharacters that indicate injection risk */
const DANGEROUS_METACHAR_PATTERN = /`[^`]*`|\$\(|\$\{/;

/**
 * Validates a command against the given policy.
 *
 * 1. Rejects empty commands.
 * 2. Blocks dangerous shell metacharacters (backticks, $(...), ${...}).
 * 3. Checks deny patterns against the full command string.
 * 4. Splits compound commands on shell operators (&&, ||, ;, |) and
 *    validates that every sub-command's executable is in the allow list.
 */
export function validateCommand(
	command: string,
	policy: CommandPolicy,
): { allowed: boolean; reason?: string } {
	const trimmed = command.trim();

	if (trimmed.length === 0) {
		return { allowed: false, reason: "Empty command" };
	}

	// Block dangerous shell metacharacters (subshells, backticks)
	if (DANGEROUS_METACHAR_PATTERN.test(trimmed)) {
		return {
			allowed: false,
			reason: "Command contains shell metacharacters (backticks, $(), ${}) which are not allowed",
		};
	}

	// Check deny patterns against the full command string
	for (const pattern of policy.deny_patterns) {
		pattern.lastIndex = 0;
		if (pattern.test(trimmed)) {
			return {
				allowed: false,
				reason: `Command matches deny pattern: ${pattern.source}`,
			};
		}
	}

	if (policy.allow_commands.length === 0) {
		return { allowed: true };
	}

	// Split on shell operators and validate every sub-command
	const subCommands = splitShellCommands(trimmed);

	for (const sub of subCommands) {
		const cmdName = extractCommandName(sub);
		if (!policy.allow_commands.includes(cmdName)) {
			return {
				allowed: false,
				reason: `Command '${cmdName}' is not in the allow list (from: "${sub.trim()}"). Allowed: ${policy.allow_commands.join(", ")}`,
			};
		}
	}

	return { allowed: true };
}

/**
 * Split a shell command string on compound operators (&&, ||, ;, |).
 * Returns an array of individual commands to validate.
 * Respects quoted strings (single and double quotes) so operators
 * inside quotes are not treated as separators.
 */
export function splitShellCommands(command: string): string[] {
	const commands: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;

	while (i < command.length) {
		const ch = command[i];

		// Track quote state
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			i++;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			i++;
			continue;
		}

		// Only split on operators outside of quotes
		if (!inSingle && !inDouble) {
			// Check for && or ||
			if (i + 1 < command.length) {
				const two = command[i] + command[i + 1];
				if (two === "&&" || two === "||") {
					if (current.trim()) commands.push(current.trim());
					current = "";
					i += 2;
					continue;
				}
			}
			// Check for ; or |
			if (ch === ";" || ch === "|") {
				if (current.trim()) commands.push(current.trim());
				current = "";
				i++;
				continue;
			}
		}

		current += ch;
		i++;
	}

	if (current.trim()) commands.push(current.trim());
	return commands;
}

/**
 * Extracts the base command name from a single (non-compound) shell command.
 * Handles:
 *   - Leading env var assignments: FOO=bar bun test -> bun
 *   - Absolute/relative paths: /usr/bin/node -> node
 *   - Simple commands: npm test -> npm
 */
export function extractCommandName(command: string): string {
	const parts = command.split(/\s+/);

	// Skip leading environment variable assignments (VAR=value ...)
	let idx = 0;
	while (idx < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[idx])) {
		idx++;
	}

	if (idx >= parts.length) {
		return parts[0];
	}

	const executable = parts[idx];

	// Strip path prefix: /usr/local/bin/node -> node
	const basename = executable.split("/").pop() ?? executable;

	return basename;
}

/**
 * Shell features that require a real shell (cannot run via direct argv).
 * Detected outside of quoted regions.
 */
const SHELL_FEATURE_CHARS = new Set(["|", "&", ";", "<", ">", "*", "?", "`", "~"]);

export type ArgvParseResult =
	| { kind: "argv"; argv: string[] }
	| { kind: "needs_shell"; reason: string };

/**
 * Parse a simple command string into an argv array for direct, shell-free
 * execution. Returns `{ kind: "needs_shell" }` when the command uses shell
 * features (operators, redirects, globs, subshells, variable expansion) that
 * require an actual shell interpreter.
 *
 * Tokenization respects single and double quotes; quotes are stripped from
 * the resulting tokens. Backslash escapes a following character.
 */
export function parseToArgv(command: string): ArgvParseResult {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return { kind: "needs_shell", reason: "Empty command" };
	}

	const argv: string[] = [];
	let current = "";
	let hasToken = false;
	let inSingle = false;
	let inDouble = false;
	let i = 0;

	while (i < trimmed.length) {
		const ch = trimmed[i];

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				current += ch;
			}
			hasToken = true;
			i++;
			continue;
		}

		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === "\\" && i + 1 < trimmed.length) {
				// In double quotes, backslash escapes the next char
				current += trimmed[i + 1];
				i++;
			} else if (ch === "$" || ch === "`") {
				// Variable expansion / command substitution inside double quotes
				return {
					kind: "needs_shell",
					reason: `Command uses shell expansion ('${ch}') and requires --shell`,
				};
			} else {
				current += ch;
			}
			hasToken = true;
			i++;
			continue;
		}

		// Unquoted context
		if (ch === "'") {
			inSingle = true;
			hasToken = true;
			i++;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			hasToken = true;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < trimmed.length) {
			current += trimmed[i + 1];
			hasToken = true;
			i += 2;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n") {
			if (hasToken) {
				argv.push(current);
				current = "";
				hasToken = false;
			}
			i++;
			continue;
		}
		if (ch === "$") {
			return {
				kind: "needs_shell",
				reason: "Command uses variable expansion ('$') and requires --shell",
			};
		}
		if (SHELL_FEATURE_CHARS.has(ch)) {
			return {
				kind: "needs_shell",
				reason: `Command uses shell feature ('${ch}') and requires --shell`,
			};
		}

		current += ch;
		hasToken = true;
		i++;
	}

	if (inSingle || inDouble) {
		return { kind: "needs_shell", reason: "Unterminated quote in command" };
	}

	if (hasToken) argv.push(current);

	if (argv.length === 0) {
		return { kind: "needs_shell", reason: "Empty command" };
	}

	return { kind: "argv", argv };
}
