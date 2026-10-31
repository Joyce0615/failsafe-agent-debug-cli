import { describe, expect, test } from "bun:test";
import {
	type OrchestrationEvent,
	ORCHESTRATION_LAYERS,
	localizeOrchestrationFault,
} from "../../src/diagnosis/orchestration-fault.js";
import type { ReplayRunner } from "../../src/diagnosis/fault-localization.js";
import type { Trajectory } from "../../src/diagnosis/trajectory-diff.js";

function events(overrides: Partial<OrchestrationEvent>[] = []): OrchestrationEvent[] {
	const base: OrchestrationEvent[] = [
		{
			id: "plan",
			layer: "planner",
			kind: "plan",
			action: "plan",
			outcome: "ok",
		},
		{
			id: "tool-call",
			layer: "tool",
			kind: "tool_call",
			action: "call_api",
			outcome: "ok",
		},
		{
			id: "worker-step",
			layer: "worker",
			kind: "tool_result",
			action: "handle_result",
			outcome: "error",
			error_class: "validation_error",
		},
	];
	return base.map((e, i) => ({ ...e, ...(overrides[i] ?? {}) }));
}

/** Mirrors fault-localization.test.ts's `scripted` helper: a deterministic
 * simulated-counterfactual runner driven by a lookup of eventId -> outcome
 * when that event is the one ablated (removed) from the replay. */
function scripted(
	baseline: "failed" | "passed" | "error",
	byEvent: Record<string, "failed" | "passed" | "error">,
): ReplayRunner {
	return (replayed) => {
		const ids = new Set(replayed.map((e) => e.id));
		const allIds = Object.keys(byEvent);
		const missing = allIds.find((id) => !ids.has(id));
		if (missing === undefined) return baseline;
		return byEvent[missing] ?? "failed";
	};
}

describe("ORCHESTRATION_LAYERS", () => {
	test("names exactly the five layers the item asks to separate", () => {
		expect(ORCHESTRATION_LAYERS).toEqual(["planner", "worker", "tool", "transport", "environment"]);
	});
});

describe("localizeOrchestrationFault", () => {
	test("a planner-layer ablation that conclusively flips the outcome is blamed as a planner defect", async () => {
		const evs = events();
		const runner = scripted("failed", { plan: "passed", "tool-call": "failed", "worker-step": "failed" });
		const report = await localizeOrchestrationFault(evs, runner, []);
		expect(report.counterfactual_layer).toBe("planner");
		expect(report.verdict).toBe("planner_defect");
	});

	test("a tool-layer ablation that conclusively flips the outcome is blamed as a downstream failure, not the planner", async () => {
		const evs = events();
		const runner = scripted("failed", {
			plan: "failed",
			"tool-call": "passed",
			"worker-step": "failed",
		});
		const report = await localizeOrchestrationFault(evs, runner, []);
		expect(report.counterfactual_layer).toBe("tool");
		expect(report.verdict).toBe("downstream_failure");
	});

	test("no conclusively-flipping ablation and no healthy baselines is indeterminate, not guessed", async () => {
		const evs = events();
		const runner = scripted("failed", {
			plan: "failed",
			"tool-call": "failed",
			"worker-step": "failed",
		});
		const report = await localizeOrchestrationFault(evs, runner, []);
		expect(report.counterfactual_layer).toBeNull();
		expect(report.verdict).toBe("indeterminate");
		expect(report.caveats.length).toBeGreaterThan(0);
	});

	test("counterfactual and trajectory-diff evidence agreeing on the same layer raises confidence, not just coincides", async () => {
		const evs = events([
			{},
			{ outcome: "error", error_class: "timeout" },
			{ outcome: "ok", error_class: undefined },
		]);
		const runner = scripted("failed", {
			plan: "failed",
			"tool-call": "passed",
			"worker-step": "failed",
		});
		// Three healthy baselines that all called the tool successfully: the
		// failing run's tool-call step is the earliest discriminating difference.
		const healthy: Trajectory[] = Array.from({ length: 3 }, (_, i) => ({
			id: `healthy-${i}`,
			steps: [
				{ id: "plan", action: "plan", outcome: "ok" },
				{ id: "tool-call", action: "call_api", outcome: "ok" },
				{ id: "worker-step", action: "handle_result", outcome: "ok" },
			],
		}));
		const report = await localizeOrchestrationFault(evs, runner, healthy);
		expect(report.counterfactual_layer).toBe("tool");
		expect(report.trajectory_diff_layer).toBe("tool");
		expect(report.agreement).toBe(true);
		expect(report.verdict).toBe("downstream_failure");
	});

	test("disagreement between the two lines of evidence is reported as indeterminate, never silently resolved by picking one", async () => {
		const evs = events([
			{},
			{ outcome: "error", error_class: "timeout" },
			{ outcome: "ok", error_class: undefined },
		]);
		// Counterfactual blames the planner...
		const runner = scripted("failed", { plan: "passed", "tool-call": "failed", "worker-step": "failed" });
		// ...but the trajectory diff's earliest discriminating difference is the
		// tool-call step (every healthy baseline called it successfully).
		const healthy: Trajectory[] = Array.from({ length: 3 }, (_, i) => ({
			id: `healthy-${i}`,
			steps: [
				{ id: "plan", action: "plan", outcome: "ok" },
				{ id: "tool-call", action: "call_api", outcome: "ok" },
				{ id: "worker-step", action: "handle_result", outcome: "ok" },
			],
		}));
		const report = await localizeOrchestrationFault(evs, runner, healthy);
		expect(report.counterfactual_layer).toBe("planner");
		expect(report.trajectory_diff_layer).toBe("tool");
		expect(report.agreement).toBe(false);
		expect(report.verdict).toBe("indeterminate");
		expect(report.caveats.some((c) => c.includes("disagree"))).toBe(true);
	});

	test("fewer than MIN_BASELINES healthy trajectories still runs trajectory_diff but its own caveat survives into the combined report", async () => {
		const evs = events();
		const runner = scripted("failed", { plan: "failed", "tool-call": "failed", "worker-step": "failed" });
		const healthy: Trajectory[] = [
			{
				id: "healthy-0",
				steps: [
					{ id: "plan", action: "plan", outcome: "ok" },
					{ id: "tool-call", action: "call_api", outcome: "ok" },
					{ id: "worker-step", action: "handle_result", outcome: "ok" },
				],
			},
		];
		const report = await localizeOrchestrationFault(evs, runner, healthy);
		expect(report.trajectory_diff).not.toBeNull();
		expect(report.caveats.some((c) => c.includes("baseline"))).toBe(true);
	});
});
