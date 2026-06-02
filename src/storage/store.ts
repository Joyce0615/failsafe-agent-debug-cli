import { mkdirSync } from "node:fs";
import type { LearnedRule } from "../rules/types.js";
import type { FixOutcome, FlakyRecord } from "../rules/types.js";
import type { FailsafeConfig } from "../types/config.js";
import { resolveConfigPaths } from "../types/config.js";
import type { DebugSession } from "../types/debug.js";
import type { FailureDiagnosis } from "../types/diagnosis.js";
import type { FailureRecord } from "../types/failure.js";
import type { FailureSignature, ReproRecord } from "../types/repro.js";
import { FailsafeFiles } from "./files.js";
import { FailsafeSqlite } from "./sqlite.js";

export class FailsafeStore {
	private sqlite: FailsafeSqlite;
	private files: FailsafeFiles;

	constructor(config: FailsafeConfig, cwd: string) {
		const paths = resolveConfigPaths(cwd, config);
		// Ensure storage directory exists before opening SQLite DB
		mkdirSync(paths.storageDir, { recursive: true });
		this.sqlite = new FailsafeSqlite(paths.historyDb);
		this.files = new FailsafeFiles(paths.storageDir);
	}

	/**
	 * Saves a complete failure run: writes raw output files to disk and
	 * inserts the failure record into the database with file paths.
	 */
	saveRun(
		record: FailureRecord,
		stdout: string,
		stderr: string,
		combined: string,
	): { stdout_path: string; stderr_path: string; combined_path: string } {
		// Write raw output files to the run directory
		const stdoutPath = this.files.writeStdout(record.failure_id, stdout);
		const stderrPath = this.files.writeStderr(record.failure_id, stderr);
		const combinedPath = this.files.writeCombined(record.failure_id, combined);

		// Write parsed data to disk for full fidelity retrieval
		if (record.parsed.length > 0) {
			this.files.writeParsed(record.failure_id, record.parsed);
		}

		// Update the record with actual file paths before inserting into DB
		const recordWithPaths: FailureRecord = {
			...record,
			stdout_path: stdoutPath,
			stderr_path: stderrPath,
			combined_log_path: combinedPath,
		};

		this.sqlite.insertFailure(recordWithPaths);

		return { stdout_path: stdoutPath, stderr_path: stderrPath, combined_path: combinedPath };
	}

	/**
	 * Retrieves a failure record by ID or by the keyword "last" for the
	 * most recent failure.
	 */
	getFailure(idOrLast: string): FailureRecord | null {
		const record =
			idOrLast === "last" ? this.sqlite.getLastFailure() : this.sqlite.getFailure(idOrLast);
		if (!record) return null;

		// Enrich with full parsed data from disk (DB only stores summary)
		const fullParsed = this.files.readParsed(record.failure_id);
		if (fullParsed && fullParsed.length > 0) {
			record.parsed = fullParsed;
		}

		return record;
	}

	/**
	 * Saves a diagnosis: writes JSON to disk and inserts into the database.
	 */
	saveDiagnosis(diag: FailureDiagnosis): void {
		this.files.writeDiagnosis(diag.failure_id, diag);
		this.sqlite.insertDiagnosis(diag);
	}

	/**
	 * Retrieves the most recent diagnosis for a given failure ID.
	 */
	getDiagnosis(failureId: string): FailureDiagnosis | null {
		return this.sqlite.getDiagnosisForFailure(failureId);
	}

	/**
	 * Saves a repro record: writes JSON to disk and inserts into the database.
	 */
	saveRepro(repro: ReproRecord): void {
		this.files.writeRepro(repro.failure_id, repro);
		this.sqlite.insertRepro(repro);
	}

	/**
	 * Retrieves the most recent repro for a given failure ID.
	 */
	getRepro(failureId: string): ReproRecord | null {
		return this.sqlite.getReproForFailure(failureId);
	}

	/**
	 * Saves a failure signature for deduplication and similarity matching.
	 */
	saveSignature(failureId: string, signature: FailureSignature): void {
		this.sqlite.insertSignature(failureId, signature);
	}

	/**
	 * Finds failures with similar signatures, returning failure IDs
	 * and their similarity scores (0-1).
	 */
	findSimilarFailures(
		signature: FailureSignature,
	): Array<{ failure_id: string; similarity: number }> {
		return this.sqlite.findSimilarSignatures(signature);
	}

	/**
	 * Saves a debug session record to the database.
	 */
	saveDebugSession(session: DebugSession): void {
		this.sqlite.insertDebugSession(session);
	}

	/**
	 * Partially updates an existing debug session.
	 */
	updateDebugSession(id: string, updates: Partial<DebugSession>): void {
		this.sqlite.updateDebugSession(id, updates);
	}

	/**
	 * Retrieves a debug session by its ID.
	 */
	getDebugSession(id: string): DebugSession | null {
		return this.sqlite.getDebugSession(id);
	}

