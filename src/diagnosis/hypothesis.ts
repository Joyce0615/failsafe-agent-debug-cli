/**
 * Hierarchical hypothesis validation and intent-aware localization (item 43).
 *
 * A diagnosis today collapses to one root cause and a confidence number, which
 * loses the reasoning that produced it: what else was on the table, what would
 * have distinguished the candidates, what was actually observed, and why the
 * losers were dropped. This module makes that structure first-class.
 *
 * - **Hierarchical.** Hypotheses nest `module → file → function → line`. A
 *   refuted parent refutes everything beneath it, so an agent cannot keep
 *   probing lines inside a file it has already ruled out.
 * - **Falsifiable.** Every hypothesis carries a probe and the observation
 *   expected under each outcome *before* the probe runs, so a result cannot be
 *   reinterpreted after the fact to support whatever was already believed.
 * - **Bayesian.** Observations update posteriors through an explicit likelihood
 *   ratio and renormalize across siblings, so belief mass moves between
 *   competitors instead of being asserted.
 * - **Intent-aware.** Localization records where its notion of correct behavior
 *   came from (spec, test, type, invariant, docstring, commit message) and keeps
 *   conflicting sources rather than silently picking one.
 * - **Explicit abandonment.** Nothing disappears quietly: a dropped hypothesis
 *   keeps a reason, and a reason is required to drop it.
 *
 * Pure module: no fs, network, clock, or randomness. Timestamps are supplied by
 * the caller so trees are reproducible in tests.
 */
import { z } from "zod";

/** Localization granularity, coarsest first. Parents must be coarser than children. */
export const HYPOTHESIS_LEVELS = ["module", "file", "function", "line"] as const;
export const HypothesisLevelSchema = z.enum(HYPOTHESIS_LEVELS);
export type HypothesisLevel = z.infer<typeof HypothesisLevelSchema>;

export function levelRank(level: HypothesisLevel): number {
	return HYPOTHESIS_LEVELS.indexOf(level);
}

/**
 * Where a statement about *intended* behavior came from.
 *
 * Localization is a comparison between what the code does and what it was
 * supposed to do; naming the second half is what makes the comparison auditable.
 */
export const INTENT_SOURCES = [
	"spec",
	"test",
	"type",
	"invariant",
	"docstring",
	"commit_message",
	"inferred",
] as const;
export const IntentSourceSchema = z.enum(INTENT_SOURCES);
export type IntentSource = z.infer<typeof IntentSourceSchema>;

export const IntentSchema = z.object({
	source: IntentSourceSchema,
	/** The intended behavior, quoted or paraphrased from the source. */
	statement: z.string(),
	/** Where the statement was read from (`file:line`, test name, type name). */
	location: z.string().optional(),
	/**
	 * Other sources that disagree. Recorded rather than resolved — silently
	 * picking one source is how a "fix" ends up satisfying the test and
	 * violating the spec.
	 */
	conflicts: z.array(z.object({ source: IntentSourceSchema, statement: z.string() })).default([]),
});
export type Intent = z.infer<typeof IntentSchema>;

export const PROBE_KINDS = [
	"read_slice",
	"assertion_probe",
	"debugger_breakpoint",
	"rerun",
] as const;

export const ProbeSchema = z.object({
	kind: z.enum(PROBE_KINDS),
	/** Ready-to-run command. */
	command: z.string(),
	/** `file:line` the probe observes, when it has one. */
	location: z.string().optional(),
	/** Expressions to read at that location. */
	watch: z.array(z.string()).default([]),
	/** What confirms the hypothesis. Written before the probe runs. */
	expected_if_true: z.string(),
	/** What refutes it. Written before the probe runs. */
	expected_if_false: z.string(),
});
export type Probe = z.infer<typeof ProbeSchema>;

export const OBSERVATION_OUTCOMES = ["confirms", "refutes", "inconclusive"] as const;

