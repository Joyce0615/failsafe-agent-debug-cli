import { describe, expect, test } from "bun:test";
import {
	ALWAYS_DENIED_PATHS,
	MINIMAL_CAPABILITIES,
	PROFILES,
	PROFILE_TIGHTNESS,
	type ResourceLimits,
	SANDBOX_PROFILES,
	assessReadiness,
	describeEnforcement,
	evaluateNetwork,
	filterEnvironment,
	hostAllowed,
	pathWritable,
	terminationPlan,
} from "../../src/security/sandbox.js";

const ROOTS = { workspace: "/work/repo", tmpdir: "/tmp/failsafe" };

const FULL_CAPABILITIES = { rlimits: true, cgroups: true, network_isolation: true };

describe("a proposed fix is trusted less than a reproducer", () => {
	const numericLimits: Array<keyof ResourceLimits> = [
		"wall_clock_ms",
		"cpu_seconds",
		"memory_bytes",
		"disk_write_bytes",
		"max_processes",
		"max_open_files",
		"max_output_bytes",
	];

	test("every numeric limit is tighter for a proposed fix", () => {
		for (const limit of numericLimits) {
			expect(PROFILES.proposed_fix.limits[limit]).toBeLessThan(PROFILES.reproducer.limits[limit]);
		}
	});

	test("the reproducer is in turn tighter than trusted", () => {
		for (const limit of numericLimits) {
			expect(PROFILES.reproducer.limits[limit]).toBeLessThan(PROFILES.trusted.limits[limit]);
		}
	});

	test("a proposed fix cannot write the workspace or use loopback", () => {
		expect(PROFILES.proposed_fix.filesystem.workspace_writable).toBe(false);
		expect(PROFILES.proposed_fix.network.allow_loopback).toBe(false);
		expect(PROFILES.reproducer.filesystem.workspace_writable).toBe(true);
	});

	test("the environment allowlist widens with trust, never narrows", () => {
		for (const key of PROFILES.proposed_fix.env_allowlist) {
			expect(PROFILES.reproducer.env_allowlist).toContain(key);
		}
		for (const key of PROFILES.reproducer.env_allowlist) {
			expect(PROFILES.trusted.env_allowlist).toContain(key);
		}
	});

	test("the tightness ordering matches the profile list", () => {
		expect(Object.keys(PROFILE_TIGHTNESS).sort()).toEqual([...SANDBOX_PROFILES].sort());
		expect(PROFILE_TIGHTNESS.proposed_fix).toBeLessThan(PROFILE_TIGHTNESS.reproducer);
		expect(PROFILE_TIGHTNESS.reproducer).toBeLessThan(PROFILE_TIGHTNESS.trusted);
	});
});

describe("credential paths are denied everywhere", () => {
	test("even the trusted profile denies them", () => {
		for (const profile of SANDBOX_PROFILES) {
			for (const path of ALWAYS_DENIED_PATHS) {
				expect(PROFILES[profile].filesystem.denied_paths).toContain(path);
			}
		}
	});

	test("a denied path is unwritable no matter what the allowlist says", () => {
		const permissive = {
			...PROFILES.trusted,
			filesystem: { ...PROFILES.trusted.filesystem, writable_paths: ["/"] },
		};
		expect(pathWritable(`${process.env.HOME ?? "~"}/.ssh/id_rsa`, permissive, ROOTS)).toBe(false);
	});
});

