/**
 * Machine-readable incident export: SARIF, JUnit, incident JSON, and
 * OpenTelemetry links (item 92).
 *
 * Exporting to a standard format is a lossy translation, and the loss is always
 * specific: SARIF has no place to put a confidence or a causal chain, JUnit has
 * no severity beyond pass/fail/error/skip and no structured location at all, a
 * deep link asserts that a trace still exists somewhere. A converter that emits
 * a well-formed document and says nothing about what it dropped produces a file
 * that looks complete and is not.
 *
 * So every exporter here returns its output *and* a `lost` list naming what the
 * target format cannot represent. That list is the part worth having: it is
 * what stops somebody concluding, from a green SARIF upload, that the
 * confidence and the alternatives were considered by whatever consumed it.
 *
 * Two further concerns:
 *
 * - **Escaping is not optional.** A failure message containing `]]>` or
 *   `</testcase>` will corrupt a JUnit file, and the corruption looks like a
 *   parser bug in whatever reads it three systems downstream. Hostile content
 *   is escaped and the escaping is tested with hostile content, not with
 *   ampersands.
 *
 * - **A link is not evidence.** An OpenTelemetry deep link is a claim that a
 *   trace exists at a URL, and item 65's retention will eventually make that
 *   false. Links carry the retention window they were minted under so a dead
 *   link is diagnosable rather than merely broken.
 */

export type IncidentLocation = {
	file: string;
	line?: number;
	column?: number;
};

export type IncidentFinding = {
	id: string;
	/** Stable identifier for the class of problem, used as a SARIF rule id. */
	rule_id: string;
	title: string;
	message: string;
	severity: "error" | "warning" | "note";
	location?: IncidentLocation;
	/** 0..1. No target format has anywhere to put this. */
	confidence?: number;
	/** Evidence ids supporting the finding. */
	evidence: string[];
	/** Alternative explanations that were not ruled out. */
	alternatives?: string[];
	/** Test name, when the finding came from a test failure. */
	test_name?: string;
	/** Milliseconds the producing check took. */
	duration_ms?: number;
};

export type IncidentReport = {
	incident_id: string;
	created_at_ms: number;
	tool: { name: string; version: string };
	findings: IncidentFinding[];
	/** Trace ids associated with the incident. */
	trace_ids: string[];
};

export type ExportResult<T> = {
	content: T;
	/** What the target format cannot represent. Never empty for a lossy format. */
	lost: string[];
	format: string;
};

/** XML text escaping, applied to every interpolated value without exception. */
export function escapeXml(value: string): string {
	return (
		value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;")
			// Control characters other than tab/newline/carriage return are illegal
			// in XML 1.0 at any escaping level, so they are removed rather than
			// encoded — an encoded illegal character is still illegal. Matching
			// them literally is the point of this pass, so the lint rule against
			// control characters in a regex is suppressed here specifically.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing XML-illegal control characters is this function's job.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
	);
}

export type SarifLevel = "error" | "warning" | "note";

export type SarifDocument = {
	$schema: string;
	version: "2.1.0";
	runs: Array<{
		tool: { driver: { name: string; version: string; rules: Array<{ id: string; name: string }> } };
		results: Array<{
			ruleId: string;
			level: SarifLevel;
			message: { text: string };
			locations: Array<{
				physicalLocation: {
					artifactLocation: { uri: string };
					region?: { startLine: number; startColumn?: number };
				};
			}>;
			properties?: Record<string, unknown>;
		}>;
	}>;
};

export const SARIF_SCHEMA =
	"https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/**
 * Export to SARIF 2.1.0.
 *
 * Confidence, alternatives, and evidence go into `properties`, which is the
 * only place SARIF has for them — and which most consumers ignore. That is
 * reported as a loss rather than treated as representation, because a value
 * that survives into a field nobody reads has not survived in any useful sense.
 */
