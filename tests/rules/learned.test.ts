import { describe, expect, test } from "bun:test";
import { computeSignatureHash } from "../../src/rules/learned.js";
import type { ParsedError } from "../../src/types/failure.js";

describe("computeSignatureHash", () => {
	test("produces consistent hash for same errors", () => {
		const errors: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];
		const hash1 = computeSignatureHash(errors);
		const hash2 = computeSignatureHash(errors);
		expect(hash1).toBe(hash2);
	});

	test("produces 16-character hex hash", () => {
		const errors: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];
		const hash = computeSignatureHash(errors);
		expect(hash.length).toBe(16);
		expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
	});

	test("different error types produce different hashes", () => {
		const errorsA: ParsedError[] = [{ message: "KeyError", error_type: "KeyError" }];
		const errorsB: ParsedError[] = [{ message: "TypeError", error_type: "TypeError" }];
		expect(computeSignatureHash(errorsA)).not.toBe(computeSignatureHash(errorsB));
	});

	test("same error type with different messages produces same hash", () => {
		const errorsA: ParsedError[] = [{ message: "KeyError: 'email'", error_type: "KeyError" }];
		const errorsB: ParsedError[] = [{ message: "KeyError: 'user_id'", error_type: "KeyError" }];
		// Same error type, no stack frames — hashes should match since message is not part of hash
		expect(computeSignatureHash(errorsA)).toBe(computeSignatureHash(errorsB));
	});

	test("includes file in hash when available", () => {
		const errorsA: ParsedError[] = [
			{
				message: "KeyError",
				error_type: "KeyError",
				stack_frames: [{ file: "src/auth.py", line: 42, is_application: true }],
			},
		];
		const errorsB: ParsedError[] = [
			{
				message: "KeyError",
				error_type: "KeyError",
				stack_frames: [{ file: "src/user.py", line: 42, is_application: true }],
			},
		];
		expect(computeSignatureHash(errorsA)).not.toBe(computeSignatureHash(errorsB));
	});
});