describe("network defaults to none and denials are findings", () => {
	test("no profile ships with unrestricted network", () => {
		for (const profile of SANDBOX_PROFILES) {
			expect(PROFILES[profile].network.mode).not.toBe("unrestricted");
		}
	});

	test("loopback is separable from the outside world", () => {
		expect(hostAllowed("localhost", PROFILES.reproducer.network)).toBe(true);
		expect(hostAllowed("pypi.org", PROFILES.reproducer.network)).toBe(false);
		expect(hostAllowed("127.0.0.1", PROFILES.proposed_fix.network)).toBe(false);
	});

	test("an allowlist entry matches exactly, not as a suffix", () => {
		const policy = {
			mode: "allowlist" as const,
			allowed_hosts: ["example.com"],
			allow_loopback: false,
		};
		expect(hostAllowed("example.com", policy)).toBe(true);
		// The attack this prevents: registering evil-example.com.
		expect(hostAllowed("evil-example.com", policy)).toBe(false);
		expect(hostAllowed("api.example.com", policy)).toBe(false);
	});

	test("a leading dot opts into subdomains deliberately", () => {
		const policy = {
			mode: "allowlist" as const,
			allowed_hosts: [".example.com"],
			allow_loopback: false,
		};
		expect(hostAllowed("api.example.com", policy)).toBe(true);
		expect(hostAllowed("example.com", policy)).toBe(true);
		expect(hostAllowed("evil-example.com", policy)).toBe(false);
	});

	test("denied attempts are returned so a hidden dependency becomes visible", () => {
		const result = evaluateNetwork(
			[
				{ host: "localhost", port: 5432 },
				{ host: "pypi.org", port: 443 },
				{ host: "PyPI.org", port: 443 },
			],
			PROFILES.reproducer.network,
		);
		expect(result.denied).toHaveLength(2);
		expect(result.distinct_denied_hosts).toEqual(["pypi.org"]);
		expect(result.results[0].allowed).toBe(true);
	});

	test("unrestricted allows everything, which is why no profile uses it", () => {
		const policy = { mode: "unrestricted" as const, allowed_hosts: [], allow_loopback: false };
		expect(hostAllowed("anything.example", policy)).toBe(true);
	});

	test("no attempts is a clean result rather than an empty special case", () => {
		const result = evaluateNetwork([], PROFILES.reproducer.network);
		expect(result.results).toEqual([]);
		expect(result.distinct_denied_hosts).toEqual([]);
	});
});

describe("an unenforceable limit is named, not assumed", () => {
	test("the minimal platform enforces only what the supervisor owns", () => {
		const statuses = describeEnforcement(PROFILES.reproducer, MINIMAL_CAPABILITIES);
		const enforceable = statuses.filter((s) => s.enforceable).map((s) => s.limit);
		expect(enforceable.sort()).toEqual(["max_output_bytes", "wall_clock_ms"]);
	});

	test("every unenforceable limit explains the consequence of the gap", () => {
		for (const status of describeEnforcement(PROFILES.reproducer, MINIMAL_CAPABILITIES)) {
			if (!status.enforceable) expect(status.gap ?? "").not.toBe("");
		}
	});

	test("rlimits enable the process, file, CPU, and memory ceilings", () => {
		const statuses = describeEnforcement(PROFILES.reproducer, {
			rlimits: true,
			cgroups: false,
			network_isolation: false,
		});
		const byName = new Map(statuses.map((s) => [s.limit, s]));
		expect(byName.get("cpu_seconds")?.enforceable).toBe(true);
		expect(byName.get("max_processes")?.enforceable).toBe(true);
		expect(byName.get("memory_bytes")?.enforceable).toBe(true);
		// Disk still needs a cgroup.
		expect(byName.get("disk_write_bytes")?.enforceable).toBe(false);
	});

	test("cgroups change the memory mechanism that is reported", () => {
		const withCgroups = describeEnforcement(PROFILES.reproducer, FULL_CAPABILITIES);
		expect(withCgroups.find((s) => s.limit === "memory_bytes")?.mechanism).toContain("cgroup");
	});

	test("readiness reports partial containment rather than throwing", () => {
		const readiness = assessReadiness(PROFILES.reproducer, MINIMAL_CAPABILITIES);
		expect(readiness.fully_enforced).toBe(false);
		expect(readiness.unenforceable.length).toBeGreaterThan(0);
		expect(readiness.warnings.length).toBeGreaterThan(0);
	});

	test("an unenforceable network policy is the first warning, not a footnote", () => {
		const readiness = assessReadiness(PROFILES.reproducer, MINIMAL_CAPABILITIES);
		expect(readiness.network_enforceable).toBe(false);
		expect(readiness.warnings[0]).toContain("network mode");
		expect(readiness.warnings[0]).toContain("not be evidence about local code");
	});

	test("a fully capable platform reports full enforcement", () => {
		const readiness = assessReadiness(PROFILES.reproducer, FULL_CAPABILITIES);
		expect(readiness.fully_enforced).toBe(true);
		expect(readiness.unenforceable).toEqual([]);
		expect(readiness.warnings).toEqual([]);
	});
});

