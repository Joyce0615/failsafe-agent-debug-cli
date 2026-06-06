/**
 * Standardized agent-facing exit codes.
 *
 * Agents and shell scripts can branch on these without parsing output:
 *   0  OK              — command succeeded; a packet was produced
 *   1  ERROR           — malformed input or an unexpected internal error
 *   2  NO_INPUT        — referenced failure/history/session does not exist
 *   3  POLICY_BLOCK    — command rejected by the safety policy
 *   4  DEBUG_UNAVAILABLE — unsupported runtime, missing adapter, or no session
 *
 * Note: a captured command that itself fails (e.g. `failsafe run "pytest"`
 * where pytest exits non-zero) is still a SUCCESSFUL Failsafe run — it exits
 * 0 because Failsafe produced a valid failure packet. The captured exit code
 * is reported in the packet's `exit_code` field.
 */
export const ExitCode = {
	OK: 0,
	ERROR: 1,
	NO_INPUT: 2,
	POLICY_BLOCK: 3,
	DEBUG_UNAVAILABLE: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
