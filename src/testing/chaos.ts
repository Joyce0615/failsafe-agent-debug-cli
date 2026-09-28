/**
 * Chaos fixtures for partial telemetry, exporter outage, disk full, and
 * restarts (item 88).
 *
 * The tempting way to write these is to inject a failure and assert the system
 * survived. That tests the wrong thing. Under degradation the correct behaviour
 * is not "keep working" — it is **keep working, or fail loudly**. The dangerous
 * outcome is the third one: an exporter outage that becomes zero spans with no
 * error, so a dashboard shows a quiet, healthy-looking system that is in fact
 * blind. Every fixture here therefore pairs its injection with an expectation
 * about what must remain *observable*, and `assessResilience` distinguishes
 * `degraded_loudly` from `degraded_silently` as its central verdict.
 *
 * Two supporting rules:
 *
 * - **Loss is quantified, not merely detected.** A test that asserts "some data
 *   was lost" passes when everything was lost. The report carries counts and
 *   bytes so a test can bound the loss rather than acknowledge it.
 *
 * - **Every injector is reversible and bounded.** A fixture that can wedge a
 *   suite will eventually be deleted rather than fixed, so each scenario has an
 *   explicit `restore()` and a duration after which it stops on its own.
 *
 * Pure: the injectors wrap an in-memory sink. Nothing here touches a disk, a
 * socket, or a process.
 */

export const CHAOS_KINDS = [
	"partial_telemetry",
	"exporter_outage",
	"disk_full",
	"restart",
	"clock_jump",
	"slow_exporter",
] as const;
export type ChaosKind = (typeof CHAOS_KINDS)[number];

export type ChaosScenario = {
	kind: ChaosKind;
	description: string;
	/** When the condition begins, in the sink's own clock. */
	start_ms: number;
	/** How long it lasts. Bounded so a fixture cannot wedge a run. */
	duration_ms: number;
	/** Fraction dropped, for partial conditions. */
	drop_fraction?: number;
	/** Bytes the sink can still accept, for `disk_full`. */
	remaining_bytes?: number;
	/** Added latency per item, for `slow_exporter`. */
	added_latency_ms?: number;
	/** Milliseconds the clock jumps, for `clock_jump`. */
	clock_delta_ms?: number;
};

/** What a component under test must remain able to say when degraded. */
export const OBSERVABILITY_EXPECTATIONS: Record<ChaosKind, string> = {
	partial_telemetry:
		"the count of dropped items must be reported; a partial view that does not say it is partial is worse than no view",
	exporter_outage:
		"the failure to export must surface as an error, not as an absence of spans that reads as a quiet system",
	disk_full:
		"the write failure must be raised to the caller; silently discarding a record leaves a gap nobody can date",
	restart:
		"the restart must be visible in the output; a counter that resets without saying so looks like a workload that stopped",
	clock_jump:
		"the discontinuity must be recorded; timestamps that jump without explanation are read as latency",
	slow_exporter:
		"the queue depth or latency must be observable before the buffer overflows, not after",
};

export type SinkItem = { id: string; bytes: number; ts_ms: number };

export type SinkOutcome =
	| { ok: true; recorded_ts_ms: number }
	/** Rejected with a reason the caller can act on. This is the good failure. */
	| { ok: false; error: string }
	/** Silently discarded: accepted by the interface and never stored. */
	| { ok: true; recorded_ts_ms: number; silently_dropped: true };

export type Sink = {
	accept(item: SinkItem): SinkOutcome;
	/** Items actually retained. */
	stored(): SinkItem[];
};

/** A sink that always works. The control arm. */
export function healthySink(): Sink {
	const items: SinkItem[] = [];
	return {
		accept(item) {
			items.push(item);
			return { ok: true, recorded_ts_ms: item.ts_ms };
		},
		stored: () => [...items],
	};
}

export type ChaosHandle = {
	sink: Sink;
	scenario: ChaosScenario;
	/** Ends the condition early. Idempotent. */
	restore(): void;
	/** Whether the condition is currently in effect at `ts_ms`. */
	active(ts_ms: number): boolean;
};

