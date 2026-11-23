/**
 * Separate workflow-author defects from executor defects (item 57,
 * module-header numbering: item 122, confirmed next-free via `grep
 * -rohE "item [0-9]+" src --include="*.ts" | sort -t' ' -k2 -n -u |
 * tail`, highest prior being item 121 from item 56's
 * `latent-fault-paired-control.ts`).
 *
 * WorkflowArena (arxiv.org/abs/2611.12856, cited in this project's own
 * "Next cycle pending development items" research list) treats workflow
 * authorship (how a task was decomposed into steps) and orchestration/
 * execution (how an executor actually carried those steps out) as
 * INDEPENDENT performance variables that must be varied separately to
 * tell apart. `grep -rln "workflow.author|executor.defect|2.*x.*2.
 * matrix|2x2|decomposition.effect|interaction.effect" src --include=
 * "*.ts" -i` before this module returned nothing. `cohort-analysis.ts`
 * (item 73) already has the adjacent discipline this module borrows
 * directly — refuse small cells rather than silently calling a rate,
 * and report "untested" as its own category distinct from "tested and
 * clean" — but it stratifies a POPULATION by an external dimension
 * (region, tenant, flag); nothing in this repo holds workflow identity
 * and executor identity as the TWO factors of a single 2×2 design for
 * one specific target failure.
 *
 * The classic factorial-design move this module performs: a target run
 * that failed is explained by exactly one of three mutually-informing,
 * independently-reportable effects, read off the SAME TWO margins of
 * the 2×2 table (same workflow paired with every OTHER executor; same
 * executor paired with every OTHER workflow) that the run itself sits
 * at the intersection of:
 *
 * - `decomposition_effect` ("workflow-author defect"): the workflow
 *   fails broadly, regardless of which executor ran it — read directly
 *   off the "same workflow, different executor" margin, with NO
 *   dependency on the executor margin's own result. A workflow that
 *   fails with executor A, B, and C was decomposed wrong; who executed
 *   it is incidental.
 * - `execution_effect` ("executor defect"): symmetric, read off the
 *   "same executor, different workflow" margin — an executor that
 *   fails across unrelated workflows has a defect of its own,
 *   independent of any one workflow's decomposition.
 * - `interaction_effect`: the residual this item explicitly asks for —
 *   a failure that neither margin explains on its own (both margins
 *   report `absent`, i.e. this workflow is otherwise fine and this
 *   executor is otherwise fine), yet the specific (workflow, executor)
 *   pairing still failed. This is attributed ONLY when both main
 *   effects have already been resolved to `absent` with sufficient
 *   evidence — an interaction effect is a RESIDUAL concept, undefined
 *   until the two main effects it is residual TO are themselves known,
 *   mirroring `orchestration-fault.ts`'s (item 27) own refusal to force
 *   a verdict from one signal when both are expected to agree. When
 *   either main effect is instead `present`, that main effect already
 *   explains the specific failure and `interaction_effect` reports
 *   `absent` — this module never double-counts the same evidence under
 *   two different effect names.
 *
 * Each of the three effects is its own independent tri-state verdict
 * (`present`/`absent`/`insufficient_evidence`), never folded into one
 * combined label, continuing this project's "don't invent a composite
 * number" discipline (`drift.ts`, `authorization-drift.ts`,
 * `shared-state-race.ts` all make the same call). A margin is refused
 * (classified `insufficient_evidence`) under TWO conditions, mirroring
 * `cohort-analysis.ts`'s own small-cell refusal: fewer than
 * `MIN_DISTINCT_OTHERS` distinct other executors/workflows were
 * observed (too few data points to generalize at all), OR the observed
 * failure rate among them is neither a clear majority (> 0.5, "present")
 * nor entirely clean (0, "absent") — a 50/50 split IS evidence, but not
 * evidence strong enough to assert either main effect, and asserting
 * one anyway would be a confident-sounding guess wearing a p-value it
 * never earned.
 *
 * Pure: no fs/network/process. Caller supplies every `WorkflowExecutorRun`
 * this module reasons over; it never discovers runs, executors, or
 * workflows on its own.
 */

export type RunOutcome = "pass" | "fail";

export type WorkflowExecutorRun = {
	run_id: string;
	workflow_id: string;
	executor_id: string;
	outcome: RunOutcome;
};

/** Distinct other executors/workflows below this cannot generalize a main effect at all. */
export const MIN_DISTINCT_OTHERS = 2;
/** A failure rate strictly above this among sufficient distinct others is "present"; exactly 0 is "absent"; anything in between is an ambiguous mixed signal. */
export const MAJORITY_THRESHOLD = 0.5;

export type EffectVerdict = "present" | "absent" | "insufficient_evidence";

export type MarginStats = {
	distinct_count: number;
	total_runs: number;
	failed_runs: number;
	failure_rate: number;
};

function computeMargin(
	runs: WorkflowExecutorRun[],
	keyOf: (r: WorkflowExecutorRun) => string,
): MarginStats {
	const distinct = new Set(runs.map(keyOf));
	const failed = runs.filter((r) => r.outcome === "fail").length;
	return {
		distinct_count: distinct.size,
		total_runs: runs.length,
		failed_runs: failed,
		failure_rate: runs.length === 0 ? 0 : failed / runs.length,
	};
}

