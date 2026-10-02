import { describe, expect, test } from "bun:test";
import {
	type IncidentFinding,
	type IncidentReport,
	SARIF_SCHEMA,
	escapeXml,
	exportAll,
	toIncidentJson,
	toJUnit,
	toSarif,
	toTraceLinks,
} from "../../src/export/reports.js";

const NOW = 1_700_000_000_000;

function finding(overrides: Partial<IncidentFinding> = {}): IncidentFinding {
	return {
		id: "f1",
		rule_id: "missing-key",
		title: "KeyError on payload",
		message: "the payload lacks an 'email' key",
		severity: "error",
		location: { file: "src/handler.py", line: 42, column: 9 },
		confidence: 0.82,
		evidence: ["e1", "e2"],
		alternatives: ["upstream schema change"],
		duration_ms: 1500,
		...overrides,
	};
}

function report(overrides: Partial<IncidentReport> = {}): IncidentReport {
	return {
		incident_id: "inc-1",
		created_at_ms: NOW,
		tool: { name: "failsafe", version: "0.1.0" },
		findings: [finding()],
		trace_ids: ["4bf92f3577b34da6a3ce929d0e0e4736"],
		...overrides,
	};
}

describe("SARIF", () => {
	test("the document is well formed and carries the location", () => {
		const { content } = toSarif(report());
		expect(content.version).toBe("2.1.0");
		expect(content.$schema).toBe(SARIF_SCHEMA);
		const result = content.runs[0].results[0];
		expect(result.ruleId).toBe("missing-key");
		expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe("src/handler.py");
		expect(result.locations[0].physicalLocation.region?.startLine).toBe(42);
	});

	test("rules are deduplicated across findings", () => {
		const { content } = toSarif(
			report({ findings: [finding(), finding({ id: "f2" })] }),
		);
		expect(content.runs[0].tool.driver.rules).toHaveLength(1);
		expect(content.runs[0].results).toHaveLength(2);
	});

	test("confidence surviving only into properties is reported as a loss", () => {
		const { content, lost } = toSarif(report());
		expect(content.runs[0].results[0].properties?.confidence).toBe(0.82);
		expect(lost.some((l) => l.includes("most consumers ignore properties"))).toBe(true);
	});

	test("a finding with no location produces an empty locations array and says what that means", () => {
		const { content, lost } = toSarif(
			report({ findings: [finding({ location: undefined })] }),
		);
		expect(content.runs[0].results[0].locations).toEqual([]);
		expect(lost.some((l) => l.includes("silently place at the repository root"))).toBe(true);
	});

	test("trace ids are dropped and the drop is named", () => {
		expect(toSarif(report()).lost.some((l) => l.includes("trace id"))).toBe(true);
	});

	test("severity maps straight through to the SARIF level", () => {
		const { content } = toSarif(
			report({ findings: [finding({ severity: "warning" }), finding({ id: "f2", severity: "note" })] }),
		);
		expect(content.runs[0].results.map((r) => r.level)).toEqual(["warning", "note"]);
	});
});

describe("JUnit escaping is not optional", () => {
	test("XML metacharacters in a message are escaped", () => {
		const hostile = finding({
			message: 'closing </failure> and <![CDATA[ and & and "quotes"',
			title: "<script>alert(1)</script>",
		});
		const { content } = toJUnit(report({ findings: [hostile] }));
		expect(content).not.toContain("</failure> and");
		expect(content).toContain("&lt;/failure&gt;");
		expect(content).toContain("&lt;script&gt;");
	});

	test("a message that would close the enclosing element cannot", () => {
		const hostile = finding({ message: '</testcase></testsuite><testcase name="injected">' });
		const { content } = toJUnit(report({ findings: [hostile] }));
		const openTags = content.split("<testcase").length - 1;
		expect(openTags).toBe(1);
	});

	test("illegal control characters are removed rather than encoded", () => {
		const { content } = toJUnit(
			report({ findings: [finding({ message: "before\u0000after\u0008x" })] }),
		);
		expect(content).not.toContain("\u0000");
		expect(content).not.toContain("&#0;");
		expect(content).toContain("beforeafterx");
	});

	test("tabs and newlines are preserved, since they are legal", () => {
		expect(escapeXml("a\tb\nc")).toBe("a\tb\nc");
	});

	test("apostrophes and quotes in attributes are escaped", () => {
		const { content } = toJUnit(report({ findings: [finding({ title: `it's "broken"` })] }));
		expect(content).toContain("&apos;");
		expect(content).toContain("&quot;");
	});
});

