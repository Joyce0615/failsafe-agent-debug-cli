/**
 * Sandbox profiles for reproducers and proposed fixes (item 63).
 *
 * `policy.ts` decides whether a command is *allowed to run*. This module
 * decides what it is allowed to *do once running*, which is a different
 * question with a different failure mode: a perfectly innocent-looking
 * `pytest` invocation can still exfiltrate a repository, fill a disk, fork
 * until the machine stops, or hang forever.
 *
 * The design rests on four commitments:
 *
 * 1. **Deny network by default, and treat a deny as a first-class outcome.**
 *    A reproducer that needs the network is not automatically wrong, but it is
 *    no longer reproducing anything local, and a run whose result depended on
 *    a remote service is not evidence about the code. `NetworkPolicy` starts at
 *    `none`, an allowlist is per-host and explicit, and every attempted
 *    connection outside it is *recorded* rather than merely blocked, because
 *    "this test silently needs the internet" is itself a diagnosis.
 *
 * 2. **A limit that is not enforced is a comment.** `describeEnforcement`
 *    states, per limit, whether the current platform can actually apply it and
 *    what the consequence of the gap is. Reporting a memory ceiling that the
 *    runtime cannot impose would make an unbounded run look bounded, which is
 *    the exact failure a sandbox exists to prevent. Unenforceable limits are
 *    named, not quietly dropped.
 *
 * 3. **A proposed fix is less trusted than a reproducer.** The reproducer is
 *    code that already exists in the repository; a proposed fix is code an
 *    agent wrote. `PROFILES.proposed_fix` is strictly tighter than
 *    `PROFILES.reproducer` on every axis, and a test enforces that ordering so
 *    it cannot drift.
 *
 * 4. **Timeouts must terminate, not request termination.** A soft signal that a
 *    wedged process ignores is not a timeout. The profile carries both a grace
 *    period and a hard kill, and `terminationPlan` produces the two-step
 *    sequence rather than leaving it to each call site.
 *
 * Pure: profiles, validation, and planning only. Execution belongs to the
 * caller, which is what keeps this testable without spawning anything.
 */

export const SANDBOX_PROFILES = ["reproducer", "proposed_fix", "trusted"] as const;
export type SandboxProfileName = (typeof SANDBOX_PROFILES)[number];

export type NetworkMode = "none" | "allowlist" | "unrestricted";

export type NetworkPolicy = {
	mode: NetworkMode;
	/** Hosts reachable under `allowlist`. Exact or leading-dot suffix match. */
	allowed_hosts: string[];
	/** Loopback is separable: many test harnesses need it and nothing else. */
	allow_loopback: boolean;
};

export type ResourceLimits = {
	/** Wall-clock ceiling before the grace signal. */
	wall_clock_ms: number;
	/** Total CPU seconds. Distinct from wall clock: a spin loop shows here. */
	cpu_seconds: number;
	memory_bytes: number;
	/** Bytes the process may write, across all files. */
	disk_write_bytes: number;
	/** Ceiling on child processes, so a fork bomb is bounded. */
	max_processes: number;
	/** Ceiling on open file descriptors. */
	max_open_files: number;
	/** Bytes of stdout+stderr retained; beyond this, output is truncated. */
	max_output_bytes: number;
};

export type FilesystemPolicy = {
	/** Absolute or workspace-relative paths that may be written. */
	writable_paths: string[];
	/** Paths that must never be read, regardless of anything else. */
	denied_paths: string[];
	/** Whether the workspace itself is writable. */
	workspace_writable: boolean;
};

export type SandboxProfile = {
	name: SandboxProfileName;
	network: NetworkPolicy;
	limits: ResourceLimits;
	filesystem: FilesystemPolicy;
	/** Environment variables passed through. Everything else is stripped. */
	env_allowlist: string[];
	/** Grace period between the terminate signal and the hard kill. */
	kill_grace_ms: number;
};

/**
 * Paths denied in every profile, including `trusted`.
 *
 * These are not a resource concern; they are the credentials that would let a
 * sandboxed process stop being sandboxed. `trusted` relaxes limits, never this.
 */