	/**
	 * Reads raw stdout or stderr output for a failure from disk.
	 */
	getRawOutput(failureId: string, kind: "stdout" | "stderr"): string | null {
		if (kind === "stdout") {
			return this.files.readStdout(failureId);
		}
		return this.files.readStderr(failureId);
	}

	/**
	 * Lists failure records with optional filtering and pagination.
	 */
	listFailures(opts?: {
		limit?: number;
		status?: string;
	}): FailureRecord[] {
		return this.sqlite.listFailures(opts ?? {});
	}

	// --------------- Learned Rules ---------------

	/**
	 * Inserts a learned rule into the database.
	 */
	insertLearnedRule(rule: LearnedRule): void {
		this.sqlite.insertLearnedRule(rule);
	}

	/**
	 * Alias for insertLearnedRule to satisfy the LearnedRuleStore interface.
	 */
	saveLearnedRule(rule: LearnedRule): void {
		this.sqlite.insertLearnedRule(rule);
	}

	/**
	 * Retrieves a learned rule by its signature hash.
	 */
	getLearnedRuleByHash(hash: string): LearnedRule | null {
		return this.sqlite.getLearnedRuleByHash(hash);
	}

	/**
	 * Retrieves a learned rule by its rule ID.
	 */
	getLearnedRule(ruleId: string): LearnedRule | null {
		return this.sqlite.getLearnedRule(ruleId);
	}

	/**
	 * Partially updates an existing learned rule.
	 */
	updateLearnedRule(ruleId: string, updates: Partial<LearnedRule>): void {
		this.sqlite.updateLearnedRule(ruleId, updates);
	}

	/**
	 * Lists learned rules with optional filtering by lifecycle and minimum confidence.
	 */
	listLearnedRules(opts?: { lifecycle?: string; minConfidence?: number }): LearnedRule[] {
		return this.sqlite.listLearnedRules(opts);
	}

	/**
	 * Marks rules as stale if their last_seen_at is before the given date.
	 * Returns the number of rules updated.
	 */
	markStaleRules(beforeDate: string): number {
		return this.sqlite.markStaleRules(beforeDate);
	}

	// --------------- Fix Outcomes ---------------

	/**
	 * Records a fix outcome for a failure.
	 */
	insertFixOutcome(outcome: FixOutcome): void {
		this.sqlite.insertFixOutcome(outcome);
	}

	/**
	 * Retrieves all fix outcomes for a given signature hash.
	 */
	getFixOutcomes(signatureHash: string): FixOutcome[] {
		return this.sqlite.getFixOutcomes(signatureHash);
	}

	/**
	 * Retrieves the most recent successful fix outcome for a signature hash.
	 */
	getLatestSuccessfulFix(signatureHash: string): FixOutcome | null {
		return this.sqlite.getLatestSuccessfulFix(signatureHash);
	}

	// --------------- Flaky Signatures ---------------

	/**
	 * Upserts a flaky signature record (insert or update on conflict).
	 */
	upsertFlakySignature(record: FlakyRecord): void {
		this.sqlite.upsertFlakySignature(record);
	}

	/**
	 * Retrieves a flaky signature record by its hash.
	 */
	getFlakySignature(hash: string): FlakyRecord | null {
		return this.sqlite.getFlakySignature(hash);
	}

	/**
	 * Lists all flaky signature records.
	 */
	listFlakySignatures(): FlakyRecord[] {
		return this.sqlite.listFlakySignatures();
	}

	// --------------- Signature Hash & Resolution ---------------

	/**
	 * Updates the signature_hash column for a given failure's signatures.
	 */
	updateSignatureHash(failureId: string, hash: string): void {
		this.sqlite.updateSignatureHash(failureId, hash);
	}

	/**
	 * Returns true if this failure_id has already contributed to learning.
	 */
	hasRecordedLearning(failureId: string): boolean {
		return this.sqlite.hasRecordedLearning(failureId);
	}

	/**
	 * Marks a failure_id as having contributed to learning (idempotent).
	 */
	markLearningRecorded(failureId: string, signatureHash: string): void {
		this.sqlite.markLearningRecorded(failureId, signatureHash);
	}

	/**
	 * Counts unresolved signatures with a given hash created after a date.
	 */
	countUnresolvedAfterDate(signatureHash: string, afterDate: string): number {
		return this.sqlite.countUnresolvedAfterDate(signatureHash, afterDate);
	}

	/**
	 * Marks all signatures for a failure as resolved with a summary and files changed.
	 */
	markSignatureResolved(failureId: string, summary: string, filesChanged: string[]): void {
		this.sqlite.markSignatureResolved(failureId, summary, filesChanged);
	}

	/**
	 * Closes the underlying database connection.
	 */
	close(): void {
		this.sqlite.close();
	}
}