/**
 * Wrap a sink so it exhibits the scenario.
 *
 * Each condition is modelled with the behaviour that actually causes trouble,
 * including — deliberately — the silent variants. A chaos library that only
 * produces well-behaved errors cannot find the bug this module exists to find.
 */
export function injectChaos(sink: Sink, scenario: ChaosScenario): ChaosHandle {
	let restored = false;
	const active = (ts: number) =>
		!restored && ts >= scenario.start_ms && ts < scenario.start_ms + scenario.duration_ms;

	let remaining = scenario.remaining_bytes ?? Number.POSITIVE_INFINITY;
	let seen = 0;

	const wrapped: Sink = {
		accept(item) {
			if (!active(item.ts_ms)) return sink.accept(item);
			seen++;

			switch (scenario.kind) {
				case "partial_telemetry": {
					// Deterministic thinning: every Nth item survives. Silent by
					// construction, because that is what a sampling misconfiguration
					// looks like from inside the process.
					const keep = Math.max(
						1,
						Math.round(1 / Math.max(1e-6, 1 - (scenario.drop_fraction ?? 0.5))),
					);
					if (seen % keep !== 0) {
						return { ok: true, recorded_ts_ms: item.ts_ms, silently_dropped: true };
					}
					return sink.accept(item);
				}
				case "exporter_outage":
					return { ok: false, error: "exporter unreachable" };
				case "disk_full": {
					if (item.bytes > remaining)
						return { ok: false, error: "ENOSPC: no space left on device" };
					remaining -= item.bytes;
					return sink.accept(item);
				}
				case "restart":
					// A restart loses whatever was buffered and accepts the item into
					// a fresh process, which is why the counter reset is the only
					// evidence it happened.
					return { ok: false, error: "process restarted; in-flight items were lost" };
				case "clock_jump": {
					const shifted = { ...item, ts_ms: item.ts_ms + (scenario.clock_delta_ms ?? 0) };
					return sink.accept(shifted);
				}
				case "slow_exporter": {
					const delayed = { ...item, ts_ms: item.ts_ms + (scenario.added_latency_ms ?? 0) };
					return sink.accept(delayed);
				}
			}
		},
		stored: () => sink.stored(),
	};

	return {
		sink: wrapped,
		scenario,
		restore() {
			restored = true;
		},
		active,
	};
}

export type ObservedBehaviour = {
	offered: number;
	accepted: number;
	/** Rejections with a reason. The good kind of failure. */
	errors_surfaced: number;
	/** Accepted by the interface and never stored. The dangerous kind. */
	silent_drops: number;
	bytes_offered: number;
	bytes_stored: number;
	/** Items whose recorded timestamp differs from the one supplied. */
	timestamps_altered: number;
};

/** Run items through a sink and record exactly what happened to each. */
export function observe(sink: Sink, items: SinkItem[]): ObservedBehaviour {
	let accepted = 0;
	let errors = 0;
	let silent = 0;
	let altered = 0;

	for (const item of items) {
		const outcome = sink.accept(item);
		if (!outcome.ok) {
			errors++;
			continue;
		}
		if ("silently_dropped" in outcome && outcome.silently_dropped) {
			silent++;
			continue;
		}
		accepted++;
		if (outcome.recorded_ts_ms !== item.ts_ms) altered++;
	}

	const stored = sink.stored();
	return {
		offered: items.length,
		accepted,
		errors_surfaced: errors,
		silent_drops: silent,
		bytes_offered: items.reduce((sum, i) => sum + i.bytes, 0),
		bytes_stored: stored.reduce((sum, i) => sum + i.bytes, 0),
		timestamps_altered: altered,
	};
}

export const RESILIENCE_VERDICTS = [
	"unaffected",
	"degraded_loudly",
	"degraded_silently",
	"total_silent_loss",
] as const;
export type ResilienceVerdict = (typeof RESILIENCE_VERDICTS)[number];

export type ResilienceReport = {
	scenario: ChaosKind;
	verdict: ResilienceVerdict;
	observed: ObservedBehaviour;
	/** Fraction of offered items that did not reach storage. */
	loss_fraction: number;
	/** Fraction of the loss that produced no error at all. */
	silent_fraction: number;
	expectation: string;
	detail: string;
	/** True when the behaviour met the observability expectation. */
	acceptable: boolean;
};