export const ALWAYS_DENIED_PATHS = [
	"~/.ssh",
	"~/.aws",
	"~/.config/gcloud",
	"~/.kube",
	"~/.docker/config.json",
	"~/.netrc",
	"~/.npmrc",
	"~/.gnupg",
	"/etc/shadow",
	"/proc/self/environ",
];

/** Environment variables a build or test genuinely needs. */
const BASE_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "TERM"];

export const PROFILES: Record<SandboxProfileName, SandboxProfile> = {
	/**
	 * A reproducer runs code already in the repository. It still gets no
	 * network: a repro whose outcome depends on a remote service is not
	 * evidence about the code under test.
	 */
	reproducer: {
		name: "reproducer",
		network: { mode: "none", allowed_hosts: [], allow_loopback: true },
		limits: {
			wall_clock_ms: 120_000,
			cpu_seconds: 120,
			memory_bytes: 2 * 1024 ** 3,
			disk_write_bytes: 512 * 1024 ** 2,
			max_processes: 64,
			max_open_files: 1024,
			max_output_bytes: 4 * 1024 ** 2,
		},
		filesystem: {
			writable_paths: ["${workspace}", "${tmpdir}"],
			denied_paths: [...ALWAYS_DENIED_PATHS],
			workspace_writable: true,
		},
		env_allowlist: [...BASE_ENV_ALLOWLIST, "CI", "PYTHONPATH", "NODE_ENV"],
		kill_grace_ms: 5_000,
	},

	/**
	 * A proposed fix is code an agent wrote. Tighter on every axis than the
	 * reproducer, including no loopback: a fix that opens a listening socket is
	 * doing something the repair was not asked to do.
	 */
	proposed_fix: {
		name: "proposed_fix",
		network: { mode: "none", allowed_hosts: [], allow_loopback: false },
		limits: {
			wall_clock_ms: 60_000,
			cpu_seconds: 60,
			memory_bytes: 1024 ** 3,
			disk_write_bytes: 128 * 1024 ** 2,
			max_processes: 16,
			max_open_files: 256,
			max_output_bytes: 1024 ** 2,
		},
		filesystem: {
			writable_paths: ["${tmpdir}"],
			denied_paths: [...ALWAYS_DENIED_PATHS],
			// The fix is *applied* by Failsafe, not by the sandboxed process.
			workspace_writable: false,
		},
		env_allowlist: [...BASE_ENV_ALLOWLIST],
		kill_grace_ms: 3_000,
	},

	/** Explicitly-granted, still not unlimited, and still denies credentials. */
	trusted: {
		name: "trusted",
		network: { mode: "allowlist", allowed_hosts: [], allow_loopback: true },
		limits: {
			wall_clock_ms: 600_000,
			cpu_seconds: 600,
			memory_bytes: 8 * 1024 ** 3,
			disk_write_bytes: 4 * 1024 ** 3,
			max_processes: 256,
			max_open_files: 4096,
			max_output_bytes: 16 * 1024 ** 2,
		},
		filesystem: {
			writable_paths: ["${workspace}", "${tmpdir}"],
			denied_paths: [...ALWAYS_DENIED_PATHS],
			workspace_writable: true,
		},
		env_allowlist: [...BASE_ENV_ALLOWLIST, "CI", "PYTHONPATH", "NODE_ENV", "GOPATH", "CARGO_HOME"],
		kill_grace_ms: 10_000,
	},
};

/** Does `host` fall inside the allowlist? */
export function hostAllowed(host: string, policy: NetworkPolicy): boolean {
	if (policy.mode === "unrestricted") return true;
	const lower = host.toLowerCase();
	const loopback = lower === "localhost" || lower === "127.0.0.1" || lower === "::1";
	if (loopback) return policy.allow_loopback;
	if (policy.mode === "none") return false;
	return policy.allowed_hosts.some((allowed) => {
		const a = allowed.toLowerCase();
		// A leading dot means "this domain and its subdomains"; a bare host is
		// exact. Suffix-matching a bare host would make `evil-example.com`
		// match an allowlist entry of `example.com`.
		return a.startsWith(".") ? lower === a.slice(1) || lower.endsWith(a) : lower === a;
	});
}

export type NetworkAttempt = { host: string; port?: number; allowed: boolean };

