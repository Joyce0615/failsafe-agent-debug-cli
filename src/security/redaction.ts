/**
 * Secret redaction pipeline.
 * Detects and redacts API keys, tokens, passwords, and other sensitive values.
 */

interface PatternEntry {
	name: string;
	pattern: RegExp;
}

const SECRET_PATTERN_ENTRIES: PatternEntry[] = [
	{ name: "OpenAI API Key", pattern: /sk-[a-zA-Z0-9]{20,}/g },
	{ name: "Anthropic API Key", pattern: /sk-ant-[a-zA-Z0-9\-]{20,}/g },
	{ name: "GitHub Personal Access Token", pattern: /ghp_[a-zA-Z0-9]{36}/g },
	{ name: "GitHub OAuth Token", pattern: /gho_[a-zA-Z0-9]{36}/g },
	{ name: "GitHub App Token", pattern: /ghs_[a-zA-Z0-9]{36}/g },
	{ name: "AWS Access Key ID", pattern: /AKIA[0-9A-Z]{16}/g },
	{
		name: "AWS Secret Access Key",
		pattern: /(?:aws.?secret.?access.?key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[a-zA-Z0-9/+]{40}/gi,
	},
	{ name: "Bearer Token", pattern: /Bearer\s+[a-zA-Z0-9._\-]+/g },
	{ name: "Hugging Face Token", pattern: /hf_[a-zA-Z0-9]{20,}/g },
	{ name: "GitLab Personal Access Token", pattern: /glpat-[a-zA-Z0-9_-]{20,}/g },
	{ name: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
	{ name: "Slack Token", pattern: /xox[baprs]-[a-zA-Z0-9-]{10,}/g },
	{
		name: "JSON Web Token",
		pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g,
	},
	{
		name: "PEM Private Key Block",
		pattern:
			/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
	},
	{
		name: "Generic Password/Secret in Env",
		pattern: /(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)=[^\s]+/g,
	},
	{
		name: "Generic Hex/Base64 API Key",
		pattern: /(?:api[_-]?key|secret|token)\s*[=:]\s*["']?[a-zA-Z0-9]{32,}["']?/gi,
	},
];

/** Individual regex patterns extracted for external use */
export const SECRET_PATTERNS: RegExp[] = SECRET_PATTERN_ENTRIES.map((e) => e.pattern);

/** Environment variable names whose values should always be redacted */
export const SENSITIVE_ENV_KEYS: string[] = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"HF_TOKEN",
	"HUGGING_FACE_HUB_TOKEN",
	"DATABASE_URL",
	"REDIS_URL",
	"MONGO_URL",
	"MONGODB_URI",
	"POSTGRES_URL",
	"POSTGRES_PASSWORD",
	"MYSQL_PASSWORD",
	"DB_PASSWORD",
	"PRIVATE_KEY",
	"SSH_PRIVATE_KEY",
	"NPM_TOKEN",
	"PYPI_TOKEN",
	"DOCKER_PASSWORD",
	"DOCKER_AUTH_CONFIG",
	"SLACK_TOKEN",
	"SLACK_WEBHOOK_URL",
	"DISCORD_TOKEN",
	"SENDGRID_API_KEY",
	"TWILIO_AUTH_TOKEN",
	"STRIPE_SECRET_KEY",
	"JWT_SECRET",
	"SESSION_SECRET",
	"ENCRYPTION_KEY",
];

const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Redacts all secret patterns found in the given text.
 *
 * @param text - The text to scan and redact
 * @param extraPatterns - Additional regex patterns to match (each should use the global flag)
 * @returns Object containing the redacted text and list of pattern names that matched
 */
export function redactSecrets(
	text: string,
	extraPatterns?: RegExp[],
): { redacted: string; matched: string[] } {
	const matched: string[] = [];
	let result = text;

	for (const entry of SECRET_PATTERN_ENTRIES) {
		// Reset lastIndex for global regexps before testing
		entry.pattern.lastIndex = 0;
		if (entry.pattern.test(result)) {
			matched.push(entry.name);
			entry.pattern.lastIndex = 0;
			result = result.replace(entry.pattern, REDACTION_PLACEHOLDER);
		}
	}

	if (extraPatterns) {
		for (let i = 0; i < extraPatterns.length; i++) {
			const pattern = extraPatterns[i];
			pattern.lastIndex = 0;
			if (pattern.test(result)) {
				matched.push(`custom_pattern_${i}`);
				pattern.lastIndex = 0;
				result = result.replace(pattern, REDACTION_PLACEHOLDER);
			}
		}
	}

	return { redacted: result, matched };
}

/**
 * Redacts sensitive values in an environment variable record.
 *
 * @param env - The environment variables to process
 * @param sensitiveKeys - Optional override list of sensitive key names (defaults to SENSITIVE_ENV_KEYS)
 * @returns A new env object with sensitive values replaced by [REDACTED]
 */
export function redactEnvVars(
	env: Record<string, string>,
	sensitiveKeys?: string[],
): Record<string, string> {
	const keys = sensitiveKeys ?? SENSITIVE_ENV_KEYS;
	const keySet = new Set(keys.map((k) => k.toUpperCase()));

	const redacted: Record<string, string> = {};

	for (const [key, value] of Object.entries(env)) {
		if (keySet.has(key.toUpperCase())) {
			redacted[key] = REDACTION_PLACEHOLDER;
		} else {
			// Also check if the key contains common sensitive substrings
			const upperKey = key.toUpperCase();
			const isSensitive =
				upperKey.includes("SECRET") ||
				upperKey.includes("PASSWORD") ||
				upperKey.includes("PRIVATE_KEY") ||
				(upperKey.includes("TOKEN") && !upperKey.includes("TOKENIZER")) ||
				(upperKey.includes("API_KEY") && !keySet.has(upperKey));
			redacted[key] = isSensitive ? REDACTION_PLACEHOLDER : value;
		}
	}

	return redacted;
}
