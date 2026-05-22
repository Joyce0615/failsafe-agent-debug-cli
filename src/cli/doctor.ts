import { existsSync } from "node:fs";
import type { Command } from "commander";
import { DEFAULT_CONFIG, resolveConfigPaths } from "../types/config.js";
import { outputResult, resolveOutputOptions } from "./format.js";
import { loadConfig } from "./shared.js";

type Check = {
	name: string;
	status: "ok" | "missing" | "error";
	version?: string;
	message?: string;
	install?: string;
};

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Check system setup and dependencies")
		.option("--format <format>", "Output format: json or text")
		.option("--max-bytes <bytes>", "Cap output to this many bytes")
		.action(async (opts) => {
			const config = loadConfig();
			const outOpts = resolveOutputOptions(
				opts,
				config.default_format,
				config.token_budget.max_output_bytes,
			);
			const checks: Check[] = [];

			// Check Bun
			checks.push({
				name: "bun",
				status: "ok",
				version: Bun.version,
			});

			// Check Node.js
			checks.push(await checkCommand("node", ["--version"], "node"));

			// Check Python
			checks.push(await checkCommand("python3", ["--version"], "python3"));

			// Check debugpy
			checks.push(
				await checkCommand(
					"python3",
					["-c", "import debugpy; print(debugpy.__version__)"],
					"debugpy",
					"pip install debugpy",
				),
			);

			// Check git
			checks.push(await checkCommand("git", ["--version"], "git"));

			// Check .failsafe directory
			const paths = resolveConfigPaths(process.cwd(), config);
			checks.push({
				name: "failsafe_storage",
				status: existsSync(paths.storageDir) ? "ok" : "missing",
				message: existsSync(paths.storageDir)
					? paths.storageDir
					: "Run 'failsafe init' to create storage directory",
			});

			// Check config file
			checks.push({
				name: "failsafe_config",
				status: existsSync(paths.configFile) ? "ok" : "missing",
				message: existsSync(paths.configFile)
					? paths.configFile
					: "Run 'failsafe init' to create config",
			});

			const overallStatus = checks.every((c) => c.status === "ok")
				? "ok"
				: checks.some((c) => c.status === "error")
					? "error"
					: "warning";

			const result = { status: overallStatus, checks };

			outputResult(result, outOpts, () => {
				const lines = [`Failsafe Doctor: ${overallStatus.toUpperCase()}\n`];
				for (const check of checks) {
					const icon = check.status === "ok" ? "+" : check.status === "missing" ? "-" : "!";
					let line = `  [${icon}] ${check.name}: ${check.status}`;
					if (check.version) line += ` (${check.version})`;
					if (check.message) line += ` — ${check.message}`;
					if (check.install) line += `\n      Install: ${check.install}`;
					lines.push(line);
				}
				return lines.join("\n");
			});
		});
}

async function checkCommand(
	cmd: string,
	args: string[],
	name: string,
	installHint?: string,
): Promise<Check> {
	try {
		const proc = Bun.spawn([cmd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		if (exitCode === 0) {
			return {
				name,
				status: "ok",
				version: output.trim().replace(/^[^0-9]*/, ""),
			};
		}
		return {
			name,
			status: "error",
			message: `Exit code ${exitCode}`,
			install: installHint,
		};
	} catch {
		return {
			name,
			status: "missing",
			install: installHint ?? `Install ${name}`,
		};
	}
}