/**
 * Evaluate observed connection attempts.
 *
 * Denied attempts are *returned*, not just counted: a repro that quietly needs
 * `pypi.org` is a finding about the test, and a run that was "successful"
 * because a request failed fast is not the same as one that never made it.
 */
export function evaluateNetwork(
	attempts: Array<{ host: string; port?: number }>,
	policy: NetworkPolicy,
): { results: NetworkAttempt[]; denied: NetworkAttempt[]; distinct_denied_hosts: string[] } {
	const results = attempts.map((a) => ({ ...a, allowed: hostAllowed(a.host, policy) }));
	const denied = results.filter((r) => !r.allowed);
	return {
		results,
		denied,
		distinct_denied_hosts: [...new Set(denied.map((d) => d.host.toLowerCase()))].sort(),
	};
}

export type LimitName = keyof ResourceLimits;

export type EnforcementStatus = {
	limit: LimitName;
	enforceable: boolean;
	mechanism: string;
	/** What goes wrong when this limit cannot be applied. */
	gap?: string;
};

export type PlatformCapabilities = {
	/** POSIX `setrlimit` is available (address space, files, processes, CPU). */
	rlimits: boolean;
	/** A cgroup or job object can bound memory and disk. */
	cgroups: boolean;
	/** Network can actually be isolated (namespace, sandbox profile, proxy). */
	network_isolation: boolean;
};

/**
 * Conservative default: assume nothing beyond what a plain process gives us.
 *
 * Defaulting to "everything is enforceable" would make every report claim a
 * containment the process does not have, which is precisely the lie a sandbox
 * must not tell.
 */
export const MINIMAL_CAPABILITIES: PlatformCapabilities = {
	rlimits: false,
	cgroups: false,
	network_isolation: false,
};

/**
 * Which limits this platform can actually apply.
 *
 * Wall clock and output size are always enforceable because they are the
 * supervisor's own responsibility — a timer and a byte counter in the parent
 * process — and require nothing from the OS.
 */
export function describeEnforcement(
	profile: SandboxProfile,
	capabilities: PlatformCapabilities = MINIMAL_CAPABILITIES,
): EnforcementStatus[] {
	const statuses: EnforcementStatus[] = [
		{
			limit: "wall_clock_ms",
			enforceable: true,
			mechanism: "supervisor timer with terminate-then-kill",
		},
		{
			limit: "max_output_bytes",
			enforceable: true,
			mechanism: "supervisor byte counter on the output pipes",
		},
		{
			limit: "cpu_seconds",
			enforceable: capabilities.rlimits,
			mechanism: "RLIMIT_CPU",
			...(capabilities.rlimits
				? {}
				: { gap: "a process spinning without allocating runs until the wall clock expires" }),
		},
		{
			limit: "max_processes",
			enforceable: capabilities.rlimits,
			mechanism: "RLIMIT_NPROC",
			...(capabilities.rlimits ? {} : { gap: "a fork bomb is bounded only by the wall clock" }),
		},
		{
			limit: "max_open_files",
			enforceable: capabilities.rlimits,
			mechanism: "RLIMIT_NOFILE",
			...(capabilities.rlimits ? {} : { gap: "descriptor exhaustion can affect the host" }),
		},
		{
			limit: "memory_bytes",
			enforceable: capabilities.rlimits || capabilities.cgroups,
			mechanism: capabilities.cgroups ? "cgroup memory.max" : "RLIMIT_AS",
			...(capabilities.rlimits || capabilities.cgroups
				? {}
				: { gap: "an allocation loop can exhaust host memory before the wall clock expires" }),
		},
		{
			limit: "disk_write_bytes",
			enforceable: capabilities.cgroups,
			mechanism: "cgroup io.max on a dedicated writable mount",
			...(capabilities.cgroups
				? {}
				: { gap: "a runaway write can fill the host filesystem; only the path allowlist applies" }),
		},
	];
	return statuses;
}

export type SandboxReadiness = {
	profile: SandboxProfileName;
	/** Every declared limit is actually applicable. */
	fully_enforced: boolean;
	unenforceable: EnforcementStatus[];
	/** Network cannot be isolated: the strongest single reason to refuse. */
	network_enforceable: boolean;
	warnings: string[];
};

