/**
 * Drain-style online log-template mining (item 27).
 *
 * Last-resort structure recovery for output no registered parser understands.
 * Implements the Drain fixed-depth parse tree (logpai/Drain3): messages are
 * bucketed by token count and their first tokens, then matched against the
 * clusters in that bucket by token-sequence similarity. Matching a cluster
 * generalizes the differing positions to a `<*>` wildcard, so a stable template
 * plus its variable slots fall out of a single pass with no training data.
 *
 * Pure and bounded: no fs/network/process access, a capped number of scanned
 * lines, capped line length, and a capped fan-out per tree node, so a
 * pathological multi-megabyte log cannot blow up parse latency.
 */
import { createHash } from "node:crypto";
import type { SourceLocation } from "../types/common.js";
import { normalizeLocation } from "../utils/paths.js";
import type { ParserResult } from "./types.js";

export const TEMPLATE_WILDCARD = "<*>";

export type DrainOptions = {
	/** Fixed parse-tree depth, including root and leaf (Drain's `depth`). */
	depth?: number;
	/** Minimum token-sequence similarity to join an existing cluster. */
	simThreshold?: number;
	/** Max children per internal node before collapsing into the wildcard child. */
	maxChildren?: number;
	/** Max lines scanned (from the end of the stream, where failures live). */
	maxLines?: number;
	/** Lines longer than this are truncated before tokenization. */
	maxLineLength?: number;
};

export type LogTemplate = {
	/** Mined template with `<*>` at every variable position. */
	template: string;
	/** Number of scanned lines that matched this template. */
	occurrences: number;
	/** The first concrete line that produced this template. */
	representative: string;
	/** 1-based index of `representative` within the scanned window. */
	line_number: number;
	/** Whether the representative line carries failure vocabulary. */
	salient: boolean;
};

const DEFAULTS = {
	depth: 4,
	simThreshold: 0.5,
	maxChildren: 100,
	maxLines: 2000,
	maxLineLength: 512,
};