describe("JUnit is the lossiest format and says so", () => {
	test("failure counts reflect only error-severity findings", () => {
		const { content } = toJUnit(
			report({
				findings: [finding(), finding({ id: "f2", severity: "warning" })],
			}),
		);
		expect(content).toContain('tests="2"');
		expect(content).toContain('failures="1"');
	});

	test("a warning becomes a passing case with the detail in system-out", () => {
		const { content, lost } = toJUnit(
			report({ findings: [finding({ severity: "warning" })] }),
		);
		expect(content).toContain("<system-out>");
		expect(content).not.toContain("<failure");
		expect(lost.some((l) => l.includes("most dashboards do not display"))).toBe(true);
	});

	test("the structured location loss is named", () => {
		expect(toJUnit(report()).lost.some((l) => l.includes("no structured source location"))).toBe(
			true,
		);
	});

	test("confidence and evidence appear as prose in the body", () => {
		const { content } = toJUnit(report());
		expect(content).toContain("confidence: 0.82");
		expect(content).toContain("evidence: e1, e2");
	});

	test("a finding with no location says so rather than emitting an empty reference", () => {
		const { content } = toJUnit(report({ findings: [finding({ location: undefined })] }));
		expect(content).toContain("no source location");
	});
});

describe("trace links carry their expiry", () => {
	const template = {
		url_template: "https://tempo.example/trace/{trace_id}",
		backend: "tempo",
		retention_ms: 7 * 86_400_000,
	};

	test("a fresh link is generated and not expired", () => {
		const { content } = toTraceLinks(report(), template, NOW + 1000);
		expect(content[0].url).toContain("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(content[0].already_expired).toBe(false);
		expect(content[0].expires_at_ms).toBe(NOW + template.retention_ms);
	});

	test("a link past the retention window is flagged as expected to be dead", () => {
		const { content, lost } = toTraceLinks(report(), template, NOW + 30 * 86_400_000);
		expect(content[0].already_expired).toBe(true);
		expect(lost.some((l) => l.includes("expected to be dead"))).toBe(true);
	});

	test("the link is always disclaimed as unverified", () => {
		expect(toTraceLinks(report(), template, NOW).lost[0]).toContain("nothing here verifies");
	});

	test("a template with no placeholder is called out", () => {
		const { lost } = toTraceLinks(
			report(),
			{ ...template, url_template: "https://tempo.example/" },
			NOW,
		);
		expect(lost.some((l) => l.includes("every link points at the same page"))).toBe(true);
	});

	test("trace ids are URL-encoded", () => {
		const { content } = toTraceLinks(
			report({ trace_ids: ["a b/c"] }),
			template,
			NOW,
		);
		expect(content[0].url).toContain("a%20b%2Fc");
	});
});

describe("the lossless format exists so the others can be lossy relative to it", () => {
	test("incident JSON loses nothing", () => {
		const { content, lost } = toIncidentJson(report());
		expect(lost).toEqual([]);
		expect(content.findings[0].confidence).toBe(0.82);
		expect(content.findings[0].alternatives).toEqual(["upstream schema change"]);
		expect(content.trace_ids).toHaveLength(1);
	});
});

describe("exporting everything makes the losses visible in one place", () => {
	test("losses are attributed to the format that caused them", () => {
		const bundle = exportAll(report(), {
			links: {
				url_template: "https://tempo.example/trace/{trace_id}",
				backend: "tempo",
				retention_ms: 7 * 86_400_000,
			},
			now_ms: NOW,
		});
		expect(bundle.losses.some((l) => l.format === "sarif-2.1.0")).toBe(true);
		expect(bundle.losses.some((l) => l.format === "junit-xml")).toBe(true);
		expect(bundle.losses.some((l) => l.format === "otel-links")).toBe(true);
	});

	test("the incident JSON contributes no losses", () => {
		const bundle = exportAll(report());
		expect(bundle.losses.some((l) => l.format === "failsafe.incident/1")).toBe(false);
		expect(bundle.caveats[0]).toContain("only lossless one");
	});

	test("omitting the link template is reported rather than silently skipped", () => {
		const bundle = exportAll(report());
		expect(bundle.links).toBeUndefined();
		expect(bundle.caveats.some((c) => c.includes("no trace-link template"))).toBe(true);
	});

	test("an empty report is called out as something a CI gate reads as success", () => {
		const bundle = exportAll(report({ findings: [] }));
		expect(bundle.caveats.some((c) => c.includes("read as success"))).toBe(true);
		expect(bundle.sarif.content.runs[0].results).toEqual([]);
	});

	test("every format is produced for the same report", () => {
		const bundle = exportAll(report());
		expect(bundle.sarif.format).toBe("sarif-2.1.0");
		expect(bundle.junit.format).toBe("junit-xml");
		expect(bundle.incident.format).toBe("failsafe.incident/1");
	});
});