/**
 * Judge how a component behaved under chaos.
 *
 * The verdict that matters is `degraded_silently`. Losing data under an
 * exporter outage is expected and fine; losing it without saying so produces a
 * dashboard that looks healthy and is blind, and no amount of downstream
 * alerting can recover from evidence that was never emitted. `total_silent_loss`
 * is separated out because a complete silent loss is not a worse version of a
 * partial one — it is the case where nothing at all indicates a problem.
 */
export function assessResilience(
	scenario: ChaosScenario,
	observed: ObservedBehaviour,
): ResilienceReport {
	const lost = observed.offered - observed.accepted;
	const lossFraction = observed.offered > 0 ? lost / observed.offered : 0;
	const silentFraction = lost > 0 ? observed.silent_drops / lost : 0;

	let verdict: ResilienceVerdict;
	if (lost === 0 && observed.timestamps_altered === 0) verdict = "unaffected";
	else if (observed.silent_drops === 0) verdict = "degraded_loudly";
	else if (observed.silent_drops === observed.offered) verdict = "total_silent_loss";
	else verdict = "degraded_silently";

	const acceptable = verdict === "unaffected" || verdict === "degraded_loudly";

	return {
		scenario: scenario.kind,
		verdict,
		observed,
		loss_fraction: lossFraction,
		silent_fraction: silentFraction,
		expectation: OBSERVABILITY_EXPECTATIONS[scenario.kind],
		acceptable,
		detail:
			verdict === "unaffected"
				? "every item was stored unchanged"
				: verdict === "degraded_loudly"
					? `${lost} of ${observed.offered} item(s) were lost and every loss produced an error the caller can act on`
					: verdict === "total_silent_loss"
						? `all ${observed.offered} item(s) vanished with no error at all; from outside, this is indistinguishable from a system with nothing to report`
						: `${observed.silent_drops} of ${lost} lost item(s) produced no error; the remaining view is partial and does not say so`,
	};
}

export type ChaosSuiteResult = {
	reports: ResilienceReport[];
	/** Scenarios where the component degraded silently. */
	silent_failures: ChaosKind[];
	/** Scenarios not exercised at all. */
	untested: ChaosKind[];
	caveats: string[];
};

/**
 * Run a set of scenarios against a sink factory and summarize.
 *
 * `untested` is reported because a chaos suite covering four of six conditions
 * establishes nothing about the other two, and a green run over a partial suite
 * reads exactly like a green run over a complete one.
 */
export function runChaosSuite(
	scenarios: ChaosScenario[],
	items: SinkItem[],
	makeSink: () => Sink = healthySink,
): ChaosSuiteResult {
	const reports = scenarios.map((scenario) => {
		const handle = injectChaos(makeSink(), scenario);
		const observed = observe(handle.sink, items);
		handle.restore();
		return assessResilience(scenario, observed);
	});

	const tested = new Set(scenarios.map((s) => s.kind));
	const untested = CHAOS_KINDS.filter((kind) => !tested.has(kind));
	const silent = reports.filter((r) => !r.acceptable).map((r) => r.scenario);

	const caveats: string[] = [];
	if (untested.length > 0) {
		caveats.push(
			`${untested.length} condition(s) were not exercised (${untested.join(", ")}); this run establishes nothing about them and reads identically to a complete one`,
		);
	}
	if (silent.length > 0) {
		caveats.push(
			`${silent.length} condition(s) produced silent degradation (${silent.join(", ")}): data was lost with no error, which downstream alerting cannot recover from because the evidence was never emitted`,
		);
	}
	if (items.length === 0) {
		caveats.push("no items were offered; every scenario passed vacuously");
	}

	return { reports, silent_failures: silent, untested, caveats };
}

/** A standard item stream for chaos runs. Deterministic. */
export function chaosItems(count: number, startMs = 1000, bytes = 100): SinkItem[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `item-${i}`,
		bytes,
		ts_ms: startMs + i * 10,
	}));
}