export const ObservationSchema = z.object({
	/** What was actually seen. */
	detail: z.string(),
	outcome: z.enum(OBSERVATION_OUTCOMES),
	/** ISO timestamp, supplied by the caller. */
	observed_at: z.string(),
	/** P(observation | hypothesis true). */
	likelihood_if_true: z.number().min(0).max(1),
	/** P(observation | hypothesis false). */
	likelihood_if_false: z.number().min(0).max(1),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const HYPOTHESIS_STATUSES = ["open", "confirmed", "refuted", "abandoned"] as const;

export const HypothesisSchema = z.object({
	id: z.string(),
	failure_id: z.string(),
	/** Coarser hypothesis this one refines. Absent for roots. */
	parent_id: z.string().optional(),
	level: HypothesisLevelSchema,
	/** The falsifiable claim, e.g. "auth.py:42 reads a key that may be absent". */
	statement: z.string(),
	/** `file`, `file:line`, or a module path, depending on level. */
	location: z.string().optional(),
	prior: z.number().min(0).max(1),
	posterior: z.number().min(0).max(1),
	status: z.enum(HYPOTHESIS_STATUSES),
	intent: IntentSchema.optional(),
	probe: ProbeSchema.optional(),
	observations: z.array(ObservationSchema).default([]),
	/** Required whenever status is `abandoned`; enforced by `abandonHypothesis`. */
	abandonment_reason: z.string().optional(),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const HypothesisTreeSchema = z.object({
	schema_version: z.literal("0.1"),
	failure_id: z.string(),
	hypotheses: z.array(HypothesisSchema),
});
export type HypothesisTree = z.infer<typeof HypothesisTreeSchema>;

/** Belief below which an open hypothesis is not worth another probe. */
export const ABANDON_POSTERIOR = 0.02;
/** Posterior at or above which a hypothesis counts as confirmed. */
export const CONFIRM_POSTERIOR = 0.9;

/**
 * Bayes update for a single hypothesis.
 *
 * `posterior = P(H)L(E|H) / (P(H)L(E|H) + (1-P(H))L(E|¬H))`. Returns the prior
 * unchanged when the evidence is impossible under both branches, which is the
 * honest answer: an observation that could not have happened either way carries
 * no information.
 */
export function updatePosterior(
	prior: number,
	likelihoodIfTrue: number,
	likelihoodIfFalse: number,
): number {
	const p = Math.min(1, Math.max(0, prior));
	const num = p * likelihoodIfTrue;
	const denom = num + (1 - p) * likelihoodIfFalse;
	if (denom <= 0) return p;
	return num / denom;
}

/** Renormalize live siblings so their posteriors sum to the mass they share. */
function renormalizeSiblings(hypotheses: Hypothesis[], parentId: string | undefined): void {
	const live = hypotheses.filter((h) => h.parent_id === parentId && h.status === "open");
	if (live.length === 0) return;
	const total = live.reduce((a, h) => a + h.posterior, 0);
	if (total <= 0) {
		for (const h of live) h.posterior = 1 / live.length;
		return;
	}
	// Dead siblings' mass is redistributed proportionally, not conserved: a
	// refuted branch's belief has to go somewhere, and the only candidates are
	// its surviving competitors.
	for (const h of live) h.posterior = h.posterior / total;
}

/** Every descendant id of `id`, transitively. */
export function descendantsOf(tree: HypothesisTree, id: string): string[] {
	const out: string[] = [];
	const queue = [id];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const h of tree.hypotheses) {
			if (h.parent_id === current) {
				out.push(h.id);
				queue.push(h.id);
			}
		}
	}
	return out;
}

export type RecordObservationResult = {
	tree: HypothesisTree;
	/** Hypotheses whose status changed as a result, with the new status. */
	transitions: Array<{ id: string; from: string; to: string; reason: string }>;
};

/**
 * Apply an observation to one hypothesis and propagate the consequences.
 *
 * A refuting observation refutes the hypothesis and abandons its whole subtree —
 * a line inside a ruled-out file is not worth probing. A confirming observation
 * that clears {@link CONFIRM_POSTERIOR} marks it confirmed. Surviving siblings
 * are renormalized either way, and any open hypothesis that falls below
 * {@link ABANDON_POSTERIOR} is abandoned with an explicit reason rather than
 * left to linger at 0.3% forever.
 */
export function recordObservation(
	tree: HypothesisTree,
	hypothesisId: string,
	observation: Observation,
): RecordObservationResult {
	const next: HypothesisTree = structuredClone(tree);
	const target = next.hypotheses.find((h) => h.id === hypothesisId);
	const transitions: RecordObservationResult["transitions"] = [];
	if (!target) return { tree: next, transitions };

	target.observations.push(observation);
	const before = target.status;
	target.posterior = updatePosterior(
		target.posterior,
		observation.likelihood_if_true,
		observation.likelihood_if_false,
	);

	if (observation.outcome === "refutes") {
		target.status = "refuted";
		target.posterior = Math.min(target.posterior, ABANDON_POSTERIOR);
		transitions.push({
			id: target.id,
			from: before,
			to: "refuted",
			reason: `refuting observation: ${observation.detail}`,
		});
		for (const id of descendantsOf(next, target.id)) {
			const child = next.hypotheses.find((h) => h.id === id);
			if (!child || child.status !== "open") continue;
			const childBefore = child.status;
			child.status = "abandoned";
			child.abandonment_reason = `parent hypothesis '${target.id}' was refuted: ${observation.detail}`;
			child.posterior = 0;
			transitions.push({
				id: child.id,
				from: childBefore,
				to: "abandoned",
				reason: child.abandonment_reason,
			});
		}
	} else if (observation.outcome === "confirms" && target.posterior >= CONFIRM_POSTERIOR) {
		target.status = "confirmed";
		transitions.push({
			id: target.id,
			from: before,
			to: "confirmed",
			reason: `posterior ${target.posterior.toFixed(3)} reached the ${CONFIRM_POSTERIOR} confirmation threshold`,
		});
	}

	renormalizeSiblings(next.hypotheses, target.parent_id);

	for (const h of next.hypotheses) {
		if (h.status !== "open" || h.posterior >= ABANDON_POSTERIOR) continue;
		h.status = "abandoned";
		h.abandonment_reason = `posterior fell to ${h.posterior.toFixed(4)}, below the ${ABANDON_POSTERIOR} floor`;
		transitions.push({
			id: h.id,
			from: "open",
			to: "abandoned",
			reason: h.abandonment_reason,
		});
	}

	return { tree: next, transitions };
}

/**
 * Drop a hypothesis for a stated reason.
 *
 * The reason is a required argument rather than an optional field: an
 * unexplained abandonment is exactly the failure mode this item exists to
 * prevent. Descendants are abandoned too, naming the ancestor.
 */
export function abandonHypothesis(
	tree: HypothesisTree,
	hypothesisId: string,
	reason: string,
): HypothesisTree {
	if (!reason.trim()) throw new Error("abandonHypothesis requires a non-empty reason");
	const next: HypothesisTree = structuredClone(tree);
	const target = next.hypotheses.find((h) => h.id === hypothesisId);
	if (!target) return next;
	target.status = "abandoned";
	target.abandonment_reason = reason;
	target.posterior = 0;
	for (const id of descendantsOf(next, hypothesisId)) {
		const child = next.hypotheses.find((h) => h.id === id);
		if (!child || child.status !== "open") continue;
		child.status = "abandoned";
		child.abandonment_reason = `ancestor '${hypothesisId}' was abandoned: ${reason}`;
		child.posterior = 0;
	}
	renormalizeSiblings(next.hypotheses, target.parent_id);
	return next;
}

export type ValidationSummary = {
	failure_id: string;
	total: number;
	open: number;
	confirmed: number;
	refuted: number;
	abandoned: number;
	/** Highest-posterior open or confirmed hypothesis, if any survive. */
	leading?: { id: string; level: HypothesisLevel; statement: string; posterior: number };
	/** Finest level still under active investigation. */
	deepest_open_level?: HypothesisLevel;
	/** Every hypothesis dropped, with its reason. Nothing vanishes silently. */
	abandoned_with_reasons: Array<{ id: string; reason: string }>;
	/** Intent sources that disagree about correct behavior. */
	intent_conflicts: Array<{ hypothesis_id: string; sources: IntentSource[] }>;
};

export function summarize(tree: HypothesisTree): ValidationSummary {
	const by = (status: string) => tree.hypotheses.filter((h) => h.status === status);
	const live = tree.hypotheses.filter((h) => h.status === "open" || h.status === "confirmed");
	const leading = live.reduce<Hypothesis | undefined>(
		(best, h) => (best === undefined || h.posterior > best.posterior ? h : best),
		undefined,
	);
	const open = by("open");
	const deepest = open.reduce<HypothesisLevel | undefined>(
		(best, h) => (best === undefined || levelRank(h.level) > levelRank(best) ? h.level : best),
		undefined,
	);
	return {
		failure_id: tree.failure_id,
		total: tree.hypotheses.length,
		open: open.length,
		confirmed: by("confirmed").length,
		refuted: by("refuted").length,
		abandoned: by("abandoned").length,
		...(leading
			? {
					leading: {
						id: leading.id,
						level: leading.level,
						statement: leading.statement,
						posterior: leading.posterior,
					},
				}
			: {}),
		...(deepest ? { deepest_open_level: deepest } : {}),
		abandoned_with_reasons: tree.hypotheses
			.filter((h) => h.status === "abandoned")
			.map((h) => ({ id: h.id, reason: h.abandonment_reason ?? "(unrecorded)" })),
		intent_conflicts: tree.hypotheses
			.filter((h) => (h.intent?.conflicts.length ?? 0) > 0)
			.map((h) => ({
				hypothesis_id: h.id,
				sources: [
					h.intent?.source as IntentSource,
					...(h.intent?.conflicts.map((c) => c.source) ?? []),
				],
			})),
	};
}

export type BuildInput = {
	failure_id: string;
	/** The suspect the diagnosis settled on, if any. */
	primary_location?: { file: string; line: number; symbol?: string };
	/** Application stack frames, most-recent first. */
	frames?: Array<{ file: string; line: number; function?: string; is_application: boolean }>;
	/** Diagnosed category and confidence, when a diagnosis exists. */
	root_cause?: { category: string; explanation: string; confidence: number };
	/** Failing test, used as the intent source when present. */
	test_name?: string;
	/** Repro or original command, used to build probes. */
	command?: string;
};

/** Module path for a file: its directory, or the file itself at the root. */
function moduleOf(file: string): string {
	const idx = file.lastIndexOf("/");
	return idx > 0 ? file.slice(0, idx) : file;
}

/**
 * Build the initial `module → file → function → line` chain for the leading
 * suspect, plus one competing file-level hypothesis for the next distinct
 * application frame.
 *
 * The competing branch is the point: a chain alone is not a hypothesis set, it
 * is a single belief written four times. The second frame is where a wrong
 * localization most often actually lives, so it gets the residual mass and its
 * own probe rather than a footnote in `uncertainty`.
 */
export function buildHypothesisTree(input: BuildInput): HypothesisTree {
	const hypotheses: Hypothesis[] = [];
	const primary = input.primary_location;
	if (!primary) {
		return { schema_version: "0.1", failure_id: input.failure_id, hypotheses };
	}

	const confidence = Math.min(1, Math.max(0, input.root_cause?.confidence ?? 0.5));
	const claim = input.root_cause?.explanation ?? "the failure originates here";
	const command = input.command ?? "";
	const intent: Intent | undefined = input.test_name
		? {
				source: "test",
				statement: `Test '${input.test_name}' asserts the intended behavior`,
				location: input.test_name,
				conflicts: [],
			}
		: undefined;

	const modId = `${input.failure_id}:module`;
	const fileId = `${input.failure_id}:file`;
	const fnId = `${input.failure_id}:function`;
	const lineId = `${input.failure_id}:line`;

	hypotheses.push({
		id: modId,
		failure_id: input.failure_id,
		level: "module",
		statement: `The fault is in module '${moduleOf(primary.file)}'`,
		location: moduleOf(primary.file),
		prior: confidence,
		posterior: confidence,
		status: "open",
		...(intent ? { intent } : {}),
		probe: {
			kind: "read_slice",
			command: `failsafe diagnose ${input.failure_id}`,
			location: moduleOf(primary.file),
			watch: [],
			expected_if_true: "Application frames in the failure are confined to this module",
			expected_if_false: "The failing frames lead outside this module before the error",
		},
		observations: [],
	});

	hypotheses.push({
		id: fileId,
		failure_id: input.failure_id,
		parent_id: modId,
		level: "file",
		statement: `The fault is in '${primary.file}'`,
		location: primary.file,
		prior: confidence,
		posterior: confidence,
		status: "open",
		probe: {
			kind: "read_slice",
			command: `failsafe inspect source --file ${primary.file}`,
			location: primary.file,
			watch: [],
			expected_if_true: `The error's top application frame is in ${primary.file}`,
			expected_if_false: "The top application frame is in a different file",
		},
		observations: [],
	});

	if (primary.symbol) {
		hypotheses.push({
			id: fnId,
			failure_id: input.failure_id,
			parent_id: fileId,
			level: "function",
			statement: `The fault is in '${primary.symbol}': ${claim}`,
			location: `${primary.file}:${primary.line}`,
			prior: confidence,
			posterior: confidence,
			status: "open",
			probe: {
				kind: "assertion_probe",
				command: `failsafe debug ${input.failure_id} --break ${primary.file}:${primary.line}`,
				location: `${primary.file}:${primary.line}`,
				watch: primary.symbol ? [primary.symbol] : [],
				expected_if_true: `State on entry to ${primary.symbol} already violates the expectation`,
				expected_if_false: `${primary.symbol} receives valid state and the fault is upstream`,
			},
			observations: [],
		});
	}

	hypotheses.push({
		id: lineId,
		failure_id: input.failure_id,
		parent_id: primary.symbol ? fnId : fileId,
		level: "line",
		statement: `${primary.file}:${primary.line} is the divergence point: ${claim}`,
		location: `${primary.file}:${primary.line}`,
		prior: confidence,
		posterior: confidence,
		status: "open",
		probe: {
			kind: "debugger_breakpoint",
			command: `failsafe debug ${input.failure_id} --break ${primary.file}:${primary.line}`,
			location: `${primary.file}:${primary.line}`,
			watch: primary.symbol ? [primary.symbol] : [],
			expected_if_true: "The watched values are already wrong at this line",
			expected_if_false: "The watched values are correct here and the fault is elsewhere",
		},
		observations: [],
	});

	// Competing branch: the next distinct application frame.
	const alternate = (input.frames ?? []).find((f) => f.is_application && f.file !== primary.file);
	if (alternate) {
		hypotheses.push({
			id: `${input.failure_id}:alt-file`,
			failure_id: input.failure_id,
			parent_id: modId,
			level: "file",
			statement: `The fault is upstream in '${alternate.file}', which supplied the bad state`,
			location: alternate.file,
			prior: 1 - confidence,
			posterior: 1 - confidence,
			status: "open",
			probe: {
				kind: "debugger_breakpoint",
				command: command
					? `failsafe debug ${input.failure_id} --break ${alternate.file}:${alternate.line}`
					: `failsafe inspect source --file ${alternate.file}`,
				location: `${alternate.file}:${alternate.line}`,
				watch: alternate.function ? [alternate.function] : [],
				expected_if_true: `State is already wrong when it leaves ${alternate.file}`,
				expected_if_false: `${alternate.file} produces valid state; the fault is downstream`,
			},
			observations: [],
		});
	}

	return { schema_version: "0.1", failure_id: input.failure_id, hypotheses };
}

/** Structural checks a persisted tree must satisfy. */
export function validateTree(tree: HypothesisTree): string[] {
	const errors: string[] = [];
	const byId = new Map(tree.hypotheses.map((h) => [h.id, h]));
	for (const h of tree.hypotheses) {
		if (h.parent_id !== undefined) {
			const parent = byId.get(h.parent_id);
			if (!parent) {
				errors.push(`hypothesis '${h.id}' references missing parent '${h.parent_id}'`);
			} else if (levelRank(parent.level) >= levelRank(h.level)) {
				errors.push(
					`hypothesis '${h.id}' (${h.level}) is not finer-grained than its parent '${parent.id}' (${parent.level})`,
				);
			}
		}
		if (h.status === "abandoned" && !h.abandonment_reason) {
			errors.push(`abandoned hypothesis '${h.id}' has no abandonment_reason`);
		}
		if (h.status === "open" && !h.probe) {
			errors.push(`open hypothesis '${h.id}' has no probe: it is not falsifiable`);
		}
	}
	// Cycle detection: walking parents must terminate.
	for (const h of tree.hypotheses) {
		const seen = new Set<string>([h.id]);
		let cursor = h.parent_id;
		while (cursor !== undefined) {
			if (seen.has(cursor)) {
				errors.push(`hypothesis '${h.id}' is part of a parent cycle`);
				break;
			}
			seen.add(cursor);
			cursor = byId.get(cursor)?.parent_id;
		}
	}
	return errors;
}
