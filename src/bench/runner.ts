/**
 * Resumable benchmark-matrix runner + aggregate metrics (item 39).
 *
 * Results are appended to a JSONL store, one line per completed instance, so an
 * interrupted run resumes by skipping what is already recorded rather than
 * re-executing (and duplicating) it. `onlyFailed` re-runs just the unresolved /
 * errored instances, replacing their prior record.
 *
 * The executor is injected, so this module performs no process/network I/O of
 * its own — only reading and appending the result file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { BenchBudget, BenchInstance, BenchmarkManifest } from "./manifest.js";

export const BenchResultSchema = z.object({
	instance_id: z.string(),
	benchmark: z.string(),
	dataset_version: z.string(),
	status: z.enum(["resolved", "unresolved", "error", "skipped_over_budget"]),
	steps: z.number().int().nonnegative().default(0),
	tokens: z.number().int().nonnegative().default(0),
	duration_ms: z.number().nonnegative().default(0),
	completed_at: z.string(),
	notes: z.string().optional(),
});
export type BenchResult = z.infer<typeof BenchResultSchema>;

export type ExecuteOutcome = {
	status: BenchResult["status"];
	steps?: number;
	tokens?: number;
	duration_ms?: number;
	notes?: string;
};

export type ExecuteFn = (
	instance: BenchInstance,
	budget: BenchBudget,
) => Promise<ExecuteOutcome> | ExecuteOutcome;

/** Read previously recorded results, ignoring malformed/partial lines. */
export function loadResults(path: string): BenchResult[] {
	if (!existsSync(path)) return [];
	const results: BenchResult[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			results.push(BenchResultSchema.parse(JSON.parse(trimmed)));
		} catch {
			// A crash mid-write can leave a truncated final line; drop it.
		}
	}
	return results;
}

/** Latest record per instance (later lines supersede earlier ones). */
export function latestResults(results: BenchResult[]): Map<string, BenchResult> {
	const latest = new Map<string, BenchResult>();
	for (const result of results) latest.set(result.instance_id, result);
	return latest;
}

function appendResult(path: string, result: BenchResult): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(result)}\n`);
}

export type MatrixMetrics = {
	total: number;
	resolved: number;
	unresolved: number;
	errored: number;
	resolution_rate: number;
	avg_steps: number;
	avg_tokens: number;
	total_tokens: number;
	total_ms: number;
};

/** Aggregate resolution/cost/step metrics over a result set. */
export function aggregate(results: BenchResult[]): MatrixMetrics {
	const total = results.length;
	const resolved = results.filter((r) => r.status === "resolved").length;
	const unresolved = results.filter((r) => r.status === "unresolved").length;
	const errored = results.filter((r) => r.status === "error").length;
	const sum = (pick: (r: BenchResult) => number) => results.reduce((acc, r) => acc + pick(r), 0);
	const round = (value: number) => Math.round(value * 100) / 100;
	return {
		total,
		resolved,
		unresolved,
		errored,
		resolution_rate: total === 0 ? 0 : round(resolved / total),
		avg_steps: total === 0 ? 0 : round(sum((r) => r.steps) / total),
		avg_tokens: total === 0 ? 0 : round(sum((r) => r.tokens) / total),
		total_tokens: sum((r) => r.tokens),
		total_ms: sum((r) => r.duration_ms),
	};
}

/**
 * Compare two result sets (e.g. two backends) held to the same budget.
 * Returns per-set metrics plus the instances they disagree on.
 */
export function compareRuns(
	a: { label: string; results: BenchResult[] },
	b: { label: string; results: BenchResult[] },
): {
	[label: string]: unknown;
	disagreements: Array<{ instance_id: string; [label: string]: string }>;
} {
	const aLatest = latestResults(a.results);
	const bLatest = latestResults(b.results);
	const disagreements: Array<{ instance_id: string; [label: string]: string }> = [];
	for (const [id, aResult] of aLatest) {
		const bResult = bLatest.get(id);
		if (bResult && bResult.status !== aResult.status) {
			disagreements.push({
				instance_id: id,
				[a.label]: aResult.status,
				[b.label]: bResult.status,
			});
		}
	}
	return {
		[a.label]: aggregate([...aLatest.values()]),
		[b.label]: aggregate([...bLatest.values()]),
		disagreements,
	};
}

export type RunMatrixOptions = {
	manifest: BenchmarkManifest;
	/** JSONL result store; also the resume source. */
	resultsPath: string;
	execute: ExecuteFn;
	/** Skip instances already recorded (default true). */
	resume?: boolean;
	/** Re-run ONLY instances whose latest record is unresolved/error. */
	onlyFailed?: boolean;
	/** Cap on how many instances to execute in this invocation. */
	limit?: number;
};

export type RunMatrixReport = {
	benchmark: string;
	dataset_version: string;
	budget: BenchBudget;
	executed: string[];
	skipped: string[];
	metrics: MatrixMetrics;
};

/**
 * Execute a manifest, appending each completed instance to the result store.
 *
 * Contract: an instance whose latest record exists is NOT re-executed under
 * `resume` (the default), so an interrupted run continues exactly where it
 * stopped and never duplicates completed work. Under `onlyFailed`, resolved
 * instances are skipped and failed ones are re-executed, superseding their
 * previous line.
 */
export async function runMatrix(opts: RunMatrixOptions): Promise<RunMatrixReport> {
	const { manifest, resultsPath, execute } = opts;
	const resume = opts.resume ?? true;

	const prior = latestResults(loadResults(resultsPath));
	const executed: string[] = [];
	const skipped: string[] = [];

	for (const instance of manifest.instances) {
		if (opts.limit !== undefined && executed.length >= opts.limit) {
			skipped.push(instance.instance_id);
			continue;
		}

		const previous = prior.get(instance.instance_id);
		if (previous) {
			const isFailure = previous.status === "unresolved" || previous.status === "error";
			const shouldRerun = opts.onlyFailed ? isFailure : !resume;
			if (!shouldRerun) {
				skipped.push(instance.instance_id);
				continue;
			}
		} else if (opts.onlyFailed) {
			// onlyFailed targets a previous run's failures; never-run instances
			// are out of scope for this invocation.
			skipped.push(instance.instance_id);
			continue;
		}

		let outcome: ExecuteOutcome;
		try {
			outcome = await execute(instance, manifest.budget);
		} catch (err) {
			outcome = {
				status: "error",
				notes: err instanceof Error ? err.message : String(err),
			};
		}

		const result = BenchResultSchema.parse({
			instance_id: instance.instance_id,
			benchmark: manifest.benchmark,
			dataset_version: manifest.dataset_version,
			status: outcome.status,
			steps: outcome.steps ?? 0,
			tokens: outcome.tokens ?? 0,
			duration_ms: outcome.duration_ms ?? 0,
			completed_at: new Date().toISOString(),
			notes: outcome.notes,
		});
		appendResult(resultsPath, result);
		prior.set(result.instance_id, result);
		executed.push(instance.instance_id);
	}

	return {
		benchmark: manifest.benchmark,
		dataset_version: manifest.dataset_version,
		budget: manifest.budget,
		executed,
		skipped,
		metrics: aggregate([...prior.values()]),
	};
}

/** Rewrite the result store with one line per instance (compaction). */
export function compactResults(path: string): number {
	const latest = latestResults(loadResults(path));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${[...latest.values()].map((r) => JSON.stringify(r)).join("\n")}${latest.size > 0 ? "\n" : ""}`,
	);
	return latest.size;
}