/** Vocabulary that marks a line as describing a failure rather than progress. */
const FAILURE_VOCAB =
	/\b(error|errors|failed|failure|fatal|exception|panic|traceback|abort(?:ed)?|denied|refused|unable|cannot|can't|invalid|missing|not found|no such|unexpected|timed? ?out|crash(?:ed)?)\b/i;

/** `path/to/file.ext:LINE[:COL]`, the near-universal location shape in tool output. */
const LOCATION_RE = /([\w./\\@+-]+\.[A-Za-z][\w]{0,9}):(\d+)(?::(\d+))?/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR sequences requires ESC.
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

type LogCluster = {
	tokens: string[];
	occurrences: number;
	representative: string;
	line_number: number;
};

type TreeNode = {
	children: Map<string, TreeNode>;
	clusters: LogCluster[];
};

function newNode(): TreeNode {
	return { children: new Map(), clusters: [] };
}

function hasDigit(token: string): boolean {
	return /\d/.test(token);
}

/**
 * Token-sequence similarity (Drain's `seqDist`): the fraction of positions
 * where the cluster template and the candidate agree. Wildcard positions
 * contribute 0 to the score but are counted separately so that, at equal
 * similarity, the more specific (fewer-wildcard) cluster wins.
 */
function seqSimilarity(template: string[], tokens: string[]): { sim: number; wildcards: number } {
	let matched = 0;
	let wildcards = 0;
	for (let i = 0; i < template.length; i++) {
		if (template[i] === TEMPLATE_WILDCARD) {
			wildcards++;
			continue;
		}
		if (template[i] === tokens[i]) matched++;
	}
	return { sim: template.length === 0 ? 0 : matched / template.length, wildcards };
}

/** Generalize a cluster template against a newly matched line. */
function mergeTemplate(template: string[], tokens: string[]): string[] {
	const merged = template.slice();
	for (let i = 0; i < merged.length; i++) {
		if (merged[i] !== tokens[i]) merged[i] = TEMPLATE_WILDCARD;
	}
	return merged;
}

/**
 * Mine log templates from raw text in one pass.
 *
 * Returns every mined template ordered by occurrence count (descending), then
 * by first appearance, so `[0]` is the most frequent template in the window.
 */
export function mineTemplates(text: string, opts: DrainOptions = {}): LogTemplate[] {
	const depth = Math.max(3, opts.depth ?? DEFAULTS.depth);
	const simThreshold = opts.simThreshold ?? DEFAULTS.simThreshold;
	const maxChildren = opts.maxChildren ?? DEFAULTS.maxChildren;
	const maxLines = opts.maxLines ?? DEFAULTS.maxLines;
	const maxLineLength = opts.maxLineLength ?? DEFAULTS.maxLineLength;

	const all = text.split("\n");
	// Scan the tail of the stream: tool failures are reported at the end, and
	// this bounds work on very large logs.
	const window = all.length > maxLines ? all.slice(all.length - maxLines) : all;

	const root = newNode();
	const clusters: LogCluster[] = [];

	for (let i = 0; i < window.length; i++) {
		const line = window[i].replace(ANSI_RE, "").trimEnd();
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const bounded = trimmed.length > maxLineLength ? trimmed.slice(0, maxLineLength) : trimmed;
		const tokens = bounded.split(/\s+/);

		// Layer 1: token count. Layer 2..depth-1: leading tokens, with any token
		// containing a digit folded into the wildcard branch.
		let node = root;
		const path = [String(tokens.length)];
		for (let d = 0; d < depth - 2 && d < tokens.length; d++) {
			path.push(hasDigit(tokens[d]) ? TEMPLATE_WILDCARD : tokens[d]);
		}
		for (const key of path) {
			let child = node.children.get(key);
			if (!child) {
				if (node.children.size >= maxChildren) {
					child = node.children.get(TEMPLATE_WILDCARD);
					if (!child) {
						child = newNode();
						node.children.set(TEMPLATE_WILDCARD, child);
					}
				} else {
					child = newNode();
					node.children.set(key, child);
				}
			}
			node = child;
		}

		// Layer depth: pick the most similar cluster in this leaf bucket.
		let best: LogCluster | null = null;
		let bestSim = -1;
		let bestWildcards = -1;
		for (const cluster of node.clusters) {
			if (cluster.tokens.length !== tokens.length) continue;
			const { sim, wildcards } = seqSimilarity(cluster.tokens, tokens);
			if (sim > bestSim || (sim === bestSim && wildcards < bestWildcards)) {
				best = cluster;
				bestSim = sim;
				bestWildcards = wildcards;
			}
		}

		if (best && bestSim >= simThreshold) {
			best.tokens = mergeTemplate(best.tokens, tokens);
			best.occurrences++;
		} else {
			const cluster: LogCluster = {
				tokens,
				occurrences: 1,
				representative: bounded,
				line_number: i + 1,
			};
			node.clusters.push(cluster);
			clusters.push(cluster);
		}
	}

	return clusters
		.map((c) => ({
			template: c.tokens.join(" "),
			occurrences: c.occurrences,
			representative: c.representative,
			line_number: c.line_number,
			salient: FAILURE_VOCAB.test(c.representative),
		}))
		.sort((a, b) => b.occurrences - a.occurrences || a.line_number - b.line_number);
}

/**
 * Pick the template most likely to describe the failure.
 *
 * Failure vocabulary wins first (a repeated progress line is more frequent but
 * less informative than the single line that says "fatal:"), then occurrence
 * count, then position in the stream. Returns null for empty input.
 */
export function selectFailureTemplate(templates: LogTemplate[]): LogTemplate | null {
	if (templates.length === 0) return null;
	const ranked = templates.slice().sort((a, b) => {
		if (a.salient !== b.salient) return a.salient ? -1 : 1;
		return b.occurrences - a.occurrences || a.line_number - b.line_number;
	});
	return ranked[0];
}

/** Stable 8-hex identity for a template, used to build a groupable signature. */
export function templateHash(template: string): string {
	return createHash("sha256").update(`drain|${template}`).digest("hex").substring(0, 8);
}

/** Best-effort `file:line[:col]` extraction from an unstructured line. */
export function extractLocationFromLine(line: string): SourceLocation | undefined {
	const m = LOCATION_RE.exec(line);
	if (!m) return undefined;
	const lineNo = Number.parseInt(m[2], 10);
	if (!Number.isFinite(lineNo) || lineNo <= 0) return undefined;
	const loc: SourceLocation = { file: m[1], line: lineNo };
	if (m[3]) loc.column = Number.parseInt(m[3], 10);
	return normalizeLocation(loc);
}

/**
 * Build a last-resort {@link ParserResult} from mined templates.
 *
 * Only used when no registered parser matched. The emitted error carries the
 * concrete failing line as its message, the mined template (with occurrence
 * counts) for evidence, a `log_template:<hash>` error_type so the failure gets
 * a stable, groupable signature instead of collapsing every unknown tool into
 * one bucket, and a `file:line` location when the line contains one.
 *
 * Returns null when the output carries nothing worth templating.
 */
export function mineTemplateResult(
	stdout: string,
	stderr: string,
	opts: DrainOptions = {},
): ParserResult | null {
	// stderr first: a tool that failed usually says why there.
	const text = `${stderr}\n${stdout}`;
	const templates = mineTemplates(text, opts);
	const selected = selectFailureTemplate(templates);
	if (!selected) return null;

	const scanned = templates.reduce((sum, t) => sum + t.occurrences, 0);
	const location = extractLocationFromLine(selected.representative);

	return {
		parser: "drain-template",
		failure_type: "unknown",
		errors: [
			{
				message: selected.representative,
				error_type: `log_template:${templateHash(selected.template)}`,
				location,
				log_template: {
					template: selected.template,
					occurrences: selected.occurrences,
					scanned_lines: scanned,
				},
			},
		],
	};
}
