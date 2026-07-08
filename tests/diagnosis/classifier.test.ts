/**
 * Diagnosis-classifier prototype tests (item 3).
 *
 * Covers the pure pieces of the evaluation harness: tokenization surfaces the
 * predictive `type:`/`ftype:` features; trained Naive Bayes recovers the right
 * label on held-out-like inputs; the template baseline mirrors the live
 * matchers; `evaluateClassifier` runs deterministic k-fold and — on a corpus of
 * novel failures whose error keywords no template hard-codes — shows the
 * learned model beating the baseline; and `loadDatasetSamples` parses JSONL
 * while dropping unlabeled/malformed rows.
 */
import { describe, expect, test } from "bun:test";
import {
	type LabeledSample,
	evaluateClassifier,
	loadDatasetSamples,
	predictNaiveBayes,
	templateBaselinePredict,
	tokenize,
	trainNaiveBayes,
} from "../../src/diagnosis/classifier.js";

describe("tokenize", () => {
	test("emits type:/ftype: feature tokens plus message words", () => {
		const tokens = tokenize({
			error_type: "KeyError",
			failure_type: "runtime_exception",
			error_message: "KeyError: 'user_id'",
			category: "key_error",
		});
		expect(tokens).toContain("type:keyerror");
		expect(tokens).toContain("ftype:runtime_exception");
		expect(tokens).toContain("user_id");
		// One-character noise is dropped.
		expect(tokens.every((t) => t.length >= 2)).toBe(true);
	});
});

describe("Naive Bayes", () => {
	test("learns to separate two classes from their tokens", () => {
		const train: LabeledSample[] = [
			{ error_type: "KeyError", error_message: "KeyError: 'a'", category: "key_error" },
			{ error_type: "KeyError", error_message: "KeyError: 'b'", category: "key_error" },
			{
				error_type: "ImportError",
				error_message: "No module named 'x'",
				category: "import_error",
			},
			{
				error_type: "ImportError",
				error_message: "No module named 'y'",
				category: "import_error",
			},
		];
		const model = trainNaiveBayes(train);
		expect(
			predictNaiveBayes(model, {
				error_type: "KeyError",
				error_message: "KeyError: 'z'",
				category: "key_error",
			}),
		).toBe("key_error");
		expect(
			predictNaiveBayes(model, {
				error_type: "ImportError",
				error_message: "No module named 'z'",
				category: "import_error",
			}),
		).toBe("import_error");
	});

	test("an empty model predicts unknown", () => {
		const model = trainNaiveBayes([]);
		expect(predictNaiveBayes(model, { error_message: "boom", category: "x" })).toBe("unknown");
	});
});

describe("templateBaselinePredict", () => {
	test("mirrors the template matchers for a known error", () => {
		expect(
			templateBaselinePredict({
				error_type: "ModuleNotFoundError",
				error_message: "No module named 'requests'",
				category: "import_error",
			}),
		).toBe("import_error");
	});

	test("returns unknown when no template matches a novel keyword", () => {
		expect(
			templateBaselinePredict({
				error_type: "QuotaExceeded",
				error_message: "Billing quota exceeded for project",
				category: "quota_error",
			}),
		).toBe("unknown");
	});
});

describe("evaluateClassifier", () => {
	test("the learned model beats the baseline on novel (non-template) failures", () => {
		// Two custom categories whose keywords no template hard-codes: the baseline
		// can only answer "unknown", while the classifier learns the token split.
		const samples: LabeledSample[] = [];
		for (let i = 0; i < 6; i++) {
			samples.push({
				error_type: "QuotaExceeded",
				error_message: `Billing quota exceeded for project p${i}`,
				category: "quota_error",
			});
			samples.push({
				error_type: "RateLimited",
				error_message: `Too many requests, retry after ${i}s`,
				category: "rate_limit",
			});
		}
		const result = evaluateClassifier(samples, { folds: 3, seed: 7 });
		expect(result.samples).toBe(12);
		expect(result.classes).toBe(2);
		expect(result.baseline.accuracy).toBe(0); // every novel row -> "unknown"
		expect(result.classifier.accuracy).toBeGreaterThan(0.8);
		expect(result.verdict).toBe("classifier_wins");
	});

	test("is deterministic for a fixed seed", () => {
		const samples: LabeledSample[] = [
			{ error_type: "KeyError", error_message: "KeyError: 'a'", category: "key_error" },
			{ error_type: "KeyError", error_message: "KeyError: 'b'", category: "key_error" },
			{
				error_type: "TypeError",
				error_message: "Cannot read properties",
				category: "null_reference",
			},
			{
				error_type: "TypeError",
				error_message: "Cannot read properties of null",
				category: "null_reference",
			},
		];
		const a = evaluateClassifier(samples, { folds: 2, seed: 3 });
		const b = evaluateClassifier(samples, { folds: 2, seed: 3 });
		expect(a.classifier.accuracy).toBe(b.classifier.accuracy);
		expect(a.improvement).toBe(b.improvement);
	});
});

describe("loadDatasetSamples", () => {
	test("keeps labeled rows and drops unlabeled and malformed lines", () => {
		const jsonl = [
			JSON.stringify({ error_type: "KeyError", error_message: "x", category: "key_error" }),
			JSON.stringify({ error_type: "TypeError", error_message: "y" }), // no category -> dropped
			"{ not valid json", // malformed -> dropped
			"",
			JSON.stringify({ error_type: "ImportError", error_message: "z", category: "import_error" }),
		].join("\n");
		const samples = loadDatasetSamples(jsonl);
		expect(samples).toHaveLength(2);
		expect(samples.map((s) => s.category)).toEqual(["key_error", "import_error"]);
	});
});
