import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, resolveConfigPaths } from "../../src/types/config.js";

describe("resolveConfigPaths", () => {
	test("anchors config at <cwd>/.failsafe/config.json by default", () => {
		const paths = resolveConfigPaths("/work", DEFAULT_CONFIG);
		expect(paths.configDir).toBe("/work/.failsafe");
		expect(paths.configFile).toBe("/work/.failsafe/config.json");
		expect(paths.storageDir).toBe("/work/.failsafe");
		expect(paths.runsDir).toBe("/work/.failsafe/runs");
		expect(paths.historyDb).toBe("/work/.failsafe/history.sqlite");
	});

	test("config anchor stays fixed when storage_dir is relocated (relative)", () => {
		const config = { ...DEFAULT_CONFIG, storage_dir: "custom-store" };
		const paths = resolveConfigPaths("/work", config);
		// Config anchor does NOT move
		expect(paths.configFile).toBe("/work/.failsafe/config.json");
		// Storage follows storage_dir
		expect(paths.storageDir).toBe("/work/custom-store");
		expect(paths.runsDir).toBe("/work/custom-store/runs");
		expect(paths.historyDb).toBe("/work/custom-store/history.sqlite");
	});

	test("config anchor stays fixed when storage_dir is absolute", () => {
		const config = { ...DEFAULT_CONFIG, storage_dir: "/var/cache/failsafe" };
		const paths = resolveConfigPaths("/work", config);
		expect(paths.configFile).toBe("/work/.failsafe/config.json");
		expect(paths.storageDir).toBe("/var/cache/failsafe");
		expect(paths.runsDir).toBe("/var/cache/failsafe/runs");
		expect(paths.historyDb).toBe("/var/cache/failsafe/history.sqlite");
	});

	test("code index dir follows storage_dir", () => {
		const config = { ...DEFAULT_CONFIG, storage_dir: "/data" };
		const paths = resolveConfigPaths("/work", config);
		expect(paths.codeIndexDir).toBe("/data/code-index");
	});
});
