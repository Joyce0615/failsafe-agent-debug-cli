/**
 * Debug-Gym trajectory harness tests (item 35).
 *
 * A recorded Python debugging episode replays deterministically; the validator
 * rejects trajectories containing an unredacted secret, an out-of-order DAP
 * action, or a mismatched repository SHA; and the recorder redacts secrets
 * before they are persisted.
 */
import { describe, expect, test } from "bun:test";
import {
	type Trajectory,
	TrajectoryRecorder,
	fromJsonl,
	replayTrajectory,
	toJsonl,
	validateTrajectory,
} from "../../src/debug/trajectory.js";

const SHA = "a".repeat(40);

/** A well-formed episode: run → breakpoint → step/eval → diagnose → patch → verify. */
function recordEpisode(): Trajectory {
	const rec = new TrajectoryRecorder({
		task_id: "debug_gym_keyerror",
		repo_sha: SHA,
		command: "pytest tests/test_auth.py::test_login -x",
		budget: { max_steps: 10, max_tokens: 5000, max_ms: 60_000 },
	});
	rec.append("run", "pytest tests/test_auth.py::test_login -x", "KeyError: 'user_id'");
	rec.append("set_breakpoint", "src/auth.py:42", "breakpoint set", {
		file: "src/auth.py",
		line: 42,
	});
	rec.append("step", "next", "paused at src/auth.py:42", { file: "src/auth.py", line: 42 });
	rec.append("eval", "user", "{'name': 'alice'}");
	rec.append("diagnose", "root cause", "missing 'user_id' key in session dict");
	rec.append("patch", "add guard", "applied fix to src/auth.py");
	rec.append("verify", "pytest tests/test_auth.py::test_login -x", "1 passed");
	return rec.finish("resolved", 1234);
}

describe("TrajectoryRecorder + replay", () => {
	test("replays a recorded Python episode deterministically", () => {
		const traj = recordEpisode();
		const a = replayTrajectory(traj);
		const b = replayTrajectory(fromJsonl(toJsonl(traj)));

		expect(a).toEqual(b); // deterministic + JSONL round-trip stable
		expect(a.resolved).toBe(true);
		expect(a.steps).toBe(7);
		expect(a.actions).toEqual([
			"run",
			"set_breakpoint",
			"step",
			"eval",
			"diagnose",
			"patch",
			"verify",
		]);
		expect(a.tokens_used).toBeGreaterThan(0);
	});

	test("redacts secrets in observations before persistence", () => {
		const rec = new TrajectoryRecorder({ task_id: "t", repo_sha: SHA, command: "run" });
		rec.append("run", "run", `env AWS key ${"AKIA" + "IOSFODNN7EXAMPLE"} leaked`);
		const traj = rec.finish("unresolved");
		expect(traj.steps[0].observation).toContain("[REDACTED]");
		expect(traj.steps[0].observation).not.toContain("AKIAIOSFODNN7EXAMPLE");
		// A secret-free, well-ordered trajectory validates.
		expect(validateTrajectory(traj).valid).toBe(true);
	});
});

describe("validateTrajectory", () => {
	test("accepts a well-formed episode with matching SHA and budget", () => {
		const result = validateTrajectory(recordEpisode(), { expectedSha: SHA });
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("rejects a trajectory containing an unredacted secret", () => {
		const traj = recordEpisode();
		// Bypass the recorder's redaction to simulate a leaked observation.
		traj.steps[0].observation = `token ${"AKIA" + "IOSFODNN7EXAMPLE"}`;
		const result = validateTrajectory(traj);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("unredacted secret"))).toBe(true);
	});

	test("rejects an out-of-order DAP action (step before run+breakpoint)", () => {
		const rec = new TrajectoryRecorder({ task_id: "t", repo_sha: SHA, command: "run" });
		rec.append("step", "next", "paused"); // step with no prior run/breakpoint
		const result = validateTrajectory(rec.finish("aborted"));
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("out-of-order DAP action"))).toBe(true);
	});

	test("rejects a mismatched repository SHA", () => {
		const result = validateTrajectory(recordEpisode(), { expectedSha: "b".repeat(40) });
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("repo_sha mismatch"))).toBe(true);
	});

	test("rejects a step-budget overrun", () => {
		const rec = new TrajectoryRecorder({
			task_id: "t",
			repo_sha: SHA,
			command: "run",
			budget: { max_steps: 1 },
		});
		rec.append("run", "run", "fail");
		rec.append("diagnose", "why", "because");
		const result = validateTrajectory(rec.finish("unresolved"));
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("step budget exceeded"))).toBe(true);
	});
});
