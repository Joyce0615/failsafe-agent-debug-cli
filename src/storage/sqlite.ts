import { Database } from "bun:sqlite";
import type { Hypothesis, HypothesisTree } from "../diagnosis/hypothesis.js";
import type { LearnedRule } from "../rules/types.js";
import type { FixAttempt, FixOutcome, FlakyRecord } from "../rules/types.js";
import { SCHEMA_VERSION } from "../types/common.js";
import type { DebugSession } from "../types/debug.js";
import type { FailureDiagnosis } from "../types/diagnosis.js";
import type { FailureRecord, ParsedFailure } from "../types/failure.js";
import type { FailureSignature, ReproRecord } from "../types/repro.js";
import { runMigrations } from "./migrations.js";

export class FailsafeSqlite {
	private db: Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath, { create: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA foreign_keys = ON");
		runMigrations(this.db);
	}

	// --------------- Failures ---------------

	insertFailure(record: FailureRecord): void {
		const primaryLocation = record.primary_location;
		const parserNames = record.parsed.map((p) => p.parser);
		// Determine a failure_type from the first parsed entry
		const failureType = record.parsed.length > 0 ? record.parsed[0].failure_type : null;
		// Build a summary from the first error message if available
		const summary =
			record.parsed.length > 0 && record.parsed[0].errors.length > 0
				? record.parsed[0].errors[0].message
				: null;

		this.db.run(
			`INSERT OR REPLACE INTO failures (
				failure_id, created_at, workspace, command, cwd, status, exit_code,
				failure_type, summary, primary_file, primary_line, primary_symbol,
				parser_names, env_fingerprint, token_budget, duration_ms,
				raw_stdout_path, raw_stderr_path, raw_combined_path
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				record.failure_id,
				record.created_at,
				record.workspace,
				record.command,
				record.cwd,
				record.status,
				record.exit_code,
				failureType,
				summary,
				primaryLocation?.file ?? null,
				primaryLocation?.line ?? null,
				primaryLocation?.symbol ?? null,
				JSON.stringify(parserNames),
				JSON.stringify(record.env_fingerprint),
				record.token_budget ? JSON.stringify(record.token_budget) : null,
				record.duration_ms,
				record.stdout_path,
				record.stderr_path,
				record.combined_log_path,
			],
		);
	}

	getFailure(id: string): FailureRecord | null {
		const row = this.db
			.query("SELECT * FROM failures WHERE failure_id = ?")
			.get(id) as FailureRow | null;
		if (!row) return null;
		return this.rowToFailureRecord(row);
	}

	getLastFailure(): FailureRecord | null {
		const row = this.db
			.query("SELECT * FROM failures ORDER BY created_at DESC LIMIT 1")
			.get() as FailureRow | null;
		if (!row) return null;
		return this.rowToFailureRecord(row);
	}

	listFailures(opts: {
		limit?: number;
		status?: string;
	}): FailureRecord[] {
		const conditions: string[] = [];
		const params: (string | number | null)[] = [];

		if (opts.status) {
			conditions.push("status = ?");
			params.push(opts.status);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const limit = opts.limit ?? 50;
		params.push(limit);

		const rows = this.db
			.query(`SELECT * FROM failures ${where} ORDER BY created_at DESC LIMIT ?`)
			.all(...params) as FailureRow[];

		return rows.map((row) => this.rowToFailureRecord(row));
	}

	// --------------- Diagnoses ---------------

	insertDiagnosis(diag: FailureDiagnosis): void {
		this.db.run(
			`INSERT OR REPLACE INTO diagnoses (
				diagnosis_id, failure_id, created_at, failure_type, severity, summary,
				root_cause_category, root_cause_explanation, root_cause_confidence,
				evidence, uncertainty, suggested_actions, minimal_context, token_budget,
				rule_source, rule_id, enforcement
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				diag.diagnosis_id,
				diag.failure_id,
				new Date().toISOString(),
				diag.failure_type,
				diag.severity,
				diag.summary,
				diag.root_cause?.category ?? null,
				diag.root_cause?.explanation ?? null,
				diag.root_cause?.confidence ?? null,
				JSON.stringify(diag.evidence),
				JSON.stringify(diag.uncertainty),
				JSON.stringify(diag.suggested_next_actions),
				JSON.stringify(diag.minimal_context),
				diag.token_budget ? JSON.stringify(diag.token_budget) : null,
				diag.rule_source ?? null,
				diag.rule_id ?? null,
				diag.enforcement ?? null,
			],
		);
	}