describe("termination actually terminates", () => {
	test("the plan is terminate then kill, in that order", () => {
		const plan = terminationPlan(PROFILES.reproducer);
		expect(plan.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
		expect(plan[1].after_ms).toBeGreaterThan(plan[0].after_ms);
	});

	test("the gap between the two is exactly the grace period", () => {
		const profile = PROFILES.proposed_fix;
		const plan = terminationPlan(profile);
		expect(plan[1].after_ms - plan[0].after_ms).toBe(profile.kill_grace_ms);
	});

	test("the grace period exists so output can be flushed, and says so", () => {
		expect(terminationPlan(PROFILES.reproducer)[0].reason).toContain("flush output");
	});

	test("every profile has a nonzero grace period", () => {
		for (const name of SANDBOX_PROFILES) {
			expect(PROFILES[name].kill_grace_ms).toBeGreaterThan(0);
		}
	});
});

describe("environment filtering is an allowlist", () => {
	test("unlisted variables are stripped and reported", () => {
		const { env, stripped } = filterEnvironment(
			{ PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "y", HOME: "/home/u" },
			PROFILES.proposed_fix,
		);
		expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
		expect(stripped).toEqual(["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]);
	});

	test("a brand-new credential variable is stripped without anyone updating a list", () => {
		const { env } = filterEnvironment(
			{ PATH: "/usr/bin", SOME_FUTURE_VENDOR_TOKEN: "x" },
			PROFILES.reproducer,
		);
		expect("SOME_FUTURE_VENDOR_TOKEN" in env).toBe(false);
	});

	test("undefined values are dropped rather than stringified", () => {
		const { env, stripped } = filterEnvironment({ PATH: undefined }, PROFILES.reproducer);
		expect(env).toEqual({});
		expect(stripped).toEqual([]);
	});
});

describe("writable paths", () => {
	test("the workspace is writable for a reproducer and not for a fix", () => {
		expect(pathWritable("/work/repo/src/x.py", PROFILES.reproducer, ROOTS)).toBe(true);
		expect(pathWritable("/work/repo/src/x.py", PROFILES.proposed_fix, ROOTS)).toBe(false);
	});

	test("the temp directory is writable in both", () => {
		expect(pathWritable("/tmp/failsafe/run1", PROFILES.reproducer, ROOTS)).toBe(true);
		expect(pathWritable("/tmp/failsafe/run1", PROFILES.proposed_fix, ROOTS)).toBe(true);
	});

	test("a path outside every root is not writable", () => {
		expect(pathWritable("/etc/hosts", PROFILES.reproducer, ROOTS)).toBe(false);
		expect(pathWritable("/work/other-repo/x", PROFILES.reproducer, ROOTS)).toBe(false);
	});

	test("a sibling directory sharing a prefix is not inside the root", () => {
		expect(pathWritable("/work/repo-backup/x", PROFILES.reproducer, ROOTS)).toBe(false);
	});

	test("the root itself is writable, trailing slash or not", () => {
		expect(pathWritable("/work/repo", PROFILES.reproducer, ROOTS)).toBe(true);
		expect(pathWritable("/work/repo/", PROFILES.reproducer, ROOTS)).toBe(true);
	});
});