/**
 * Report what the sandbox will and will not actually contain.
 *
 * Deliberately returns a report rather than throwing. Refusing to run at all on
 * a machine without cgroups would make the tool unusable on a laptop; running
 * while claiming containment that does not exist would be dishonest. Saying
 * exactly which walls are missing lets the caller decide.
 */
export function assessReadiness(
	profile: SandboxProfile,
	capabilities: PlatformCapabilities = MINIMAL_CAPABILITIES,
): SandboxReadiness {
	const statuses = describeEnforcement(profile, capabilities);
	const unenforceable = statuses.filter((s) => !s.enforceable);
	const networkEnforceable =
		profile.network.mode === "unrestricted" || capabilities.network_isolation;

	const warnings = unenforceable.map(
		(s) => `${s.limit} is declared but not enforceable here: ${s.gap ?? "no mechanism available"}`,
	);
	if (!networkEnforceable) {
		warnings.unshift(
			`network mode '${profile.network.mode}' cannot be enforced on this platform: a reproducer may reach the network and its result would not be evidence about local code`,
		);
	}

	return {
		profile: profile.name,
		fully_enforced: unenforceable.length === 0 && networkEnforceable,
		unenforceable,
		network_enforceable: networkEnforceable,
		warnings,
	};
}

export type TerminationStep = { after_ms: number; signal: "SIGTERM" | "SIGKILL"; reason: string };

/**
 * The two-step termination sequence.
 *
 * A single soft signal is not a timeout, because a wedged process is precisely
 * the kind that ignores one. The grace period exists so a well-behaved process
 * can flush its output — which is often the evidence being collected — and the
 * hard kill exists because a badly behaved one will not.
 */
export function terminationPlan(profile: SandboxProfile): TerminationStep[] {
	return [
		{
			after_ms: profile.limits.wall_clock_ms,
			signal: "SIGTERM",
			reason: `wall-clock limit of ${profile.limits.wall_clock_ms}ms reached; allowing ${profile.kill_grace_ms}ms to flush output`,
		},
		{
			after_ms: profile.limits.wall_clock_ms + profile.kill_grace_ms,
			signal: "SIGKILL",
			reason: "grace period elapsed without exit",
		},
	];
}

/**
 * Filter an environment down to the profile's allowlist.
 *
 * Allowlist rather than denylist: the set of variables carrying credentials is
 * open-ended and grows with every tool a team adopts, while the set a test
 * needs is small and known.
 */
export function filterEnvironment(
	env: Record<string, string | undefined>,
	profile: SandboxProfile,
): { env: Record<string, string>; stripped: string[] } {
	const allowed = new Set(profile.env_allowlist);
	const out: Record<string, string> = {};
	const stripped: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (allowed.has(key)) out[key] = value;
		else stripped.push(key);
	}
	return { env: out, stripped: stripped.sort() };
}

/** Is `path` writable under the profile, after `${workspace}`/`${tmpdir}` expansion? */
export function pathWritable(
	path: string,
	profile: SandboxProfile,
	roots: { workspace: string; tmpdir: string },
): boolean {
	const normalized = path.replace(/\/+$/, "");
	for (const denied of profile.filesystem.denied_paths) {
		const expanded = expand(denied, roots);
		if (normalized === expanded || normalized.startsWith(`${expanded}/`)) return false;
	}
	for (const writable of profile.filesystem.writable_paths) {
		const expanded = expand(writable, roots);
		if (expanded === roots.workspace && !profile.filesystem.workspace_writable) continue;
		if (normalized === expanded || normalized.startsWith(`${expanded}/`)) return true;
	}
	return false;
}

function expand(template: string, roots: { workspace: string; tmpdir: string }): string {
	return template
		.replace("${workspace}", roots.workspace)
		.replace("${tmpdir}", roots.tmpdir)
		.replace(/^~/, process.env.HOME ?? "~")
		.replace(/\/+$/, "");
}

/** Ordering used to assert profiles do not drift apart. Lower is tighter. */
export const PROFILE_TIGHTNESS: Record<SandboxProfileName, number> = {
	proposed_fix: 0,
	reproducer: 1,
	trusted: 2,
};
