/**
 * "Diagnosis Needle" classifier prototype (item 3).
 *
 * A tiny, fully-offline, dependency-free multinomial Naive Bayes over the
 * bag-of-tokens of a failure's text (error type + message + failure type +
 * command), predicting the diagnosis `category`. Its purpose is *evaluation*:
 * does a learned model beat the hand-written template/builtin matcher
 * (`src/diagnosis/templates.ts`) on the collected corpus — especially on novel
 * failures whose error keyword no template hard-codes?
 *
 * Everything here is pure (no fs/network/process): the CLI wrapper
 * (`failsafe kb classify-eval`) loads the `kb export-dataset` JSONL and renders
 * the {@link ClassifierEvaluation}. Determinism comes from a seeded shuffle so
 * the k-fold comparison is reproducible in tests and CI.
 */
import type { ParsedError } from "../types/failure.js";
import { TEMPLATES } from "./templates.js";

/** A labeled training/eval row distilled from a `kb export-dataset` line. */
export type LabeledSample = {
	command?: string;
	failure_type?: string;
	error_type?: string;
	error_message?: string;
	/** The target label (diagnosis category). */
	category: string;
};

/** A trained multinomial Naive Bayes model (token counts per class). */
export type NaiveBayesModel = {
	classes: string[];
	/** Number of documents per class (for the class prior). */
	docCounts: Record<string, number>;
	/** class -> token -> count. */
	tokenCounts: Record<string, Record<string, number>>;
	/** Total token occurrences per class (denominator for likelihood). */
	classTokenTotals: Record<string, number>;
	/** Vocabulary size across all classes (Laplace smoothing denominator term). */
	vocabSize: number;
	totalDocs: number;
};

/**
 * Tokenize a sample's text features into a bag of tokens. The raw error_type
 * is emitted as a distinct `type:<x>` token (it is the single most predictive
 * feature) alongside word tokens from the message/command/failure_type.
 */
export function tokenize(sample: LabeledSample): string[] {
	const tokens: string[] = [];
	if (sample.error_type) tokens.push(`type:${sample.error_type.toLowerCase()}`);
	if (sample.failure_type) tokens.push(`ftype:${sample.failure_type.toLowerCase()}`);
	const text = [sample.error_type, sample.error_message, sample.command]
		.filter((s): s is string => typeof s === "string")
		.join(" ")
		.toLowerCase();
	for (const word of text.split(/[^a-z0-9_]+/)) {
		if (word.length >= 2) tokens.push(word);
	}
	return tokens;
}

/** Train a multinomial Naive Bayes model from labeled samples. */
export function trainNaiveBayes(samples: LabeledSample[]): NaiveBayesModel {
	const docCounts: Record<string, number> = {};
	const tokenCounts: Record<string, Record<string, number>> = {};
	const classTokenTotals: Record<string, number> = {};
	const vocab = new Set<string>();

	for (const sample of samples) {
		const cls = sample.category;
		docCounts[cls] = (docCounts[cls] ?? 0) + 1;
		tokenCounts[cls] ??= {};
		classTokenTotals[cls] ??= 0;
		for (const token of tokenize(sample)) {
			vocab.add(token);
			tokenCounts[cls][token] = (tokenCounts[cls][token] ?? 0) + 1;
			classTokenTotals[cls]++;
		}
	}

	return {
		classes: Object.keys(docCounts),
		docCounts,
		tokenCounts,
		classTokenTotals,
		vocabSize: vocab.size,
		totalDocs: samples.length,
	};
}

/**
 * Predict the most likely category for a sample under the model using
 * log-probabilities with Laplace (add-one) smoothing. Returns `"unknown"` for
 * an empty/untrained model.
 */
export function predictNaiveBayes(model: NaiveBayesModel, sample: LabeledSample): string {
	if (model.classes.length === 0) return "unknown";
	const tokens = tokenize(sample);
	let best = model.classes[0];
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const cls of model.classes) {
		// Class prior.
		let score = Math.log(model.docCounts[cls] / model.totalDocs);
		const counts = model.tokenCounts[cls] ?? {};
		const denom = (model.classTokenTotals[cls] ?? 0) + model.vocabSize;
		for (const token of tokens) {
			const count = counts[token] ?? 0;
			score += Math.log((count + 1) / denom);
		}
		if (score > bestScore) {
			bestScore = score;
			best = cls;
		}
	}
	return best;
}

/**
 * Template/builtin baseline: run the hand-written matchers in priority order
 * against a synthetic single-error view of the sample, returning the first
 * matching template's category (or `"unknown"`). This mirrors how the live
 * diagnosis engine falls back to templates when no rule matches.
 */
