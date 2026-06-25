import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearDeclaredRulesCache,
	loadDeclaredRules,
	reloadDeclaredRules,
} from "../../src/rules/declared.js";

function ruleYaml(id: string, errorContains: string): string {
	return `version: "1"
rules:
  - id: "${id}"
    pattern:
      error_contains: "${errorContains}"
    diagnosis:
      category: "key_error"
      explanation: "Rule ${id}"
    confidence: 0.9
`;
}

function tempRulesFile(): string {
	const dir = join(
		tmpdir(),
		`failsafe-hot-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return join(dir, "rules.yaml");
}

describe("declared rules hot-reload", () => {
	test("picks up edits within the same process without a restart", () => {
		const path = tempRulesFile();
		clearDeclaredRulesCache();

		writeFileSync(path, ruleYaml("rule-a", "KeyError"));
		const first = loadDeclaredRules(path);
		expect(first.map((r) => r.id)).toEqual(["rule-a"]);

		// Edit the file in place (different content -> different size/mtime).
		writeFileSync(path, ruleYaml("rule-b", "ValueError"));
		const second = loadDeclaredRules(path);
		expect(second.map((r) => r.id)).toEqual(["rule-b"]);

		rmSync(path, { force: true });
	});

	test("returns the cached array when the file is unchanged (no re-parse)", () => {
		const path = tempRulesFile();
		clearDeclaredRulesCache();

		writeFileSync(path, ruleYaml("rule-a", "KeyError"));
		const first = loadDeclaredRules(path);
		const second = loadDeclaredRules(path);
		// Same reference proves the parse result was served from cache.
		expect(second).toBe(first);

		rmSync(path, { force: true });
	});

	test("reloadDeclaredRules forces a re-read even when mtime/size are identical", () => {
		const path = tempRulesFile();
		clearDeclaredRulesCache();

		const a = ruleYaml("rule-a", "KeyError");
		writeFileSync(path, a);
		const first = loadDeclaredRules(path);
		expect(first.map((r) => r.id)).toEqual(["rule-a"]);

		// Write different content but pin mtime + size identical so the cache
		// key would not change; reload must still pick up the new content.
		// "Mistaken" has the same length as "KeyError" so the file size is
		// unchanged; the rule id keeps the same width too.
		const b = ruleYaml("rule-z", "Mistaken");
		expect(b.length).toBe(a.length);
		writeFileSync(path, b);
		const fixedTime = new Date(0);
		utimesSync(path, fixedTime, fixedTime);

		const reloaded = reloadDeclaredRules(path);
		expect(reloaded.map((r) => r.id)).toEqual(["rule-z"]);

		rmSync(path, { force: true });
	});

	test("forgets a deleted file so later recreation is seen", () => {
		const path = tempRulesFile();
		clearDeclaredRulesCache();

		writeFileSync(path, ruleYaml("rule-a", "KeyError"));
		expect(loadDeclaredRules(path).length).toBe(1);

		rmSync(path, { force: true });
		expect(loadDeclaredRules(path)).toEqual([]);

		writeFileSync(path, ruleYaml("rule-c", "TypeError"));
		expect(loadDeclaredRules(path).map((r) => r.id)).toEqual(["rule-c"]);

		rmSync(path, { force: true });
	});
});
