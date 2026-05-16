#!/usr/bin/env bun
import { Command } from "commander";
import { registerConfigCommand, registerInitCommand } from "./config.js";
import { registerDebugCommand } from "./debug.js";
import { registerDiagnoseCommand } from "./diagnose.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerExplainCommand } from "./explain.js";
import { registerHistoryCommand } from "./history.js";
import { registerInspectCommand } from "./inspect.js";
import { registerKbCommand } from "./kb.js";
import { registerReproCommand } from "./repro.js";
import { registerResolveCommand } from "./resolve.js";
import { registerRulesCommand } from "./rules.js";
import { registerRunCommand } from "./run.js";
import { registerStepCommand } from "./step.js";
import { registerVerifyCommand } from "./verify.js";

const program = new Command()
	.name("failsafe")
	.description("Agent-first debugging CLI — failure context compressor for coding agents")
	.version("0.1.0");

// Phase 0: Core commands
registerRunCommand(program);
registerDiagnoseCommand(program);
registerInitCommand(program);
registerConfigCommand(program);
registerDoctorCommand(program);
registerHistoryCommand(program);

// Phase 1: Repro
registerReproCommand(program);

// Phase 2: Debug
registerDebugCommand(program);
registerStepCommand(program);
registerInspectCommand(program);
registerVerifyCommand(program);
registerExplainCommand(program);

// Phase 3: Tiered Rules
registerResolveCommand(program);
registerRulesCommand(program);
registerKbCommand(program);

program.parse();