export function templateBaselinePredict(sample: LabeledSample): string {
	const err: ParsedError = {
		message: sample.error_message ?? "",
		error_type: sample.error_type,
	};
	for (const template of TEMPLATES) {
		try {
			if (template.match([err])) return template.category;
		} catch {}
	}
	return "unknown";
}

/** Per-predictor accuracy breakdown. */
export type PredictorScore = {
	correct: number;
	total: number;
	accuracy: number;
	/** category -> { correct, total } for a per-class view. */
	per_category: Record<string, { correct: number; total: number }>;
};

export type ClassifierEvaluation = {
	samples: number;
	classes: number;
	folds: number;
	classifier: PredictorScore;
	baseline: PredictorScore;
	/** classifier.accuracy - baseline.accuracy. */
	improvement: number;
	verdict: "classifier_wins" | "baseline_wins" | "tie";
	recommendation: string;
};

/** Deterministic PRNG (mulberry32) so the k-fold split is reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function seededShuffle<T>(items: T[], seed: number): T[] {
	const out = items.slice();
	const rand = mulberry32(seed);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function emptyScore(): PredictorScore {
	return { correct: 0, total: 0, accuracy: 0, per_category: {} };
}

function record(score: PredictorScore, actual: string, predicted: string): void {
	score.total++;
	score.per_category[actual] ??= { correct: 0, total: 0 };
	score.per_category[actual].total++;
	if (predicted === actual) {
		score.correct++;
		score.per_category[actual].correct++;
	}
}

/**
 * Compare the Naive Bayes classifier against the template baseline via seeded
 * stratified-by-shuffle k-fold cross-validation. The baseline needs no
 * training, so it is scored on every held-out row; the classifier is trained on
 * the other folds for each held-out fold. Folds are clamped to the sample count
 * (so a tiny corpus degrades to leave-one-out) and to a minimum of 2.
 */
export function evaluateClassifier(
	samples: LabeledSample[],
	opts: { folds?: number; seed?: number } = {},
): ClassifierEvaluation {
	const seed = opts.seed ?? 1;
	const shuffled = seededShuffle(samples, seed);
	const classes = new Set(samples.map((s) => s.category));
	const classifier = emptyScore();
	const baseline = emptyScore();

	const folds = Math.max(2, Math.min(opts.folds ?? 5, shuffled.length));

	if (shuffled.length >= 2) {
		for (let f = 0; f < folds; f++) {
			const testSet = shuffled.filter((_, i) => i % folds === f);
			const trainSet = shuffled.filter((_, i) => i % folds !== f);
			if (testSet.length === 0) continue;
			const model = trainNaiveBayes(trainSet);
			for (const sample of testSet) {
				record(classifier, sample.category, predictNaiveBayes(model, sample));
				record(baseline, sample.category, templateBaselinePredict(sample));
			}
		}
	}

	classifier.accuracy = classifier.total > 0 ? classifier.correct / classifier.total : 0;
	baseline.accuracy = baseline.total > 0 ? baseline.correct / baseline.total : 0;
	const improvement = classifier.accuracy - baseline.accuracy;

	// A small margin avoids declaring a winner on noise.
	const margin = 0.02;
	let verdict: ClassifierEvaluation["verdict"];
	let recommendation: string;
	if (improvement > margin) {
		verdict = "classifier_wins";
		recommendation =
			"The learned classifier beats template matching on this corpus; consider promoting it as a fallback for novel failures.";
	} else if (improvement < -margin) {
		verdict = "baseline_wins";
		recommendation =
			"Template/builtin matching still wins; keep templates as the primary path and grow the corpus before revisiting.";
	} else {
		verdict = "tie";
		recommendation =
			"No decisive difference; keep templates and collect more labeled, balanced data before promoting a model.";
	}

	return {
		samples: samples.length,
		classes: classes.size,
		folds,
		classifier,
		baseline,
		improvement,
		verdict,
		recommendation,
	};
}

/**
 * Parse `kb export-dataset` JSONL text into labeled samples, keeping only rows
 * that carry a category label (the supervised signal). Malformed lines are
 * skipped so a partially-written corpus still evaluates.
 */
export function loadDatasetSamples(jsonl: string): LabeledSample[] {
	const samples: LabeledSample[] = [];
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const row = JSON.parse(trimmed) as Record<string, unknown>;
			const category = row.category;
			if (typeof category !== "string" || category.length === 0) continue;
			samples.push({
				command: typeof row.command === "string" ? row.command : undefined,
				failure_type: typeof row.failure_type === "string" ? row.failure_type : undefined,
				error_type: typeof row.error_type === "string" ? row.error_type : undefined,
				error_message: typeof row.error_message === "string" ? row.error_message : undefined,
				category,
			});
		} catch {}
	}
	return samples;
}