export function toSarif(report: IncidentReport): ExportResult<SarifDocument> {
	const rules = [...new Map(report.findings.map((f) => [f.rule_id, f])).values()].map((f) => ({
		id: f.rule_id,
		name: f.title,
	}));

	const document: SarifDocument = {
		$schema: SARIF_SCHEMA,
		version: "2.1.0",
		runs: [
			{
				tool: { driver: { name: report.tool.name, version: report.tool.version, rules } },
				results: report.findings.map((finding) => ({
					ruleId: finding.rule_id,
					level: finding.severity,
					message: { text: finding.message },
					locations: finding.location
						? [
								{
									physicalLocation: {
										artifactLocation: { uri: finding.location.file },
										...(finding.location.line !== undefined
											? {
													region: {
														startLine: finding.location.line,
														...(finding.location.column !== undefined
															? { startColumn: finding.location.column }
															: {}),
													},
												}
											: {}),
									},
								},
							]
						: [],
					properties: {
						confidence: finding.confidence,
						evidence: finding.evidence,
						alternatives: finding.alternatives ?? [],
					},
				})),
			},
		],
	};

	const lost: string[] = [
		"SARIF has no confidence field; it is carried in `properties` and most consumers ignore properties entirely",
		"SARIF has no representation of a causal chain or of competing hypotheses; alternatives are likewise in `properties`",
	];
	if (report.findings.some((f) => !f.location)) {
		lost.push(
			"findings with no source location produce a result with an empty `locations` array, which some SARIF consumers reject and others silently place at the repository root",
		);
	}
	if (report.trace_ids.length > 0) {
		lost.push(
			`${report.trace_ids.length} trace id(s) have no SARIF representation and are not included`,
		);
	}

	return { content: document, lost, format: "sarif-2.1.0" };
}

/**
 * Export to JUnit XML.
 *
 * The lossiest of the four by a distance: JUnit's model is a test that passed,
 * failed, errored, or was skipped, with a free-text body. Everything else —
 * severity gradations, structured locations, confidence, evidence — becomes
 * prose inside the failure element, where it is visible to a person and opaque
 * to a machine.
 */
export function toJUnit(report: IncidentReport): ExportResult<string> {
	const failures = report.findings.filter((f) => f.severity === "error").length;
	const totalTime = report.findings.reduce((sum, f) => sum + (f.duration_ms ?? 0), 0) / 1000;

	const cases = report.findings
		.map((finding) => {
			const name = escapeXml(finding.test_name ?? finding.title);
			const classname = escapeXml(finding.location?.file ?? finding.rule_id);
			const time = ((finding.duration_ms ?? 0) / 1000).toFixed(3);
			const body = [
				finding.message,
				finding.location
					? `at ${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""}`
					: "no source location",
				finding.confidence !== undefined ? `confidence: ${finding.confidence}` : "",
				finding.evidence.length > 0 ? `evidence: ${finding.evidence.join(", ")}` : "",
				finding.alternatives?.length ? `alternatives: ${finding.alternatives.join(", ")}` : "",
			]
				.filter((line) => line.length > 0)
				.join("\n");

			if (finding.severity !== "error") {
				return `    <testcase name="${name}" classname="${classname}" time="${time}">\n      <system-out>${escapeXml(body)}</system-out>\n    </testcase>`;
			}
			return `    <testcase name="${name}" classname="${classname}" time="${time}">\n      <failure message="${escapeXml(finding.title)}" type="${escapeXml(finding.rule_id)}">${escapeXml(body)}</failure>\n    </testcase>`;
		})
		.join("\n");

	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuites name="${escapeXml(report.incident_id)}" tests="${report.findings.length}" failures="${failures}" time="${totalTime.toFixed(3)}">`,
		`  <testsuite name="${escapeXml(report.tool.name)}" tests="${report.findings.length}" failures="${failures}" time="${totalTime.toFixed(3)}">`,
		cases,
		"  </testsuite>",
		"</testsuites>",
	]
		.filter((line) => line.length > 0)
		.join("\n");

	return {
		content: xml,
		lost: [
			"JUnit has four outcomes and no severity gradation; `warning` and `note` findings are emitted as passing test cases with the detail in system-out, which most dashboards do not display",
			"JUnit has no structured source location; the file is placed in `classname` and the line only in the message text",
			"confidence, evidence, and alternatives are rendered as prose inside the failure body: visible to a person, opaque to a machine",
		],
		format: "junit-xml",
	};
}

export type TraceLinkTemplate = {
	/** e.g. `https://tempo.example/trace/{trace_id}`. */
	url_template: string;
	backend: string;
	/** How long the backend retains a trace. Links outlive the data otherwise. */
	retention_ms: number;
};

