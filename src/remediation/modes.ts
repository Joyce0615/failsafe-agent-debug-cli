/**
 * Rollback, feature-disable, retry, and traffic-shift recommendation modes
 * (item 76).
 *
 * These four are the standard mitigations, and recommending them is easy to do
 * badly in three specific ways that this module is organized around.
 *
 * 1. **Preconditions are verified, not assumed.** Every one of the four has a
 *    condition under which it silently does nothing while looking like a fix:
 *    a rollback to a version that no longer builds; disabling a flag that does
 *    not gate the failing path; a retry against a deterministic failure; a
 *    traffic shift to a region with no spare capacity. Each of those produces a
 *    green "remediation applied" and an unchanged incident, and the time lost
 *    is worse than the time not spent, because the team now believes it tried
 *    something. `evaluateMode` refuses a mode whose preconditions are unmet and
 *    names the unmet one.
 *
 * 2. **A mitigation is not a fix.** Rolling back removes the symptom and leaves
 *    the bug, in a codebase where someone will shortly re-merge it. Every
 *    recommendation carries `residual_work` stating what is still outstanding,
 *    and there is no mode for which that field is empty.
 *
 * 3. **Some mitigations make some failures worse.** Retrying a resource
 *    exhaustion multiplies the load that caused it; shifting traffic away from
 *    a failing shard onto a shared dependency moves the overload rather than
 *    relieving it. `CONTRAINDICATIONS` encodes those pairings and they are hard
 *    blocks, not warnings.
 *
 * Ranking is by time-to-effect within reversibility tiers and never by an
 * overall "goodness" score, because a slow reversible action and a fast
 * irreversible one are a genuine trade-off that belongs to whoever is on call,
 * not to a weighting chosen here.
 *
 * Pure: recommends, never executes.
 */

export const REMEDIATION_MODES = ["rollback", "feature_disable", "retry", "traffic_shift"] as const;
export type RemediationMode = (typeof REMEDIATION_MODES)[number];

/** Cause classes a remediation may or may not be appropriate for. */
export const CAUSE_CLASSES = [
	"regression",
	"resource_exhaustion",
	"transient_dependency",
	"config_drift",
	"data_corruption",
	"capacity",
	"unknown",
] as const;
export type CauseClass = (typeof CAUSE_CLASSES)[number];

/**
 * Mode/cause pairings that make things worse, with the mechanism.
 *
 * Hard blocks rather than warnings. A warning on a page at 3am is read as
 * "proceed with care" and the retry storm happens anyway.
 */
export const CONTRAINDICATIONS: Array<{
	mode: RemediationMode;
	cause: CauseClass;
	mechanism: string;
}> = [
	{
		mode: "retry",
		cause: "resource_exhaustion",
		mechanism: "retrying multiplies the load that caused the exhaustion",
	},
	{
		mode: "retry",
		cause: "capacity",
		mechanism: "retrying adds demand to a system already at its limit",
	},
	{
		mode: "retry",
		cause: "regression",
		mechanism:
			"a deterministic regression fails identically on every attempt; retrying only spends the budget",
	},
	{
		mode: "retry",
		cause: "data_corruption",
		mechanism: "retrying against corrupt data can compound the corruption rather than reveal it",
	},
	{
		mode: "traffic_shift",
		cause: "capacity",
		mechanism:
			"shifting traffic relocates the overload unless the destination has genuine spare capacity",
	},
	{
		mode: "rollback",
		cause: "data_corruption",
		mechanism:
			"rolling back code does not un-write corrupt data, and an older writer may not understand the new data",
	},
];

/** Facts about the environment that preconditions are checked against. */
export type RemediationContext = {
	cause: CauseClass;
	/** Whether the failure has been observed to succeed on a retry. */
	failure_is_transient?: boolean;
	/** Previous release, when one is still deployable. */
	previous_version?: string;
	previous_version_deployable?: boolean;
	/** Flag gating the failing code path, when one exists. */
	gating_flag?: string;
	/** Whether that flag actually covers the failing path. */
	flag_covers_failure?: boolean;
	/** Spare capacity elsewhere, as a fraction of current load. */
	spare_capacity_fraction?: number;
	/** Whether the failure is confined to some shards/regions. */
	failure_is_localized?: boolean;
	/** Whether writes since the bad deploy would be lost by a rollback. */
	rollback_loses_writes?: boolean;
};

export type Precondition = {
	name: string;
	met: boolean;
	detail: string;
};