	getDiagnosisForFailure(failureId: string): FailureDiagnosis | null {
		const row = this.db
			.query("SELECT * FROM diagnoses WHERE failure_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(failureId) as DiagnosisRow | null;
		if (!row) return null;
		return this.rowToDiagnosis(row);
	}

	// --------------- Repros ---------------

	insertRepro(repro: ReproRecord): void {
		this.db.run(
			`INSERT OR REPLACE INTO repros (
				repro_id, failure_id, created_at, status, kind, command, confidence,
				original_tests, repro_tests, original_runtime_ms, repro_runtime_ms,
				signature, verified_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				repro.repro_id,
				repro.failure_id,
				repro.created_at,
				repro.status,
				repro.kind,
				repro.command,
				repro.confidence,
				repro.reduction.original_tests ?? null,
				repro.reduction.repro_tests ?? null,
				repro.reduction.original_runtime_ms ?? null,
				repro.reduction.repro_runtime_ms ?? null,
				repro.signature ? JSON.stringify(repro.signature) : null,
				repro.verified_at ?? null,
			],
		);
	}

	getReproForFailure(failureId: string): ReproRecord | null {
		const row = this.db
			.query("SELECT * FROM repros WHERE failure_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(failureId) as ReproRow | null;
		if (!row) return null;
		return this.rowToRepro(row);
	}

	// --------------- Signatures ---------------

	insertSignature(failureId: string, signature: FailureSignature): void {
		this.db.run(
			`INSERT INTO signatures (
				failure_id, exception_type, top_frame_file, top_frame_line,
				top_frame_function, test_name, assertion_key, compiler_code,
				lint_rule, files_changed
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				failureId,
				signature.exception_type ?? null,
				signature.top_frame_file ?? null,
				signature.top_frame_line ?? null,
				signature.top_frame_function ?? null,
				signature.test_name ?? null,
				signature.assertion_key ?? null,
				signature.compiler_code ?? null,
				signature.lint_rule ?? null,
				null, // files_changed populated later on resolution
			],
		);
	}

	findSimilarSignatures(
		signature: FailureSignature,
		limit = 10,
	): Array<{ failure_id: string; similarity: number }> {
		// Retrieve all unresolved signatures for comparison
		const rows = this.db
			.query(
				"SELECT DISTINCT failure_id, exception_type, top_frame_file, top_frame_function, test_name, assertion_key, compiler_code, lint_rule FROM signatures WHERE resolved = 0",
			)
			.all() as SignatureRow[];

		const scored: Array<{ failure_id: string; similarity: number }> = [];

		for (const row of rows) {
			let matches = 0;
			let totalFields = 0;

			// Compare each signature field with weighted importance
			const comparisons: Array<{
				queryVal: string | undefined;
				dbVal: string | null;
				weight: number;
			}> = [
				{
					queryVal: signature.exception_type,
					dbVal: row.exception_type,
					weight: 2,
				},
				{
					queryVal: signature.top_frame_file,
					dbVal: row.top_frame_file,
					weight: 1.5,
				},
				{
					queryVal: signature.top_frame_function,
					dbVal: row.top_frame_function,
					weight: 1.5,
				},
				{ queryVal: signature.test_name, dbVal: row.test_name, weight: 1 },
				{
					queryVal: signature.assertion_key,
					dbVal: row.assertion_key,
					weight: 1,
				},
				{
					queryVal: signature.compiler_code,
					dbVal: row.compiler_code,
					weight: 1,
				},
				{ queryVal: signature.lint_rule, dbVal: row.lint_rule, weight: 1 },
			];

			for (const { queryVal, dbVal, weight } of comparisons) {
				if (queryVal && dbVal) {
					totalFields += weight;
					if (queryVal === dbVal) {
						matches += weight;
					}
				} else if (queryVal || dbVal) {
					// One side has a value, the other doesn't - partial penalty
					totalFields += weight * 0.5;
				}
			}

			if (totalFields > 0) {
				const similarity = matches / totalFields;
				if (similarity > 0) {
					scored.push({ failure_id: row.failure_id, similarity });
				}
			}
		}

		// Sort by similarity descending and apply limit
		scored.sort((a, b) => b.similarity - a.similarity);
		return scored.slice(0, limit);
	}

	// --------------- Debug Sessions ---------------

	insertDebugSession(session: DebugSession): void {
		this.db.run(
			`INSERT OR REPLACE INTO debug_sessions (
				debug_session_id, failure_id, repro_id, created_at, runtime, adapter,
				status, launch_config, breakpoints, watch_expressions, current_location,
				terminated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				session.debug_session_id,
				session.failure_id ?? null,
				session.repro_id ?? null,
				new Date().toISOString(),
				session.runtime,
				session.adapter,
				session.status,
				JSON.stringify(session.launch_config),
				JSON.stringify(session.breakpoints),
				JSON.stringify(session.watch_expressions),
				session.last_state_snapshot ? JSON.stringify(session.last_state_snapshot) : null,
				null, // terminated_at
			],
		);
	}

	updateDebugSession(id: string, updates: Partial<DebugSession>): void {
		const setClauses: string[] = [];
		const params: (string | number | null)[] = [];

		if (updates.status !== undefined) {
			setClauses.push("status = ?");
			params.push(updates.status);
			if (updates.status === "terminated" || updates.status === "error") {
				setClauses.push("terminated_at = ?");
				params.push(new Date().toISOString());
			}
		}
		if (updates.breakpoints !== undefined) {
			setClauses.push("breakpoints = ?");
			params.push(JSON.stringify(updates.breakpoints));
		}
		if (updates.watch_expressions !== undefined) {
			setClauses.push("watch_expressions = ?");
			params.push(JSON.stringify(updates.watch_expressions));
		}
		if (updates.last_state_snapshot !== undefined) {
			setClauses.push("current_location = ?");
			params.push(JSON.stringify(updates.last_state_snapshot));
		}
		if (updates.launch_config !== undefined) {
			setClauses.push("launch_config = ?");
			params.push(JSON.stringify(updates.launch_config));
		}
		if (updates.runtime !== undefined) {
			setClauses.push("runtime = ?");
			params.push(updates.runtime);
		}
		if (updates.adapter !== undefined) {
			setClauses.push("adapter = ?");
			params.push(updates.adapter);
		}

		if (setClauses.length === 0) return;

		params.push(id);
		this.db.run(
			`UPDATE debug_sessions SET ${setClauses.join(", ")} WHERE debug_session_id = ?`,
			params,
		);
	}

	getDebugSession(id: string): DebugSession | null {
		const row = this.db
			.query("SELECT * FROM debug_sessions WHERE debug_session_id = ?")
			.get(id) as DebugSessionRow | null;
		if (!row) return null;
		return this.rowToDebugSession(row);
	}

	// --------------- Learned Rules ---------------

	insertLearnedRule(rule: LearnedRule): void {
		this.db.run(
			`INSERT OR REPLACE INTO learned_rules (
				rule_id, signature_hash, normalized_hash, error_type, error_pattern, file_pattern,
				category, explanation, fix_summary, fix_commands,
				occurrence_count, success_count, distinct_files, confidence,
				lifecycle, first_seen_at, last_seen_at, last_success_at, promoted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				rule.rule_id,
				rule.signature_hash,
				rule.normalized_hash ?? null,
				rule.error_type ?? null,
				rule.error_pattern ?? null,
				rule.file_pattern ?? null,
				rule.category,
				rule.explanation,
				rule.fix_summary ?? null,
				rule.fix_commands ? JSON.stringify(rule.fix_commands) : null,
				rule.occurrence_count,
				rule.success_count,
				rule.distinct_files,
				rule.confidence,
				rule.lifecycle,
				rule.first_seen_at,
				rule.last_seen_at,
				rule.last_success_at ?? null,
				rule.promoted_at ?? null,
			],
		);
	}

	getLearnedRuleByHash(hash: string): LearnedRule | null {
		const row = this.db
			.query("SELECT * FROM learned_rules WHERE signature_hash = ?")
			.get(hash) as LearnedRuleRow | null;
		if (!row) return null;
		return this.rowToLearnedRule(row);
	}

	/** Fuzzy-grouping lookup: the most-seen rule sharing a normalized hash. */
	getLearnedRuleByNormalizedHash(normalizedHash: string): LearnedRule | null {
		const row = this.db
			.query(
				"SELECT * FROM learned_rules WHERE normalized_hash = ? ORDER BY occurrence_count DESC LIMIT 1",
			)
			.get(normalizedHash) as LearnedRuleRow | null;
		if (!row) return null;
		return this.rowToLearnedRule(row);
	}

	getLearnedRule(ruleId: string): LearnedRule | null {
		const row = this.db
			.query("SELECT * FROM learned_rules WHERE rule_id = ?")
			.get(ruleId) as LearnedRuleRow | null;
		if (!row) return null;
		return this.rowToLearnedRule(row);
	}

	updateLearnedRule(ruleId: string, updates: Partial<LearnedRule>): void {
		const setClauses: string[] = [];
		const params: (string | number | null)[] = [];

		if (updates.error_type !== undefined) {
			setClauses.push("error_type = ?");
			params.push(updates.error_type ?? null);
		}
		if (updates.error_pattern !== undefined) {
			setClauses.push("error_pattern = ?");
			params.push(updates.error_pattern ?? null);
		}
		if (updates.file_pattern !== undefined) {
			setClauses.push("file_pattern = ?");
			params.push(updates.file_pattern ?? null);
		}
		if (updates.category !== undefined) {
			setClauses.push("category = ?");
			params.push(updates.category);
		}
		if (updates.explanation !== undefined) {
			setClauses.push("explanation = ?");
			params.push(updates.explanation);
		}
		if (updates.fix_summary !== undefined) {
			setClauses.push("fix_summary = ?");
			params.push(updates.fix_summary ?? null);
		}
		if (updates.fix_commands !== undefined) {
			setClauses.push("fix_commands = ?");
			params.push(updates.fix_commands ? JSON.stringify(updates.fix_commands) : null);
		}
		if (updates.occurrence_count !== undefined) {
			setClauses.push("occurrence_count = ?");
			params.push(updates.occurrence_count);
		}
		if (updates.success_count !== undefined) {
			setClauses.push("success_count = ?");
			params.push(updates.success_count);
		}
		if (updates.distinct_files !== undefined) {
			setClauses.push("distinct_files = ?");
			params.push(updates.distinct_files);
		}
		if (updates.confidence !== undefined) {
			setClauses.push("confidence = ?");
			params.push(updates.confidence);
		}
		if (updates.lifecycle !== undefined) {
			setClauses.push("lifecycle = ?");
			params.push(updates.lifecycle);
		}
		if (updates.last_seen_at !== undefined) {
			setClauses.push("last_seen_at = ?");
			params.push(updates.last_seen_at);
		}
		if (updates.last_success_at !== undefined) {
			setClauses.push("last_success_at = ?");
			params.push(updates.last_success_at ?? null);
		}
		if (updates.promoted_at !== undefined) {
			setClauses.push("promoted_at = ?");
			params.push(updates.promoted_at ?? null);
		}

		if (setClauses.length === 0) return;

		params.push(ruleId);
		this.db.run(`UPDATE learned_rules SET ${setClauses.join(", ")} WHERE rule_id = ?`, params);
	}

	listLearnedRules(opts?: { lifecycle?: string; minConfidence?: number }): LearnedRule[] {
		const conditions: string[] = [];
		const params: (string | number | null)[] = [];

		if (opts?.lifecycle) {
			conditions.push("lifecycle = ?");
			params.push(opts.lifecycle);
		}
		if (opts?.minConfidence !== undefined) {
			conditions.push("confidence >= ?");
			params.push(opts.minConfidence);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		const rows = this.db
			.query(`SELECT * FROM learned_rules ${where} ORDER BY last_seen_at DESC`)
			.all(...params) as LearnedRuleRow[];

		return rows.map((row) => this.rowToLearnedRule(row));
	}

	markStaleRules(beforeDate: string): number {
		const result = this.db.run(
			`UPDATE learned_rules SET lifecycle = 'stale' WHERE lifecycle = 'active' AND last_seen_at < ?`,
			[beforeDate],
		);
		return result.changes;
	}

	// --------------- Fix Outcomes ---------------

	insertFixOutcome(outcome: FixOutcome): void {
		this.db.run(
			`INSERT INTO fix_outcomes (
				failure_id, signature_hash, resolved_at, success,
				fix_summary, fix_commands, files_changed
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				outcome.failure_id,
				outcome.signature_hash,
				outcome.resolved_at,
				outcome.success ? 1 : 0,
				outcome.fix_summary ?? null,
				outcome.fix_commands ? JSON.stringify(outcome.fix_commands) : null,
				outcome.files_changed ? JSON.stringify(outcome.files_changed) : null,
			],
		);
	}

	getFixOutcomes(signatureHash: string): FixOutcome[] {
		const rows = this.db
			.query("SELECT * FROM fix_outcomes WHERE signature_hash = ? ORDER BY resolved_at DESC")
			.all(signatureHash) as FixOutcomeRow[];

		return rows.map((row) => this.rowToFixOutcome(row));
	}

	getLatestSuccessfulFix(signatureHash: string): FixOutcome | null {
		const row = this.db
			.query(
				"SELECT * FROM fix_outcomes WHERE signature_hash = ? AND success = 1 ORDER BY resolved_at DESC LIMIT 1",
			)
			.get(signatureHash) as FixOutcomeRow | null;
		if (!row) return null;
		return this.rowToFixOutcome(row);
	}

	/** List every fix outcome across all signatures (newest first). */
	listFixOutcomes(opts: { successOnly?: boolean } = {}): FixOutcome[] {
		const where = opts.successOnly ? "WHERE success = 1" : "";
		const rows = this.db
			.query(`SELECT * FROM fix_outcomes ${where} ORDER BY resolved_at DESC`)
			.all() as FixOutcomeRow[];
		return rows.map((row) => this.rowToFixOutcome(row));
	}

	// --------------- Fix Attempts (item 32) ---------------

	/**
	 * Record an attempted fix. Idempotent per
	 * (signature_hash, failure_id, summary) so re-running `verify` after the
	 * same edit does not inflate the attempt history.
	 */
	recordFixAttempt(attempt: FixAttempt): void {
		this.db.run(
			`INSERT OR IGNORE INTO fix_attempts (
				signature_hash, failure_id, attempted_at, summary, outcome, detail, files_changed
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				attempt.signature_hash,
				attempt.failure_id,
				attempt.attempted_at,
				attempt.summary,
				attempt.outcome,
				attempt.detail ?? null,
				attempt.files_changed ? JSON.stringify(attempt.files_changed) : null,
			],
		);
	}

	/** Attempts for a signature, newest first. */
	getFixAttempts(signatureHash: string, limit = 20): FixAttempt[] {
		const rows = this.db
			.query(
				"SELECT * FROM fix_attempts WHERE signature_hash = ? ORDER BY attempted_at DESC, id DESC LIMIT ?",
			)
			.all(signatureHash, limit) as FixAttemptRow[];
		return rows.map((row) => this.rowToFixAttempt(row));
	}

	/** How many distinct attempts for this signature failed to resolve it. */
	countFailedFixAttempts(signatureHash: string): number {
		const row = this.db
			.query(
				"SELECT COUNT(*) as cnt FROM fix_attempts WHERE signature_hash = ? AND outcome = 'unresolved'",
			)
			.get(signatureHash) as { cnt: number } | null;
		return row?.cnt ?? 0;
	}

	private rowToFixAttempt(row: FixAttemptRow): FixAttempt {
		return {
			signature_hash: row.signature_hash,
			failure_id: row.failure_id,
			attempted_at: row.attempted_at,
			summary: row.summary,
			outcome: row.outcome === "resolved" ? "resolved" : "unresolved",
			detail: row.detail ?? undefined,
			files_changed: row.files_changed ? safeJsonParse<string[]>(row.files_changed, []) : undefined,
		};
	}

	// --------------- Flaky Signatures ---------------

	upsertFlakySignature(record: FlakyRecord): void {
		this.db.run(
			`INSERT INTO flaky_signatures (
				signature_hash, failure_count_after_fix,
				first_recurrence_at, last_recurrence_at, marked_flaky_at,
				rerun_checked_at, rerun_total, rerun_passed, rerun_failed, rerun_confirmed
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(signature_hash) DO UPDATE SET
				failure_count_after_fix = excluded.failure_count_after_fix,
				last_recurrence_at = excluded.last_recurrence_at,
				marked_flaky_at = COALESCE(excluded.marked_flaky_at, flaky_signatures.marked_flaky_at),
				-- Rerun evidence is only overwritten by a NEW rerun, so a plain
				-- recurrence upsert can never erase a confirmed/refuted verdict.
				rerun_checked_at = COALESCE(excluded.rerun_checked_at, flaky_signatures.rerun_checked_at),
				rerun_total = COALESCE(excluded.rerun_total, flaky_signatures.rerun_total),
				rerun_passed = COALESCE(excluded.rerun_passed, flaky_signatures.rerun_passed),
				rerun_failed = COALESCE(excluded.rerun_failed, flaky_signatures.rerun_failed),
				rerun_confirmed = COALESCE(excluded.rerun_confirmed, flaky_signatures.rerun_confirmed)`,
			[
				record.signature_hash,
				record.failure_count_after_fix,
				record.first_recurrence_at,
				record.last_recurrence_at,
				record.marked_flaky_at ?? null,
				record.rerun_checked_at ?? null,
				record.rerun_total ?? null,
				record.rerun_passed ?? null,
				record.rerun_failed ?? null,
				record.rerun_confirmed == null ? null : record.rerun_confirmed ? 1 : 0,
			],
		);
	}

	getFlakySignature(hash: string): FlakyRecord | null {
		const row = this.db
			.query("SELECT * FROM flaky_signatures WHERE signature_hash = ?")
			.get(hash) as FlakyRow | null;
		if (!row) return null;
		return this.rowToFlakyRecord(row);
	}

	listFlakySignatures(): FlakyRecord[] {
		const rows = this.db
			.query("SELECT * FROM flaky_signatures ORDER BY last_recurrence_at DESC")
			.all() as FlakyRow[];

		return rows.map((row) => this.rowToFlakyRecord(row));
	}

	// --------------- Signature Hash & Resolution ---------------

	updateSignatureHash(failureId: string, hash: string): void {
		this.db.run("UPDATE signatures SET signature_hash = ? WHERE failure_id = ?", [hash, failureId]);
	}

	/** Returns true if this failure_id has already been counted toward learning. */
	hasRecordedLearning(failureId: string): boolean {
		const row = this.db
			.query("SELECT 1 FROM learning_ledger WHERE failure_id = ?")
			.get(failureId) as unknown;
		return row != null;
	}

	/** Mark a failure_id as having contributed to learning (idempotent). */
	markLearningRecorded(failureId: string, signatureHash: string): void {
		this.db.run(
			"INSERT OR IGNORE INTO learning_ledger (failure_id, signature_hash, recorded_at) VALUES (?, ?, ?)",
			[failureId, signatureHash, new Date().toISOString()],
		);
	}

	countUnresolvedAfterDate(signatureHash: string, afterDate: string): number {
		const row = this.db
			.query(
				`SELECT COUNT(*) as cnt FROM signatures s
				 JOIN failures f ON s.failure_id = f.failure_id
				 WHERE s.signature_hash = ? AND s.resolved = 0 AND f.created_at > ?`,
			)
			.get(signatureHash, afterDate) as { cnt: number } | null;
		return row?.cnt ?? 0;
	}

	markSignatureResolved(failureId: string, summary: string, filesChanged: string[]): void {
		this.db.run(
			"UPDATE signatures SET resolved = 1, resolution_summary = ?, files_changed = ? WHERE failure_id = ?",
			[summary, JSON.stringify(filesChanged), failureId],
		);
	}

	// --------------- Diagnosis cache ---------------

	/** Look up a cached diagnosis packet by its signature/rule/schema cache key. */
	getCachedDiagnosis(cacheKey: string): FailureDiagnosis | null {
		const row = this.db
			.query("SELECT packet FROM diagnosis_cache WHERE cache_key = ?")
			.get(cacheKey) as { packet: string } | null;
		if (!row) return null;
		try {
			return JSON.parse(row.packet) as FailureDiagnosis;
		} catch {
			return null;
		}
	}

	/** Store a diagnosis packet under its cache key (idempotent overwrite). */
	saveCachedDiagnosis(cacheKey: string, diagnosis: FailureDiagnosis): void {
		this.db.run(
			"INSERT OR REPLACE INTO diagnosis_cache (cache_key, packet, created_at) VALUES (?, ?, ?)",
			[cacheKey, JSON.stringify(diagnosis), new Date().toISOString()],
		);
	}

	// --------------- Hypotheses (item 43) ---------------

	/**
	 * Persist a whole hypothesis tree for a failure.
	 *
	 * Replaces the stored tree in one transaction: a tree is only meaningful as
	 * a set (posteriors are normalized across siblings), so a partial write
	 * would leave belief that does not add up.
	 */
	saveHypotheses(tree: HypothesisTree): void {
		const now = new Date().toISOString();
		this.db.transaction(() => {
			this.db.run("DELETE FROM hypotheses WHERE failure_id = ?", [tree.failure_id]);
			for (const h of tree.hypotheses) {
				this.db.run(
					`INSERT INTO hypotheses (
						hypothesis_id, failure_id, parent_id, level, statement, location,
						prior, posterior, status, intent, probe, observations,
						abandonment_reason, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						h.id,
						h.failure_id,
						h.parent_id ?? null,
						h.level,
						h.statement,
						h.location ?? null,
						h.prior,
						h.posterior,
						h.status,
						h.intent ? JSON.stringify(h.intent) : null,
						h.probe ? JSON.stringify(h.probe) : null,
						JSON.stringify(h.observations),
						h.abandonment_reason ?? null,
						now,
					],
				);
			}
		})();
	}

	/** Load the hypothesis tree for a failure, or `null` when none is stored. */
	getHypotheses(failureId: string): HypothesisTree | null {
		const rows = this.db
			.query("SELECT * FROM hypotheses WHERE failure_id = ? ORDER BY rowid ASC")
			.all(failureId) as HypothesisRow[];
		if (rows.length === 0) return null;
		return {
			schema_version: "0.1",
			failure_id: failureId,
			hypotheses: rows.map((row) => ({
				id: row.hypothesis_id,
				failure_id: row.failure_id,
				...(row.parent_id ? { parent_id: row.parent_id } : {}),
				level: row.level as Hypothesis["level"],
				statement: row.statement,
				...(row.location ? { location: row.location } : {}),
				prior: row.prior,
				posterior: row.posterior,
				status: row.status as Hypothesis["status"],
				...(row.intent ? { intent: safeJsonParse(row.intent, undefined) } : {}),
				...(row.probe ? { probe: safeJsonParse(row.probe, undefined) } : {}),
				observations: safeJsonParse(row.observations, []),
				...(row.abandonment_reason ? { abandonment_reason: row.abandonment_reason } : {}),
			})),
		};
	}

	// --------------- Lifecycle ---------------

	close(): void {
		this.db.close();
	}

	// --------------- Private row-to-type converters ---------------

	private rowToFailureRecord(row: FailureRow): FailureRecord {
		const envFingerprint = safeJsonParse(row.env_fingerprint, {
			os: "unknown",
			arch: "unknown",
			cwd: row.cwd,
		});
		const tokenBudget = row.token_budget ? safeJsonParse(row.token_budget, undefined) : undefined;
		const parserNames: string[] = safeJsonParse(row.parser_names, []);

		// Reconstruct parsed array - we store summary info in the DB row,
		// but the full parsed data lives on disk. Return a minimal parsed array
		// from what we have in the DB.
		const parsed: ParsedFailure[] = parserNames.map((parser) => ({
			parser,
			failure_type: (row.failure_type as ParsedFailure["failure_type"]) ?? "unknown",
			errors: row.summary ? [{ message: row.summary, is_application: true }] : [],
			test_summary: undefined,
		}));

		const primaryLocation =
			row.primary_file && row.primary_line
				? {
						file: row.primary_file,
						line: row.primary_line,
						symbol: row.primary_symbol ?? undefined,
					}
				: undefined;

		return {
			schema_version: SCHEMA_VERSION,
			failure_id: row.failure_id,
			created_at: row.created_at,
			workspace: row.workspace,
			command: row.command,
			cwd: row.cwd,
			env_fingerprint: envFingerprint,
			status: row.status as FailureRecord["status"],
			exit_code: row.exit_code,
			duration_ms: row.duration_ms ?? 0,
			stdout_path: row.raw_stdout_path ?? "",
			stderr_path: row.raw_stderr_path ?? "",
			combined_log_path: row.raw_combined_path ?? "",
			parsed,
			primary_location: primaryLocation,
			related_locations: [],
			raw_artifacts: [],
			token_budget: tokenBudget,
		};
	}

	private rowToDiagnosis(row: DiagnosisRow): FailureDiagnosis {
		const evidence = safeJsonParse(row.evidence, []);
		const uncertainty = safeJsonParse(row.uncertainty, []);
		const suggestedActions = safeJsonParse(row.suggested_actions, []);
		const minimalContext = safeJsonParse(row.minimal_context, []);
		const tokenBudget = row.token_budget ? safeJsonParse(row.token_budget, undefined) : undefined;

		const rootCause =
			row.root_cause_category && row.root_cause_explanation != null
				? {
						category: row.root_cause_category as FailureDiagnosis["root_cause"] extends
							| { category: infer C }
							| undefined
							? C
							: never,
						explanation: row.root_cause_explanation,
						confidence: row.root_cause_confidence ?? 0,
					}
				: undefined;

		return {
			schema_version: SCHEMA_VERSION,
			diagnosis_id: row.diagnosis_id,
			failure_id: row.failure_id,
			failure_type: (row.failure_type ?? "unknown") as FailureDiagnosis["failure_type"],
			severity: row.severity as FailureDiagnosis["severity"],
			summary: row.summary,
			root_cause: rootCause as FailureDiagnosis["root_cause"],
			evidence,
			uncertainty,
			suggested_next_actions: suggestedActions,
			minimal_context: minimalContext,
			token_budget: tokenBudget,
			rule_source: (row.rule_source ?? undefined) as FailureDiagnosis["rule_source"],
			rule_id: row.rule_id ?? undefined,
			enforcement: (row.enforcement ?? undefined) as FailureDiagnosis["enforcement"],
		};
	}

	private rowToRepro(row: ReproRow): ReproRecord {
		const signature = row.signature ? safeJsonParse(row.signature, undefined) : undefined;

		return {
			schema_version: SCHEMA_VERSION,
			repro_id: row.repro_id,
			failure_id: row.failure_id,
			created_at: row.created_at,
			status: row.status as ReproRecord["status"],
			kind: row.kind as ReproRecord["kind"],
			command: row.command,
			confidence: row.confidence ?? 0,
			reduction: {
				original_tests: row.original_tests ?? undefined,
				repro_tests: row.repro_tests ?? undefined,
				original_runtime_ms: row.original_runtime_ms ?? undefined,
				repro_runtime_ms: row.repro_runtime_ms ?? undefined,
			},
			signature,
			verified_at: row.verified_at ?? undefined,
			next: [],
		};
	}

	private rowToLearnedRule(row: LearnedRuleRow): LearnedRule {
		const fixCommands: string[] | undefined = row.fix_commands
			? safeJsonParse(row.fix_commands, [])
			: undefined;

		return {
			rule_id: row.rule_id,
			signature_hash: row.signature_hash,
			normalized_hash: row.normalized_hash ?? undefined,
			error_type: row.error_type ?? undefined,
			error_pattern: row.error_pattern ?? undefined,
			file_pattern: row.file_pattern ?? undefined,
			category: row.category,
			explanation: row.explanation,
			fix_summary: row.fix_summary ?? undefined,
			fix_commands: fixCommands,
			occurrence_count: row.occurrence_count,
			success_count: row.success_count,
			distinct_files: row.distinct_files,
			confidence: row.confidence,
			lifecycle: row.lifecycle as LearnedRule["lifecycle"],
			first_seen_at: row.first_seen_at,
			last_seen_at: row.last_seen_at,
			last_success_at: row.last_success_at ?? undefined,
			promoted_at: row.promoted_at ?? undefined,
		};
	}

	private rowToFixOutcome(row: FixOutcomeRow): FixOutcome {
		const fixCommands: string[] | undefined = row.fix_commands
			? safeJsonParse(row.fix_commands, [])
			: undefined;
		const filesChanged: string[] | undefined = row.files_changed
			? safeJsonParse(row.files_changed, [])
			: undefined;

		return {
			failure_id: row.failure_id,
			signature_hash: row.signature_hash,
			resolved_at: row.resolved_at,
			success: row.success === 1,
			fix_summary: row.fix_summary ?? undefined,
			fix_commands: fixCommands,
			files_changed: filesChanged,
		};
	}

	private rowToFlakyRecord(row: FlakyRow): FlakyRecord {
		return {
			signature_hash: row.signature_hash,
			failure_count_after_fix: row.failure_count_after_fix,
			first_recurrence_at: row.first_recurrence_at,
			last_recurrence_at: row.last_recurrence_at,
			marked_flaky_at: row.marked_flaky_at ?? undefined,
			rerun_checked_at: row.rerun_checked_at ?? undefined,
			rerun_total: row.rerun_total ?? undefined,
			rerun_passed: row.rerun_passed ?? undefined,
			rerun_failed: row.rerun_failed ?? undefined,
			// SQLite has no boolean: null means "never rerun", 0/1 the verdict.
			rerun_confirmed: row.rerun_confirmed == null ? undefined : row.rerun_confirmed === 1,
		};
	}

	private rowToDebugSession(row: DebugSessionRow): DebugSession {
		const launchConfig = row.launch_config ? safeJsonParse(row.launch_config, {}) : {};
		const breakpoints = safeJsonParse(row.breakpoints, []);
		const watchExpressions = safeJsonParse(row.watch_expressions, []);
		const lastStateSnapshot = row.current_location
			? safeJsonParse(row.current_location, undefined)
			: undefined;

		return {
			schema_version: SCHEMA_VERSION,
			debug_session_id: row.debug_session_id,
			failure_id: row.failure_id ?? undefined,
			repro_id: row.repro_id ?? undefined,
			runtime: (row.runtime ?? "unknown") as DebugSession["runtime"],
			adapter: row.adapter ?? "",
			launch_config: launchConfig,
			status: row.status as DebugSession["status"],
			breakpoints,
			watch_expressions: watchExpressions,
			last_state_snapshot: lastStateSnapshot,
		};
	}
}

// --------------- Row types (raw SQLite row shapes) ---------------

interface FailureRow {
	failure_id: string;
	created_at: string;
	workspace: string;
	command: string;
	cwd: string;
	status: string;
	exit_code: number | null;
	failure_type: string | null;
	summary: string | null;
	primary_file: string | null;
	primary_line: number | null;
	primary_symbol: string | null;
	parser_names: string | null;
	env_fingerprint: string | null;
	token_budget: string | null;
	duration_ms: number | null;
	raw_stdout_path: string | null;
	raw_stderr_path: string | null;
	raw_combined_path: string | null;
}

interface DiagnosisRow {
	diagnosis_id: string;
	failure_id: string;
	created_at: string;
	failure_type: string | null;
	severity: string;
	summary: string;
	root_cause_category: string | null;
	root_cause_explanation: string | null;
	root_cause_confidence: number | null;
	evidence: string | null;
	uncertainty: string | null;
	suggested_actions: string | null;
	minimal_context: string | null;
	token_budget: string | null;
	rule_source: string | null;
	rule_id: string | null;
	enforcement: string | null;
}

interface HypothesisRow {
	hypothesis_id: string;
	failure_id: string;
	parent_id: string | null;
	level: string;
	statement: string;
	location: string | null;
	prior: number;
	posterior: number;
	status: string;
	intent: string | null;
	probe: string | null;
	observations: string;
	abandonment_reason: string | null;
	updated_at: string;
}

interface ReproRow {
	repro_id: string;
	failure_id: string;
	created_at: string;
	status: string;
	kind: string;
	command: string;
	confidence: number | null;
	original_tests: number | null;
	repro_tests: number | null;
	original_runtime_ms: number | null;
	repro_runtime_ms: number | null;
	signature: string | null;
	verified_at: string | null;
}

interface SignatureRow {
	failure_id: string;
	exception_type: string | null;
	top_frame_file: string | null;
	top_frame_function: string | null;
	test_name: string | null;
	assertion_key: string | null;
	compiler_code: string | null;
	lint_rule: string | null;
}

interface DebugSessionRow {
	debug_session_id: string;
	failure_id: string | null;
	repro_id: string | null;
	created_at: string;
	runtime: string | null;
	adapter: string | null;
	status: string;
	launch_config: string | null;
	breakpoints: string | null;
	watch_expressions: string | null;
	current_location: string | null;
	terminated_at: string | null;
}

interface LearnedRuleRow {
	rule_id: string;
	signature_hash: string;
	normalized_hash: string | null;
	error_type: string | null;
	error_pattern: string | null;
	file_pattern: string | null;
	category: string;
	explanation: string;
	fix_summary: string | null;
	fix_commands: string | null;
	occurrence_count: number;
	success_count: number;
	distinct_files: number;
	confidence: number;
	lifecycle: string;
	first_seen_at: string;
	last_seen_at: string;
	last_success_at: string | null;
	promoted_at: string | null;
}

interface FixOutcomeRow {
	id: number;
	failure_id: string;
	signature_hash: string;
	resolved_at: string;
	success: number;
	fix_summary: string | null;
	fix_commands: string | null;
	files_changed: string | null;
}

interface FixAttemptRow {
	id: number;
	signature_hash: string;
	failure_id: string;
	attempted_at: string;
	summary: string;
	outcome: string;
	detail: string | null;
	files_changed: string | null;
}

interface FlakyRow {
	signature_hash: string;
	failure_count_after_fix: number;
	first_recurrence_at: string;
	last_recurrence_at: string;
	marked_flaky_at: string | null;
	rerun_checked_at: string | null;
	rerun_total: number | null;
	rerun_passed: number | null;
	rerun_failed: number | null;
	rerun_confirmed: number | null;
}

// --------------- Helpers ---------------

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
	if (value == null) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}
