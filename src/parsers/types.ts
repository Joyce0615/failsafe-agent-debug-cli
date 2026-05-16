import type { ParsedError, TestSummary } from "../types/failure.js";

export type ParserResult = {
	parser: string;
	failure_type:
		| "test_failure"
		| "build_error"
		| "lint_error"
		| "type_error"
		| "runtime_exception"
		| "timeout"
		| "tool_error"
		| "unknown";
	errors: ParsedError[];
	test_summary?: TestSummary;
};

export interface FailureParser {
	name: string;
	detect(stdout: string, stderr: string, command: string): boolean;
	parse(stdout: string, stderr: string, command: string): ParserResult;
}