/** Classify one margin into a main-effect verdict, refusing when evidence is thin or ambiguous. */
function classifyMargin(margin: MarginStats): EffectVerdict {
	if (margin.distinct_count < MIN_DISTINCT_OTHERS) return "insufficient_evidence";
	if (margin.failure_rate > MAJORITY_THRESHOLD) return "present";
	if (margin.failure_rate === 0) return "absent";
	return "insufficient_evidence";
}

export type AttributionResult = {
	target_run_id: string;
	workflow_id: string;
	executor_id: string;
	target_outcome: RunOutcome;
	decomposition_effect: EffectVerdict;
	execution_effect: EffectVerdict;
	interaction_effect: EffectVerdict;
	same_workflow_different_executor: MarginStats;
	same_executor_different_workflow: MarginStats;
	reasons: string[];
};

/**
 * Attribute a target run's outcome to a workflow-author (decomposition)
 * defect, an executor (execution) defect, an interaction between the
 * two, or insufficient evidence for any of the three — read off the
 * 2×2 matrix of every OTHER run sharing the target's workflow or
 * executor. Throws only when `targetRunId` cannot be found in `runs`.
 */
export function attributeDefect(
	targetRunId: string,
	runs: WorkflowExecutorRun[],
): AttributionResult {
	const target = runs.find((r) => r.run_id === targetRunId);
	if (!target) {
		throw new Error(`no run with run_id '${targetRunId}' was found among the supplied runs`);
	}

	const sameWorkflowDifferentExecutor = runs.filter(
		(r) => r.workflow_id === target.workflow_id && r.executor_id !== target.executor_id,
	);
	const sameExecutorDifferentWorkflow = runs.filter(
		(r) => r.executor_id === target.executor_id && r.workflow_id !== target.workflow_id,
	);

	const workflowMargin = computeMargin(sameWorkflowDifferentExecutor, (r) => r.executor_id);
	const executorMargin = computeMargin(sameExecutorDifferentWorkflow, (r) => r.workflow_id);

	const decompositionEffect = classifyMargin(workflowMargin);
	const executionEffect = classifyMargin(executorMargin);

	const reasons: string[] = [];
	reasons.push(
		decompositionEffect === "insufficient_evidence"
			? `workflow '${target.workflow_id}' was observed with only ${workflowMargin.distinct_count} other distinct executor(s) (need ${MIN_DISTINCT_OTHERS}+) or an ambiguous mixed failure rate (${workflowMargin.failure_rate}); decomposition effect cannot be called`
			: decompositionEffect === "present"
				? `workflow '${target.workflow_id}' failed with a majority (${workflowMargin.failed_runs}/${workflowMargin.total_runs}) of ${workflowMargin.distinct_count} other distinct executors — a decomposition (workflow-author) defect`
				: `workflow '${target.workflow_id}' passed cleanly with all ${workflowMargin.distinct_count} other distinct executors tried`,
	);
	reasons.push(
		executionEffect === "insufficient_evidence"
			? `executor '${target.executor_id}' was observed with only ${executorMargin.distinct_count} other distinct workflow(s) (need ${MIN_DISTINCT_OTHERS}+) or an ambiguous mixed failure rate (${executorMargin.failure_rate}); execution effect cannot be called`
			: executionEffect === "present"
				? `executor '${target.executor_id}' failed with a majority (${executorMargin.failed_runs}/${executorMargin.total_runs}) of ${executorMargin.distinct_count} other distinct workflows — an execution (executor) defect`
				: `executor '${target.executor_id}' passed cleanly with all ${executorMargin.distinct_count} other distinct workflows tried`,
	);

	let interactionEffect: EffectVerdict;
	if (
		decompositionEffect === "insufficient_evidence" ||
		executionEffect === "insufficient_evidence"
	) {
		interactionEffect = "insufficient_evidence";
		reasons.push(
			"interaction effect cannot be called: it is a residual concept, undefined until both main effects are themselves resolved",
		);
	} else if (decompositionEffect === "present" || executionEffect === "present") {
		interactionEffect = "absent";
		reasons.push(
			"interaction effect is absent: at least one main effect already explains this run's outcome, so no additional residual effect is claimed",
		);
	} else if (target.outcome === "fail") {
		interactionEffect = "present";
		reasons.push(
			"interaction effect is present: this specific (workflow, executor) pairing failed even though neither the workflow nor the executor fails broadly on its own",
		);
	} else {
		interactionEffect = "absent";
		reasons.push(
			"interaction effect is absent: this run passed, and neither main effect was present",
		);
	}

	return {
		target_run_id: target.run_id,
		workflow_id: target.workflow_id,
		executor_id: target.executor_id,
		target_outcome: target.outcome,
		decomposition_effect: decompositionEffect,
		execution_effect: executionEffect,
		interaction_effect: interactionEffect,
		same_workflow_different_executor: workflowMargin,
		same_executor_different_workflow: executorMargin,
		reasons,
	};
}

/** Render a human-readable workflow/executor attribution report. */
export function renderAttributionReport(result: AttributionResult): string {
	const lines: string[] = [
		`# Workflow/Executor Defect Attribution — run '${result.target_run_id}' (${result.target_outcome})`,
		`workflow: ${result.workflow_id}, executor: ${result.executor_id}`,
		"",
		`decomposition_effect: ${result.decomposition_effect}`,
		`execution_effect: ${result.execution_effect}`,
		`interaction_effect: ${result.interaction_effect}`,
		"",
	];
	for (const reason of result.reasons) {
		lines.push(`- ${reason}`);
	}
	return lines.join("\n");
}
