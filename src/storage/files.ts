import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureDiagnosis } from "../types/diagnosis.js";
import type { ParsedFailure } from "../types/failure.js";
import type { ReproRecord } from "../types/repro.js";

export class FailsafeFiles {
	private runsDir: string;

	constructor(storageDir: string) {
		this.runsDir = join(storageDir, "runs");
		mkdirSync(this.runsDir, { recursive: true });
	}

	/**
	 * Ensures the run directory for a given failure ID exists and returns its path.
	 */
	ensureRunDir(failureId: string): string {
		const dir = join(this.runsDir, failureId);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	/**
	 * Writes stdout content to the run directory. Returns the file path.
	 */
	writeStdout(failureId: string, content: string): string {
		const dir = this.ensureRunDir(failureId);
		const filePath = join(dir, "stdout.log");
		Bun.write(filePath, content);
		return filePath;
	}

	/**
	 * Writes stderr content to the run directory. Returns the file path.
	 */
	writeStderr(failureId: string, content: string): string {
		const dir = this.ensureRunDir(failureId);
		const filePath = join(dir, "stderr.log");
		Bun.write(filePath, content);
		return filePath;
	}

	/**
	 * Writes combined output to the run directory. Returns the file path.
	 */
	writeCombined(failureId: string, content: string): string {
		const dir = this.ensureRunDir(failureId);
		const filePath = join(dir, "combined.log");
		Bun.write(filePath, content);
		return filePath;
	}

	/**
	 * Writes parsed failure data as JSON. Returns the file path.
	 */
	writeParsed(failureId: string, data: ParsedFailure[]): string {
		const dir = this.ensureRunDir(failureId);
		const filePath = join(dir, "parsed.json");
		Bun.write(filePath, JSON.stringify(data, null, 2));
		return filePath;
	}

	/**
	 * Writes diagnosis data as JSON. Returns the file path.
	 */
	writeDiagnosis(failureId: string, data: FailureDiagnosis): string {
		const dir = this.ensureRunDir(failureId);
		const filePath = join(dir, "diagnosis.json");
		Bun.write(filePath, JSON.stringify(data, null, 2));
		return filePath;
	}

	/**
	 * Writes repro data as JSON. Returns the file path.
	 */
	writeRepro(failureId: string, data: ReproRecord): string {
		const dir = this.ensureRunDir(failureId);
		const filePath = join(dir, "repro.json");
		Bun.write(filePath, JSON.stringify(data, null, 2));
		return filePath;
	}

	/**
	 * Reads stdout log for a given failure. Returns null if file doesn't exist.
	 */
	readStdout(failureId: string): string | null {
		return this.readFileOrNull(join(this.runsDir, failureId, "stdout.log"));
	}

	/**
	 * Reads stderr log for a given failure. Returns null if file doesn't exist.
	 */
	readStderr(failureId: string): string | null {
		return this.readFileOrNull(join(this.runsDir, failureId, "stderr.log"));
	}

	/**
	 * Reads parsed failure data for a given failure. Returns null if file doesn't exist.
	 */
	readParsed(failureId: string): ParsedFailure[] | null {
		const content = this.readFileOrNull(join(this.runsDir, failureId, "parsed.json"));
		if (content === null) return null;
		try {
			return JSON.parse(content) as ParsedFailure[];
		} catch {
			return null;
		}
	}

	/**
	 * Reads a file and returns its text content, or null if it doesn't exist.
	 */
	private readFileOrNull(filePath: string): string | null {
		try {
			if (!existsSync(filePath)) return null;
			return readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}
}
