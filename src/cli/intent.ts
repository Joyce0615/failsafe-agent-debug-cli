import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
	type IntentInput,
	type IntentReport,
	extractIntent,
	reconcile,
} from "../diagnosis/intent.js";
import { ExitCode } from "./exit-codes.js";
import { outputResult } from "./format.js";
import { initCommand, resolveFailureOrExit } from "./shared.js";

function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

/**
 * `failsafe intent <failure-id>` — extract and compare design intent (item 46).
 *
 * Reads the failure's suspect source file and its failing test, extracts what
 * each says the code is supposed to do, and reports where they disagree.
 * Conflicts are surfaced, never resolved.
 */
export function registerIntentCommand(program: Command): void {
	program
		.command("intent <failure-id>")
		.description("Compare design intent from specs, tests, types, and invariants")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.option("--quiet", "Emit minified single-line JSON")
		.option("--source <file>", "Override the source file to read")
		.option("--test <file>", "Override the test file to read")
		.option("--symbol <name>", "Scope test/spec statements to this symbol")
		.option("--gate", "Exit non-zero when intent sources conflict")
		.action(async (rawId: string, opts) => {
			const { store, outOpts } = initCommand(opts);
			const { failure } = resolveFailureOrExit(rawId, store, outOpts);
			const errors = failure.parsed.flatMap((p) => p.errors);

			const sourcePath = (opts.source as string | undefined) ?? failure.primary_location?.file;
			const testPath =
				(opts.test as string | undefined) ?? errors.find((e) => e.test_file)?.test_file;
			const symbol = (opts.symbol as string | undefined) ?? failure.primary_location?.symbol;

			const inputs: IntentInput[] = [];
			const read: string[] = [];
			const missing: string[] = [];

			if (sourcePath) {
				const text = readOrNull(sourcePath);
				if (text === null) missing.push(sourcePath);
				else {
					read.push(sourcePath);
					// One file legitimately carries several kinds of intent.
					for (const kind of ["type", "spec", "invariant"] as const) {
						inputs.push({
							kind,
							path: sourcePath,
							text,
							...(symbol ? { subject: symbol } : {}),
						});
					}
				}
			}
			if (testPath) {
				const text = readOrNull(testPath);
				if (text === null) missing.push(testPath);
				else {
					read.push(testPath);
					inputs.push({
						kind: "test",
						path: testPath,
						text,
						...(symbol ? { subject: symbol } : {}),
					});
				}
			}

			if (inputs.length === 0) {
				outputResult(
					{
						error: true,
						message:
							"No source or test file to read intent from. Pass --source/--test, or diagnose the failure first so a primary location exists.",
						missing,
					},
					outOpts,
				);
				store.close();
				process.exit(ExitCode.NO_INPUT);
			}

			const report = reconcile(extractIntent(inputs));
			const payload = {
				failure_id: failure.failure_id,
				files_read: read,
				...(missing.length > 0 ? { files_missing: missing } : {}),
				...report,
			};

			outputResult(payload as unknown as Record<string, unknown>, outOpts, (d) => {
				const r = d as typeof payload & IntentReport;
				const lines = [
					`[INTENT] ${r.subjects.length} subject(s), ${r.conflicts.length} conflict(s)`,
				];
				for (const subject of r.subjects) {
					lines.push(`  ${subject.subject} (${subject.status})`);
					for (const s of subject.statements) {
						lines.push(`    [${s.source}] ${s.statement}  (${s.location})`);
					}
				}
				for (const c of r.conflicts) {
					lines.push(`  CONFLICT ${c.subject}.${c.kind}: ${c.detail}`);
				}
				lines.push(`  ${r.advisory_note}`);
				return lines.join("\n");
			});

			store.close();
			if (opts.gate === true && report.conflicts.length > 0) {
				process.exit(ExitCode.ERROR);
			}
		});
}
