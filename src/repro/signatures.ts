import type { SourceLocation } from "../types/common.js";
import type { ParsedError } from "../types/failure.js";
import type { FailureSignature } from "../types/repro.js";

export function computeSignature(
	errors: ParsedError[],
	primaryLocation?: SourceLocation,
): FailureSignature {
	const first = errors[0];
	if (!first) return {};

	const topAppFrame = first.stack_frames?.find((f) => f.is_application);

	return {
		exception_type: first.error_type,
		top_frame_file: topAppFrame?.file ?? primaryLocation?.file,
		top_frame_line: topAppFrame?.line ?? primaryLocation?.line,
		top_frame_function: topAppFrame?.function ?? primaryLocation?.symbol,
		test_name: first.test_name,
		assertion_key: first.assertion_diff
			? `${first.assertion_diff.operator ?? "eq"}:${first.assertion_diff.expected?.substring(0, 30)}`
			: undefined,
		file: primaryLocation?.file,
		line: primaryLocation?.line,
	};
}

export function signaturesMatch(a: FailureSignature, b: FailureSignature): number {
	let score = 0;
	let weights = 0;

	// Exception type match (high weight)
	if (a.exception_type && b.exception_type) {
		weights += 3;
		if (a.exception_type === b.exception_type) score += 3;
	}

	// Top frame file + function match (high weight)
	if (a.top_frame_file && b.top_frame_file) {
		weights += 2;
		if (a.top_frame_file === b.top_frame_file) {
			score += 1;
			if (a.top_frame_function && a.top_frame_function === b.top_frame_function) {
				score += 1;
			}
		}
	}

	// Top frame line match (medium weight)
	if (a.top_frame_line && b.top_frame_line) {
		weights += 1;
		if (a.top_frame_line === b.top_frame_line) score += 1;
	}

	// Test name match (high weight)
	if (a.test_name && b.test_name) {
		weights += 3;
		if (a.test_name === b.test_name) score += 3;
	}

	// Assertion key match
	if (a.assertion_key && b.assertion_key) {
		weights += 1;
		if (a.assertion_key === b.assertion_key) score += 1;
	}

	// Compiler code match
	if (a.compiler_code && b.compiler_code) {
		weights += 2;
		if (a.compiler_code === b.compiler_code) score += 2;
	}

	// Lint rule match
	if (a.lint_rule && b.lint_rule) {
		weights += 2;
		if (a.lint_rule === b.lint_rule) score += 2;
	}

	return weights > 0 ? score / weights : 0;
}