export type Reversibility = "reversible" | "reversible_with_loss" | "irreversible";

export type ModeEvaluation = {
	mode: RemediationMode;
	applicable: boolean;
	preconditions: Precondition[];
	/** Preconditions that failed, for a quick read. */
	unmet: string[];
	contraindication?: string;
	/** Expected time until the symptom changes, in ms. */
	time_to_effect_ms: number;
	reversibility: Reversibility;
	/** Fraction of traffic or users affected by *performing* the remediation. */
	blast_radius: number;
	/** What remains to be done after this. Never empty. */
	residual_work: string[];
};

const REVERSIBILITY_RANK: Record<Reversibility, number> = {
	reversible: 0,
	reversible_with_loss: 1,
	irreversible: 2,
};

/**
 * Evaluate one mode against the context.
 *
 * A contraindication short-circuits: the preconditions of a mode that would
 * make things worse are irrelevant, and evaluating them invites someone to
 * satisfy them.
 */
export function evaluateMode(mode: RemediationMode, context: RemediationContext): ModeEvaluation {
	const contra = CONTRAINDICATIONS.find((c) => c.mode === mode && c.cause === context.cause);

	const base = {
		mode,
		preconditions: [] as Precondition[],
		unmet: [] as string[],
		...(contra ? { contraindication: contra.mechanism } : {}),
	};

	if (contra) {
		return {
			...base,
			applicable: false,
			time_to_effect_ms: 0,
			reversibility: "reversible",
			blast_radius: 0,
			residual_work: [`find a remediation appropriate to '${context.cause}'`],
		};
	}

	const preconditions: Precondition[] = [];
	let timeToEffect = 0;
	let reversibility: Reversibility = "reversible";
	let blastRadius = 0;
	let residual: string[] = [];

	switch (mode) {
		case "rollback":
			preconditions.push(
				{
					name: "previous_version_exists",
					met: Boolean(context.previous_version),
					detail: context.previous_version
						? `previous version '${context.previous_version}' is recorded`
						: "no previous version is recorded to roll back to",
				},
				{
					name: "previous_version_deployable",
					met: context.previous_version_deployable === true,
					detail:
						context.previous_version_deployable === true
							? "the previous version is still deployable"
							: "the previous version is not known to be deployable; rolling back to something that will not start is a longer outage, not a shorter one",
				},
			);
			timeToEffect = 5 * 60_000;
			reversibility =
				context.rollback_loses_writes === true ? "reversible_with_loss" : "reversible";
			blastRadius = 1;
			residual = [
				"the defect is still in the codebase and will be re-merged unless it is fixed or reverted at source",
				"any data written by the newer version may not be readable by the older one",
			];
			break;

		case "feature_disable":
			preconditions.push(
				{
					name: "gating_flag_exists",
					met: Boolean(context.gating_flag),
					detail: context.gating_flag
						? `flag '${context.gating_flag}' is available`
						: "no flag gates the failing path",
				},
				{
					name: "flag_covers_failure",
					met: context.flag_covers_failure === true,
					detail:
						context.flag_covers_failure === true
							? "the flag is confirmed to gate the failing code path"
							: "the flag is not confirmed to gate the failing path; disabling it would look like a remediation and change nothing",
				},
			);
			timeToEffect = 30_000;
			reversibility = "reversible";
			// Disabling a feature affects everyone using it, not everyone failing.
			blastRadius = 0.5;
			residual = [
				"the feature is off for every user, including those it was working for",
				"the defect behind the flag is unfixed",
			];
			break;

		case "retry":
			preconditions.push({
				name: "failure_is_transient",
				met: context.failure_is_transient === true,
				detail:
					context.failure_is_transient === true
						? "the failure has been observed to succeed on a subsequent attempt"
						: "the failure is not known to be transient; retrying a deterministic failure spends budget and changes nothing",
			});
			timeToEffect = 5_000;
			reversibility = "reversible";
			blastRadius = 0;
			residual = [
				"the underlying flakiness is unaddressed and will recur",
				"retries hide the failure rate from every dashboard that counts final outcomes",
			];
			break;

		case "traffic_shift":
			preconditions.push(
				{
					name: "failure_is_localized",
					met: context.failure_is_localized === true,
					detail:
						context.failure_is_localized === true
							? "the failure is confined to part of the fleet"
							: "the failure is not localized; shifting traffic moves users from one failing place to another",
				},
				{
					name: "spare_capacity",
					met: (context.spare_capacity_fraction ?? 0) >= 1,
					detail:
						(context.spare_capacity_fraction ?? 0) >= 1
							? `destination has ${((context.spare_capacity_fraction ?? 0) * 100).toFixed(0)}% of the shifted load available`
							: `destination has only ${((context.spare_capacity_fraction ?? 0) * 100).toFixed(0)}% of the shifted load available; the shift would overload it`,
				},
			);
			timeToEffect = 60_000;
			reversibility = "reversible";
			blastRadius = 0.3;
			residual = [
				"the failing partition is still failing and is now unobserved by real traffic",
				"the destination is carrying load it was not provisioned for",
			];
			break;
	}

	const unmet = preconditions.filter((p) => !p.met).map((p) => p.name);
	return {
		...base,
		preconditions,
		unmet,
		applicable: unmet.length === 0,
		time_to_effect_ms: timeToEffect,
		reversibility,
		blast_radius: blastRadius,
		residual_work: residual,
	};
}