export type TraceLink = {
	trace_id: string;
	url: string;
	backend: string;
	/** When this link stops being expected to resolve. */
	expires_at_ms: number;
	/** True when the link was already expired at generation time. */
	already_expired: boolean;
};

/**
 * Build OpenTelemetry deep links.
 *
 * Each link carries the moment it stops being expected to resolve. A report
 * containing a dead link is otherwise indistinguishable from one containing a
 * live link to a backend that is merely down, and the two call for entirely
 * different responses.
 */
export function toTraceLinks(
	report: IncidentReport,
	template: TraceLinkTemplate,
	nowMs: number,
): ExportResult<TraceLink[]> {
	const links = report.trace_ids.map((traceId) => {
		const expires = report.created_at_ms + template.retention_ms;
		return {
			trace_id: traceId,
			url: template.url_template.replace("{trace_id}", encodeURIComponent(traceId)),
			backend: template.backend,
			expires_at_ms: expires,
			already_expired: nowMs >= expires,
		};
	});

	const lost: string[] = [
		"a link asserts that a trace exists at a URL; nothing here verifies that it does, and the backend's retention will eventually make it false",
	];
	const expired = links.filter((l) => l.already_expired);
	if (expired.length > 0) {
		lost.push(
			`${expired.length} link(s) are already past the backend's ${Math.round(template.retention_ms / 86_400_000)}-day retention and are expected to be dead`,
		);
	}
	if (!template.url_template.includes("{trace_id}")) {
		lost.push(
			"the URL template contains no `{trace_id}` placeholder, so every link points at the same page",
		);
	}

	return { content: links, lost, format: "otel-links" };
}

export type IncidentJson = {
	schema: "failsafe.incident/1";
	incident_id: string;
	created_at_ms: number;
	tool: IncidentReport["tool"];
	findings: IncidentFinding[];
	trace_ids: string[];
};

/**
 * The lossless format.
 *
 * Exists so that the other three have something to be lossy *relative to*. A
 * pipeline that only emits SARIF has quietly decided that confidence and
 * alternatives are not worth keeping; emitting this alongside makes that a
 * choice rather than a consequence.
 */
export function toIncidentJson(report: IncidentReport): ExportResult<IncidentJson> {
	return {
		content: {
			schema: "failsafe.incident/1",
			incident_id: report.incident_id,
			created_at_ms: report.created_at_ms,
			tool: report.tool,
			findings: report.findings,
			trace_ids: report.trace_ids,
		},
		lost: [],
		format: "failsafe.incident/1",
	};
}

export type ExportBundle = {
	sarif: ExportResult<SarifDocument>;
	junit: ExportResult<string>;
	incident: ExportResult<IncidentJson>;
	links?: ExportResult<TraceLink[]>;
	/** Everything lost across every lossy format, attributed. */
	losses: Array<{ format: string; lost: string }>;
	caveats: string[];
};

/**
 * Export every format at once.
 *
 * The aggregated `losses` list is the reason to call this rather than the
 * individual exporters: it makes visible, in one place, that publishing only
 * SARIF discards the confidence and publishing only JUnit discards nearly
 * everything.
 */
export function exportAll(
	report: IncidentReport,
	options: { links?: TraceLinkTemplate; now_ms?: number } = {},
): ExportBundle {
	const sarif = toSarif(report);
	const junit = toJUnit(report);
	const incident = toIncidentJson(report);
	const links = options.links
		? toTraceLinks(report, options.links, options.now_ms ?? Date.now())
		: undefined;

	const losses = [sarif, junit, ...(links ? [links] : [])].flatMap((result) =>
		result.lost.map((lost) => ({ format: result.format, lost })),
	);

	const caveats: string[] = [
		`the ${incident.format} export is the only lossless one; the others discard the fields listed in 'losses'`,
	];
	if (!options.links) {
		caveats.push(
			"no trace-link template was supplied, so trace ids appear only in the incident JSON",
		);
	}
	if (report.findings.length === 0) {
		caveats.push(
			"the report has no findings; every export is a well-formed document describing nothing, which a CI gate will read as success",
		);
	}

	return { sarif, junit, incident, ...(links ? { links } : {}), losses, caveats };
}
