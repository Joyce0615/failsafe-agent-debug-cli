/**
 * End-to-end redaction audit (item 3).
 *
 * The per-pattern unit matrix lives in `redaction.test.ts`; this asserts the
 * *pipeline* guarantee: a command whose captured output contains AWS keys,
 * bearer/JWT tokens, a `.env` password, a DB connection string, and a PEM
 * private-key block must not leak any of those secrets into ANY downstream
 * surface — the run packet, the on-disk per-run stdout/stderr/combined logs,
 * the diagnosis packet (and thus `explain`, which reads it), or the OTel span
 * attributes. Because redaction runs before `detectAndParse`, the normalized
 * parse/signature/telemetry surface sees only redacted text.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCommand, diagnoseFailure } from "../../src/core/operations.js";
import { FailsafeStore } from "../../src/storage/store.js";
import {
	diagnoseSpanAttributes,
	parseSpanAttributes,
	runSpanAttributes,
} from "../../src/telemetry/attributes.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

// Contiguous secrets that must never appear in any output surface. They are
// only ever written to a payload file the child reads at runtime, so they do
// not appear in the (un-redacted) command string the packet echoes back.
const SECRETS = {
	awsKeyId: "AKIAIOSFODNN7EXAMPLE",
	awsSecret: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
	bearer: "eyJhbGciOiJIUzI1NiJ9.bearerpayloadtoken.bearersignature",
	jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sIgNaTuReABCdef123",
	envPassword: "hunter2supersecretvalue",
	dbPassword: "s3cr3tPassw0rd",
	dbUser: "appuser",
	pemBody: "MIIEpAIBAAKCAQEAsecretkeymaterialhere",
};

function buildPayload(): string {
	return [
		`aws_access_key_id = ${SECRETS.awsKeyId}`,
		`AWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}`,
		`Authorization: Bearer ${SECRETS.bearer}`,
		`token=${SECRETS.jwt}`,
		`PASSWORD=${SECRETS.envPassword}`,
		`DATABASE_URL=postgres://${SECRETS.dbUser}:${SECRETS.dbPassword}@db.internal:5432/prod`,
		"-----BEGIN RSA PRIVATE KEY-----",
		SECRETS.pemBody,
		"-----END RSA PRIVATE KEY-----",
		"KeyError: 'user_id'",
	].join("\n");
}

/** Every contiguous secret substring that must be absent everywhere. */
const MUST_NOT_LEAK = [
	SECRETS.awsKeyId,
	SECRETS.awsSecret,
	SECRETS.bearer,
	SECRETS.jwt,
	SECRETS.envPassword,
	SECRETS.dbPassword,
	SECRETS.pemBody,
];

function assertNoLeak(surface: string, label: string): void {
	for (const secret of MUST_NOT_LEAK) {
		expect(surface.includes(secret), `${label} leaked secret ${secret.slice(0, 8)}…`).toBe(false);
	}
}

describe("redaction across the full output pipeline", () => {
	test("no secret leaks into packet, on-disk logs, diagnosis, or spans", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "failsafe-redact-pipe-"));
		const config = { ...DEFAULT_CONFIG, storage_dir: join(tempDir, ".failsafe") };
		const store = new FailsafeStore(config, tempDir);
		try {
			// Write secrets to a file the child reads at runtime — the command
			// string itself carries no secret (only unredacted user input is echoed).
			const payloadPath = join(tempDir, "payload.txt");
			writeFileSync(payloadPath, buildPayload());
			const scriptPath = join(tempDir, "leak.js");
			writeFileSync(
				scriptPath,
				`const s=require('fs').readFileSync(${JSON.stringify(payloadPath)},'utf8');process.stderr.write(s);process.stdout.write(s);process.exit(1);`,
			);

			const run = await analyzeCommand(`node ${scriptPath}`, config, store);
			expect(run.ok).toBe(true);
			if (!run.ok) return;
			const id = run.data.failure_id as string;

			// 1. Redaction was applied and reported.
			const redaction = run.data.redaction as { applied?: boolean } | undefined;
			expect(redaction?.applied).toBe(true);

			// 2. The run packet carries no secret.
			assertNoLeak(JSON.stringify(run.data), "run packet");

			// 3. On-disk logs (stdout, stderr, combined) are all redacted.
			assertNoLeak(store.getRawOutput(id, "stdout") ?? "", "on-disk stdout");
			assertNoLeak(store.getRawOutput(id, "stderr") ?? "", "on-disk stderr");
			const rawPaths = run.data.raw_paths as Record<string, string>;
			for (const key of ["stdout", "stderr", "combined"] as const) {
				const contents = readFileSync(rawPaths[key], "utf8");
				assertNoLeak(contents, `raw_paths.${key} file`);
				expect(contents).toContain("[REDACTED]");
			}

			// 4. Diagnosis packet (the surface `explain` reads from) is clean, and
			//    the parse/signature layer that feeds it saw only redacted text.
			const diag = await diagnoseFailure(id, store, config);
			expect(diag.ok).toBe(true);
			if (!diag.ok) return;
			assertNoLeak(JSON.stringify(diag.data), "diagnosis packet");
			assertNoLeak(JSON.stringify(store.getDiagnosis(id)), "stored diagnosis (explain source)");

			// 5. OTel span attributes never carry a raw secret.
			const failure = store.getFailure(id)!;
			assertNoLeak(JSON.stringify(runSpanAttributes(run.data)), "run span attributes");
			assertNoLeak(JSON.stringify(parseSpanAttributes(failure.parsed)), "parse span attributes");
			assertNoLeak(JSON.stringify(diagnoseSpanAttributes(diag.data)), "diagnose span attributes");
		} finally {
			store.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 30_000);
});