export type Recommendation = {
	evaluations: ModeEvaluation[];
	/** Applicable modes, ranked. Empty when nothing applies. */
	recommended: ModeEvaluation[];
	/** Modes ruled out, with why. */
	rejected: Array<{ mode: RemediationMode; reason: string }>;
	caveats: string[];
};

/**
 * Evaluate all four modes and rank the applicable ones.
 *
 * Ranking is lexicographic on (reversibility, time to effect, blast radius) and
 * deliberately not a weighted score. A slow reversible action and a fast
 * irreversible one are a real trade-off, and collapsing them into one number
 * makes a decision that belongs to whoever is carrying the pager.
 */
export function recommend(context: RemediationContext): Recommendation {
	const evaluations = REMEDIATION_MODES.map((mode) => evaluateMode(mode, context));
	const applicable = evaluations.filter((e) => e.applicable);

	const recommended = [...applicable].sort(
		(a, b) =>
			REVERSIBILITY_RANK[a.reversibility] - REVERSIBILITY_RANK[b.reversibility] ||
			a.time_to_effect_ms - b.time_to_effect_ms ||
			a.blast_radius - b.blast_radius ||
			a.mode.localeCompare(b.mode),
	);

	const rejected = evaluations
		.filter((e) => !e.applicable)
		.map((e) => ({
			mode: e.mode,
			reason: e.contraindication
				? `contraindicated for '${context.cause}': ${e.contraindication}`
				: `preconditions unmet: ${e.preconditions
						.filter((p) => !p.met)
						.map((p) => p.detail)
						.join("; ")}`,
		}));

	const caveats: string[] = [
		"every mode here mitigates a symptom; none of them fixes a defect, and each carries its own residual work",
	];
	if (recommended.length === 0) {
		caveats.push(
			"no mode is applicable: either the preconditions are genuinely unmet or the context is incomplete, and the two are worth telling apart before concluding nothing can be done",
		);
	}
	if (context.cause === "unknown") {
		caveats.push(
			"the cause class is 'unknown', so no contraindication could be checked; a mitigation chosen without knowing what is wrong can make it worse",
		);
	}
	const irreversible = recommended.filter((r) => r.reversibility !== "reversible");
	if (irreversible.length > 0) {
		caveats.push(
			`${irreversible.length} recommended mode(s) are not fully reversible; ranking places them last but the choice is a trade-off, not a default`,
		);
	}

	return { evaluations, recommended, rejected, caveats };
}

/**
 * A short rendering suitable for an incident channel.
 *
 * Residual work is printed under every recommendation rather than summarized,
 * because the failure this module exists to prevent is somebody reading
 * "rollback: applicable" and closing the incident.
 */
export function renderRecommendation(recommendation: Recommendation): string {
	const lines: string[] = [];
	for (const [i, mode] of recommendation.recommended.entries()) {
		lines.push(
			`${i + 1}. ${mode.mode} — effect in ~${Math.round(mode.time_to_effect_ms / 1000)}s, ${mode.reversibility}, blast radius ${mode.blast_radius}`,
		);
		for (const work of mode.residual_work) lines.push(`     still outstanding: ${work}`);
	}
	for (const rejection of recommendation.rejected) {
		lines.push(`   RULED OUT ${rejection.mode}: ${rejection.reason}`);
	}
	for (const caveat of recommendation.caveats) lines.push(`   note: ${caveat}`);
	return lines.join("\n");
}
