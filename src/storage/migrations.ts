import type { Database } from "bun:sqlite";

export interface Migration {
	version: number;
	name: string;
	up: string;
}

export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "initial_schema",
		up: `
			CREATE TABLE IF NOT EXISTS _migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS failures (
				failure_id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL,
				workspace TEXT NOT NULL,
				command TEXT NOT NULL,
				cwd TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('failed', 'passed', 'timeout', 'interrupted')),
				exit_code INTEGER,
				failure_type TEXT,
				summary TEXT,
				primary_file TEXT,
				primary_line INTEGER,
				primary_symbol TEXT,
				parser_names TEXT,
				env_fingerprint TEXT,
				token_budget TEXT,
				duration_ms REAL,
				raw_stdout_path TEXT,
				raw_stderr_path TEXT,
				raw_combined_path TEXT
			);

			CREATE TABLE IF NOT EXISTS diagnoses (
				diagnosis_id TEXT PRIMARY KEY,
				failure_id TEXT NOT NULL REFERENCES failures(failure_id),
				created_at TEXT NOT NULL,
				failure_type TEXT,
				severity TEXT NOT NULL CHECK (severity IN ('blocker', 'error', 'warning', 'flaky')),
				summary TEXT NOT NULL,
				root_cause_category TEXT,
				root_cause_explanation TEXT,
				root_cause_confidence REAL,
				evidence TEXT,
				uncertainty TEXT,
				suggested_actions TEXT,
				minimal_context TEXT,
				token_budget TEXT
			);

			CREATE TABLE IF NOT EXISTS repros (
				repro_id TEXT PRIMARY KEY,
				failure_id TEXT NOT NULL REFERENCES failures(failure_id),
				created_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('created', 'verified', 'failed', 'stale')),
				kind TEXT NOT NULL,
				command TEXT NOT NULL,
				confidence REAL,
				original_tests INTEGER,
				repro_tests INTEGER,
				original_runtime_ms REAL,
				repro_runtime_ms REAL,
				signature TEXT,
				verified_at TEXT
			);

			CREATE TABLE IF NOT EXISTS signatures (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				failure_id TEXT NOT NULL REFERENCES failures(failure_id),
				exception_type TEXT,
				top_frame_file TEXT,
				top_frame_line INTEGER,
				top_frame_function TEXT,
				test_name TEXT,
				assertion_key TEXT,
				compiler_code TEXT,
				lint_rule TEXT,
				resolved INTEGER DEFAULT 0,
				resolution_summary TEXT,
				files_changed TEXT
			);

			CREATE TABLE IF NOT EXISTS debug_sessions (
				debug_session_id TEXT PRIMARY KEY,
				failure_id TEXT,
				repro_id TEXT,
				created_at TEXT NOT NULL,
				runtime TEXT,
				adapter TEXT,
				status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'paused', 'terminated', 'error')),
				launch_config TEXT,
				breakpoints TEXT,
				watch_expressions TEXT,
				current_location TEXT,
				terminated_at TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_failures_created_at ON failures(created_at);
			CREATE INDEX IF NOT EXISTS idx_failures_status ON failures(status);
			CREATE INDEX IF NOT EXISTS idx_diagnoses_failure_id ON diagnoses(failure_id);
			CREATE INDEX IF NOT EXISTS idx_repros_failure_id ON repros(failure_id);
			CREATE INDEX IF NOT EXISTS idx_signatures_failure_id ON signatures(failure_id);
			CREATE INDEX IF NOT EXISTS idx_signatures_exception_type ON signatures(exception_type);
			CREATE INDEX IF NOT EXISTS idx_debug_sessions_failure_id ON debug_sessions(failure_id);
		`,
	},
	{
		version: 2,
		name: "tiered_rules",
		up: `
			CREATE TABLE IF NOT EXISTS learned_rules (
				rule_id TEXT PRIMARY KEY,
				signature_hash TEXT NOT NULL UNIQUE,
				error_type TEXT,
				error_pattern TEXT,
				file_pattern TEXT,
				category TEXT NOT NULL,
				explanation TEXT NOT NULL,
				fix_summary TEXT,
				fix_commands TEXT,
				occurrence_count INTEGER NOT NULL DEFAULT 1,
				success_count INTEGER NOT NULL DEFAULT 0,
				distinct_files INTEGER NOT NULL DEFAULT 1,
				confidence REAL NOT NULL DEFAULT 0.0,
				lifecycle TEXT NOT NULL DEFAULT 'active'
					CHECK (lifecycle IN ('active', 'promoted', 'stale', 'disabled')),
				first_seen_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				last_success_at TEXT,
				promoted_at TEXT
			);

			CREATE TABLE IF NOT EXISTS fix_outcomes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				failure_id TEXT NOT NULL REFERENCES failures(failure_id),
				signature_hash TEXT NOT NULL,
				resolved_at TEXT NOT NULL,
				success INTEGER NOT NULL DEFAULT 0,
				fix_summary TEXT,
				fix_commands TEXT,
				files_changed TEXT
			);

			CREATE TABLE IF NOT EXISTS flaky_signatures (
				signature_hash TEXT PRIMARY KEY,
				failure_count_after_fix INTEGER NOT NULL DEFAULT 0,
				first_recurrence_at TEXT NOT NULL,
				last_recurrence_at TEXT NOT NULL,
				marked_flaky_at TEXT
			);

			ALTER TABLE diagnoses ADD COLUMN rule_source TEXT;
			ALTER TABLE diagnoses ADD COLUMN rule_id TEXT;
			ALTER TABLE diagnoses ADD COLUMN enforcement TEXT;
			ALTER TABLE signatures ADD COLUMN signature_hash TEXT;

			CREATE INDEX IF NOT EXISTS idx_learned_rules_hash ON learned_rules(signature_hash);
			CREATE INDEX IF NOT EXISTS idx_learned_rules_lifecycle ON learned_rules(lifecycle);
			CREATE INDEX IF NOT EXISTS idx_fix_outcomes_hash ON fix_outcomes(signature_hash);
			CREATE INDEX IF NOT EXISTS idx_fix_outcomes_failure ON fix_outcomes(failure_id);
			CREATE INDEX IF NOT EXISTS idx_flaky_hash ON flaky_signatures(signature_hash);
			CREATE INDEX IF NOT EXISTS idx_signatures_hash ON signatures(signature_hash);
		`,
	},
	{
		version: 3,
		name: "learning_ledger",
		up: `
			CREATE TABLE IF NOT EXISTS learning_ledger (
				failure_id TEXT PRIMARY KEY,
				signature_hash TEXT NOT NULL,
				recorded_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_learning_ledger_hash ON learning_ledger(signature_hash);
		`,
	},
	{
		version: 4,
		name: "diagnosis_cache",
		up: `
			CREATE TABLE IF NOT EXISTS diagnosis_cache (
				cache_key TEXT PRIMARY KEY,
				packet TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`,
	},
	{
		version: 5,
		name: "learned_rules_normalized_hash",
		up: `
			ALTER TABLE learned_rules ADD COLUMN normalized_hash TEXT;
			CREATE INDEX IF NOT EXISTS idx_learned_rules_normalized
				ON learned_rules(normalized_hash);
		`,
	},
	{
		version: 6,
		name: "fix_attempts",
		up: `
			CREATE TABLE IF NOT EXISTS fix_attempts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				signature_hash TEXT NOT NULL,
				failure_id TEXT NOT NULL,
				attempted_at TEXT NOT NULL,
				summary TEXT NOT NULL,
				outcome TEXT NOT NULL CHECK (outcome IN ('unresolved', 'resolved')),
				detail TEXT,
				files_changed TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_fix_attempts_signature
				ON fix_attempts(signature_hash, attempted_at DESC);

			CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_attempts_unique
				ON fix_attempts(signature_hash, failure_id, summary);
		`,
	},
];

export function runMigrations(db: Database): void {
	// Ensure the _migrations table exists for tracking
	db.run(`
		CREATE TABLE IF NOT EXISTS _migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL
		)
	`);

	const applied = new Set<number>();
	const rows = db.query("SELECT version FROM _migrations").all() as Array<{
		version: number;
	}>;
	for (const row of rows) {
		applied.add(row.version);
	}

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) {
			continue;
		}

		db.transaction(() => {
			// Execute each statement in the migration separately
			const statements = migration.up
				.split(";")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			for (const stmt of statements) {
				db.run(stmt);
			}

			db.run("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)", [
				migration.version,
				migration.name,
				new Date().toISOString(),
			]);
		})();
	}
}
